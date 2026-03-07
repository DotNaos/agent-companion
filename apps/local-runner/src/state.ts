import {
    AppError,
    FileBackedStore,
    activityEventSchema,
    agentCompanionConfigSchema,
    approvalDecisionSchema,
    approvalRequestSchema,
    assertPathCapability,
    createProjectInputSchema,
    createTodoListInputSchema,
    findAllowedCommandRule,
    findAllowedTask,
    getExecutionLimits,
    getLogsInputSchema,
    listDirectoryInputSchema,
    listTodoItemsInputSchema,
    normalizeAbsolutePath,
    readFileInputSchema,
    relayRequestSchema,
    requiresApproval,
    resolveProjectPath,
    runCommandInputSchema,
    runRepoTaskInputSchema,
    runnerStatusSchema,
    searchFilesInputSchema,
    startDevServerInputSchema,
    stopDevServerInputSchema,
    toErrorEnvelope,
    toolInputSchemas,
    updateTodoItemInputSchema,
    writeFileInputSchema,
    type ActivityEvent,
    type AgentCompanionConfig,
    type ApprovalDecision,
    type ApprovalRequest,
    type Capability,
    type RelayRequest,
    type ToolName,
} from "@agent-companion/shared";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { RunnerEnv } from "./env.js";
import { ProcessManager } from "./process-manager.js";

const todoStoreSchema = z.object({
  version: z.literal(1).default(1),
  lists: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      items: z.array(
        z.object({
          id: z.string(),
          text: z.string(),
          completed: z.boolean(),
        }),
      ),
    }),
  ),
});

interface PendingApproval extends ApprovalRequest {
  grantKey: string;
  rememberTarget?:
    | {
        type: "path-capability";
        path: string;
        capability: Capability;
      }
    | {
        type: "command-rule";
        command: string[];
      };
}

type ApprovalWaiter = (decision: ApprovalDecision["decision"]) => void;

export class RunnerState {
  readonly events = new EventEmitter();
  readonly processManager: ProcessManager;
  readonly configStore: FileBackedStore<AgentCompanionConfig>;
  readonly todoStore: FileBackedStore<z.infer<typeof todoStoreSchema>>;
  private readonly recentActivity: ActivityEvent[] = [];
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly approvalWaiters = new Map<string, ApprovalWaiter[]>();
  private readonly approvedGrantKeys = new Set<string>();
  private connectedToRemote = false;
  private lastSeenAt: string | null = null;

  constructor(private readonly env: RunnerEnv) {
    this.configStore = new FileBackedStore(
      env.CONFIG_PATH,
      agentCompanionConfigSchema,
      () => ({
        version: 1,
        projectsRoot: null,
        mcpAccessMode: "default",
        allowedPaths: [],
        tasks: [],
        devServerTasks: [],
        runCommandRules: [],
        approvalPolicy: {
          toolApprovals: {
            write_file: true,
            start_dev_server: true,
            stop_dev_server: true,
            run_repo_task: true,
            run_command: true,
          },
          alwaysRequireApprovalForSensitiveTools: false,
        },
        auth: {
          adminEmail: env.DEFAULT_ADMIN_EMAIL,
          allowedGoogleClientIds: env.DEFAULT_GOOGLE_CLIENT_IDS
            ? env.DEFAULT_GOOGLE_CLIENT_IDS.split(",").filter(Boolean)
            : [],
          allowedOrigins: env.DEFAULT_ALLOWED_ORIGINS
            ? env.DEFAULT_ALLOWED_ORIGINS.split(",").filter(Boolean)
            : [],
        },
      }),
    );
    this.todoStore = new FileBackedStore(env.TODO_STORE_PATH, todoStoreSchema, () => ({
      version: 1,
      lists: [],
    }));
    this.processManager = new ProcessManager((entry) => {
      this.logActivity("process", entry.message, { processId: entry.processId, level: entry.level });
    });
  }

  setRelayConnection(connected: boolean) {
    this.connectedToRemote = connected;
    this.lastSeenAt = new Date().toISOString();
    this.emitStatus();
  }

  getStatus() {
    return runnerStatusSchema.parse({
      connectedToRemote: this.connectedToRemote,
      lastSeenAt: this.lastSeenAt,
      pendingApprovals: this.pendingApprovals.size,
      runningProcesses: this.processManager.countRunning(),
    });
  }

  listActivity(limit = 100) {
    return this.recentActivity.slice(-limit);
  }

  listApprovals() {
    return Array.from(this.pendingApprovals.values());
  }

  getConfig() {
    return this.configStore.read();
  }

  updateConfig(next: AgentCompanionConfig) {
    const value = this.configStore.write(agentCompanionConfigSchema.parse(next));
    this.events.emit("config", value);
    return value;
  }

  recordAuth(message: string, success: boolean, data?: Record<string, unknown>) {
    this.logActivity("auth", message, { success, ...data }, success ? "info" : "warn");
  }

  async handleRelayRequest(request: RelayRequest) {
    const parsed = relayRequestSchema.parse(request);
    const grantKey = createGrantKey(parsed.toolName, parsed.payload);
    const bypassPolicy = this.consumeApprovedGrant(grantKey);
    this.logActivity("tool_call", `Tool ${parsed.toolName} requested`, {
      toolName: parsed.toolName,
      actorEmail: parsed.actor.email,
    });

    try {
      const schema = toolInputSchemas[parsed.toolName];
      const payload = schema.parse(parsed.payload);
      let data;
      try {
        data = await this.executeTool(parsed.toolName, payload, parsed.actor.email, bypassPolicy, grantKey);
      } catch (error) {
        const shouldRetry = await this.handlePolicyError(error, parsed, grantKey);
        if (!shouldRetry) {
          throw error;
        }
        const retryBypass = this.consumeApprovedGrant(grantKey);
        data = await this.executeTool(parsed.toolName, payload, parsed.actor.email, retryBypass, grantKey);
      }
      return {
        ok: true,
        data,
      };
    } catch (error) {
      const envelope = toErrorEnvelope(error);
      return {
        ok: false,
        error: envelope,
      };
    }
  }

  async applyApprovalDecision(input: ApprovalDecision) {
    const decision = approvalDecisionSchema.parse(input);
    const approval = this.pendingApprovals.get(decision.id);
    if (!approval) {
      throw new AppError("APPROVAL_NOT_FOUND", "Approval request not found", 404);
    }

    this.pendingApprovals.delete(decision.id);
    approval.status = decision.decision;
    if (decision.decision === "approved") {
      this.approvedGrantKeys.add(approval.grantKey);
      if (decision.remember && approval.rememberTarget) {
        this.persistApprovalTarget(approval.rememberTarget);
      }
      this.logActivity("approval", `Approval granted for ${approval.toolName}`, { approvalId: approval.id });
    } else {
      this.logActivity("approval", `Approval denied for ${approval.toolName}`, { approvalId: approval.id }, "warn");
    }
    const waiters = this.approvalWaiters.get(decision.id) ?? [];
    for (const resolve of waiters) {
      resolve(decision.decision);
    }
    this.approvalWaiters.delete(decision.id);
    this.emitStatus();
    this.events.emit("approval", this.listApprovals());
    return approval;
  }

  shutdown() {
    for (const [approvalId, waiters] of this.approvalWaiters.entries()) {
      for (const resolve of waiters) {
        resolve("denied");
      }
      this.approvalWaiters.delete(approvalId);
    }
    this.processManager.shutdown();
  }

  logActivity(
    type: ActivityEvent["type"],
    message: string,
    data: Record<string, unknown> = {},
    level: ActivityEvent["level"] = "info",
  ) {
    const entry = activityEventSchema.parse({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      level,
      type,
      message,
      data,
    });
    this.recentActivity.push(entry);
    if (this.recentActivity.length > 500) {
      this.recentActivity.shift();
    }
    fs.mkdirSync(path.dirname(this.env.ACTIVITY_LOG_PATH), { recursive: true });
    fs.appendFileSync(this.env.ACTIVITY_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
    this.events.emit("activity", entry);
  }

  private emitStatus() {
    this.events.emit("status", this.getStatus());
  }

  private consumeApprovedGrant(grantKey: string) {
    if (!this.approvedGrantKeys.has(grantKey)) {
      return false;
    }
    this.approvedGrantKeys.delete(grantKey);
    return true;
  }

  private persistApprovalTarget(target: NonNullable<PendingApproval["rememberTarget"]>) {
    if (target.type === "path-capability") {
      this.configStore.update((current) => {
        const normalizedPath = normalizeAbsolutePath(target.path);
        const existing = current.allowedPaths.find((entry) => entry.path === normalizedPath);
        if (existing) {
          existing.enabled = true;
          existing.label ||= path.basename(normalizedPath) || normalizedPath;
          return current;
        }
        current.allowedPaths.push({
          id: randomUUID(),
          label: path.basename(normalizedPath) || normalizedPath,
          path: normalizedPath,
          kind: "manual",
          enabled: true,
          capabilities: {
            read: false,
            write: false,
            search: false,
            list: false,
            "execute-tasks": false,
            "run-command": false,
          },
        });
        return current;
      });
    }

    if (target.type === "command-rule") {
      this.configStore.update((current) => {
        const exists = current.runCommandRules.some(
          (rule) =>
            rule.command.length === target.command.length &&
            rule.command.every((part, index) => part === target.command[index]),
        );
        if (!exists) {
          current.runCommandRules.push({
            id: randomUUID(),
            label: `Approved ${target.command.join(" ")}`,
            command: target.command,
            matchMode: "exact",
            approvalRequired: false,
          });
        }
        return current;
      });
    }
  }

  private async executeTool(
    toolName: ToolName,
    payload: unknown,
    actorEmail: string,
    bypassPolicy: boolean,
    grantKey: string,
  ) {
    const config = this.getConfig();

    switch (toolName) {
      case "health_check":
        return { status: "ok" as const, timestamp: new Date().toISOString() };

      case "list_projects": {
        if (!config.projectsRoot) {
          return { projectsRoot: null, projects: [] };
        }
        const projects = fs
          .readdirSync(config.projectsRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => ({
            name: entry.name,
            path: path.join(config.projectsRoot!, entry.name),
          }));
        return { projectsRoot: config.projectsRoot, projects };
      }

      case "create_project": {
        const input = createProjectInputSchema.parse(payload);
        await this.ensureApprovalIfNeeded(toolName, actorEmail, payload, bypassPolicy, grantKey);
        const targetPath = resolveProjectPath(config, input.name);
        fs.mkdirSync(targetPath, { recursive: false });
        this.logActivity("status", `Project created at ${targetPath}`, { path: targetPath });
        return { created: true, path: targetPath };
      }

      case "list_directory": {
        const input = listDirectoryInputSchema.parse(payload);
        if (!bypassPolicy) {
          assertPathCapability(config, input.path, "list");
        }
        const entries = fs.readdirSync(input.path, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          path: path.join(input.path, entry.name),
          type: entry.isDirectory() ? "directory" as const : "file" as const,
        }));
        return { path: normalizeAbsolutePath(input.path), entries };
      }

      case "search_files": {
        const input = searchFilesInputSchema.parse(payload);
        if (!bypassPolicy) {
          assertPathCapability(config, input.path, "search");
        }
        const matches = await searchFiles(input.path, input.query, input.maxResults);
        return { matches };
      }

      case "read_file": {
        const input = readFileInputSchema.parse(payload);
        if (!bypassPolicy) {
          assertPathCapability(config, input.path, "read");
        }
        const buffer = fs.readFileSync(input.path);
        const truncated = buffer.byteLength > input.maxBytes;
        return {
          path: normalizeAbsolutePath(input.path),
          content: buffer.subarray(0, input.maxBytes).toString("utf8"),
          truncated,
        };
      }

      case "write_file": {
        const input = writeFileInputSchema.parse(payload);
        if (!bypassPolicy) {
          assertPathCapability(config, input.path, "write");
          await this.ensureApprovalIfNeeded(toolName, actorEmail, payload, bypassPolicy, grantKey);
        }
        fs.mkdirSync(path.dirname(input.path), { recursive: true });
        fs.writeFileSync(input.path, input.content, "utf8");
        this.logActivity("file_write", `File written: ${input.path}`, { path: input.path });
        return { path: normalizeAbsolutePath(input.path), bytesWritten: Buffer.byteLength(input.content, "utf8") };
      }

      case "run_repo_task": {
        const input = runRepoTaskInputSchema.parse(payload);
        if (!bypassPolicy) {
          assertPathCapability(config, input.projectPath, "execute-tasks");
          await this.ensureApprovalIfNeeded(toolName, actorEmail, payload, bypassPolicy, grantKey);
        }
        const task = findAllowedTask(config.tasks, input.taskId);
        const limits = getExecutionLimits(task);
        const result = await this.processManager.runOnce(task.command, input.projectPath, limits);
        this.logActivity("command", `Repo task ${input.taskId} executed`, {
          cwd: input.projectPath,
          command: task.command.join(" "),
          exitCode: result.exitCode,
        });
        return result;
      }

      case "start_dev_server": {
        const input = startDevServerInputSchema.parse(payload);
        if (!bypassPolicy) {
          assertPathCapability(config, input.projectPath, "execute-tasks");
          await this.ensureApprovalIfNeeded(toolName, actorEmail, payload, bypassPolicy, grantKey);
        }
        const task = findAllowedTask(config.devServerTasks, input.taskId);
        const started = this.processManager.startManaged(task.command, input.projectPath, input.taskId);
        return { processId: started.processId, taskId: input.taskId };
      }

      case "stop_dev_server": {
        const input = stopDevServerInputSchema.parse(payload);
        if (!bypassPolicy) {
          await this.ensureApprovalIfNeeded(toolName, actorEmail, payload, bypassPolicy, grantKey);
        }
        const stopped = this.processManager.stopManaged(input.processId);
        return { processId: input.processId, stopped };
      }

      case "get_logs": {
        const input = getLogsInputSchema.parse(payload);
        return { entries: this.processManager.getLogs(input.processId, input.limit) };
      }

      case "run_command": {
        const input = runCommandInputSchema.parse(payload);
        let approvedViaRule = "one-time-approval";
        if (!bypassPolicy) {
          const rule = findAllowedCommandRule(config, input.workingDirectory, input.command);
          approvedViaRule = rule.ruleId;
          if (rule.approvalRequired) {
            await this.ensureApprovalIfNeeded(toolName, actorEmail, payload, bypassPolicy, grantKey);
          }
        }
        const result = await this.processManager.runOnce(input.command, input.workingDirectory, {
          timeoutMs: this.env.DEFAULT_COMMAND_TIMEOUT_MS,
          outputLimitBytes: this.env.DEFAULT_OUTPUT_LIMIT_BYTES,
        });
        this.logActivity("command", `Command executed: ${input.command.join(" ")}`, {
          cwd: input.workingDirectory,
          rule: approvedViaRule,
        });
        return { ...result, approvedViaRule };
      }

      case "create_todo_list": {
        const input = createTodoListInputSchema.parse(payload);
        const list = {
          id: randomUUID(),
          title: input.title,
          items: input.items.map((text) => ({
            id: randomUUID(),
            text,
            completed: false,
          })),
        };
        this.todoStore.update((current) => {
          current.lists.push(list);
          return current;
        });
        return { listId: list.id, items: list.items };
      }

      case "update_todo_item": {
        const input = updateTodoItemInputSchema.parse(payload);
        this.todoStore.update((current) => {
          const list = current.lists.find((entry) => entry.id === input.listId);
          if (!list) {
            throw new AppError("TODO_LIST_NOT_FOUND", "Todo list not found", 404);
          }
          const item = list.items.find((entry) => entry.id === input.itemId);
          if (!item) {
            throw new AppError("TODO_ITEM_NOT_FOUND", "Todo item not found", 404);
          }
          if (typeof input.text === "string") {
            item.text = input.text;
          }
          if (typeof input.completed === "boolean") {
            item.completed = input.completed;
          }
          return current;
        });
        return { updated: true };
      }

      case "list_todo_items": {
        const input = listTodoItemsInputSchema.parse(payload);
        const store = this.todoStore.read();
        return {
          lists: input.listId ? store.lists.filter((entry) => entry.id === input.listId) : store.lists,
        };
      }
    }
  }

  private async ensureApprovalIfNeeded(
    toolName: ToolName,
    actorEmail: string,
    payload: unknown,
    bypassPolicy: boolean,
    grantKey: string,
  ) {
    if (bypassPolicy) {
      return;
    }
    const config = this.getConfig();
    if (!requiresApproval(config, toolName)) {
      return;
    }
    await this.requestApprovalAndWait(toolName, actorEmail, payload, grantKey, `Approval required for ${toolName}`);
  }

  private createOrReuseApproval(
    toolName: ToolName,
    actorEmail: string,
    payload: unknown,
    grantKey: string,
    summary: string,
    rememberTarget?: PendingApproval["rememberTarget"],
    escalatedFrom?: string,
  ) {
    const existing = Array.from(this.pendingApprovals.values()).find(
      (approval) => approval.grantKey === grantKey && approval.status === "pending",
    );
    if (existing) {
      return existing;
    }
    const approval = approvalRequestSchema.parse({
      id: randomUUID(),
      toolName,
      actorEmail,
      summary,
      payload,
      createdAt: new Date().toISOString(),
      status: "pending",
    }) as PendingApproval;
    approval.grantKey = grantKey;
    approval.rememberTarget = rememberTarget;
    this.pendingApprovals.set(approval.id, approval);
    this.logActivity("approval", summary, { approvalId: approval.id, toolName, actorEmail }, "warn");
    this.emitStatus();
    this.events.emit("approval", this.listApprovals());
    return approval;
  }

  private async requestApprovalAndWait(
    toolName: ToolName,
    actorEmail: string,
    payload: unknown,
    grantKey: string,
    summary: string,
    rememberTarget?: PendingApproval["rememberTarget"],
    escalatedFrom?: string,
  ) {
    const approval = this.createOrReuseApproval(
      toolName,
      actorEmail,
      payload,
      grantKey,
      summary,
      rememberTarget,
      escalatedFrom,
    );
    const decision = await this.waitForApprovalDecision(approval.id);
    if (decision !== "approved") {
      throw new AppError("APPROVAL_DENIED", `Approval denied for ${toolName}`, 403, {
        approvalId: approval.id,
        escalatedFrom,
      });
    }
    return approval;
  }

  private waitForApprovalDecision(approvalId: string) {
    return new Promise<ApprovalDecision["decision"]>((resolve) => {
      const waiters = this.approvalWaiters.get(approvalId) ?? [];
      waiters.push(resolve);
      this.approvalWaiters.set(approvalId, waiters);
    });
  }

  async handlePolicyError(error: unknown, request: RelayRequest, grantKey: string): Promise<boolean> {
    if (!(error instanceof Error)) {
      throw error;
    }

    const config = this.getConfig();
    if ("code" in error && typeof error.code === "string") {
      if (
        error.code === "APPROVAL_REQUIRED" &&
        "details" in error &&
        typeof error.details === "object" &&
        error.details !== null &&
        "approvalId" in error.details
      ) {
        return true;
      }
      if (error.code === "PATH_NOT_ALLOWED" || error.code === "CAPABILITY_DENIED") {
        const capability = inferCapabilityForTool(request.toolName);
        const requestPath = inferPathForPayload(request.payload);
        if (capability && requestPath) {
          await this.requestApprovalAndWait(
            request.toolName,
            request.actor.email,
            request.payload,
            grantKey,
            `${request.toolName} needs ${capability} access to ${requestPath}`,
            {
              type: "path-capability",
              path: requestPath,
              capability,
            },
            error.code,
          );
          return true;
        }
      }
      if (error.code === "COMMAND_NOT_ALLOWED") {
        const parsed = runCommandInputSchema.safeParse(request.payload);
        if (parsed.success) {
          await this.requestApprovalAndWait(
            "run_command",
            request.actor.email,
            request.payload,
            grantKey,
            `run_command needs approval for ${parsed.data.command.join(" ")}`,
            {
              type: "command-rule",
              command: parsed.data.command,
            },
            error.code,
          );
          return true;
        }
      }
      if (error.code === "APPROVAL_REQUIRED" && requiresApproval(config, request.toolName)) {
        await this.requestApprovalAndWait(
          request.toolName,
          request.actor.email,
          request.payload,
          grantKey,
          `Approval required for ${request.toolName}`,
          undefined,
          error.code,
        );
        return true;
      }
    }

    throw error;
  }
}

function createGrantKey(toolName: ToolName, payload: unknown) {
  return stableSerialize({ toolName, payload });
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function inferCapabilityForTool(toolName: ToolName): Capability | null {
  switch (toolName) {
    case "list_directory":
      return "list";
    case "search_files":
      return "search";
    case "read_file":
      return "read";
    case "write_file":
      return "write";
    case "run_repo_task":
    case "start_dev_server":
      return "execute-tasks";
    case "run_command":
      return "run-command";
    default:
      return null;
  }
}

function inferPathForPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const candidate =
    record.path ??
    record.projectPath ??
    record.workingDirectory;
  return typeof candidate === "string" ? candidate : null;
}

async function searchFiles(rootPath: string, query: string, maxResults: number) {
  const matches: Array<{ path: string; line: number; snippet: string }> = [];

  async function walk(currentPath: string): Promise<void> {
    if (matches.length >= maxResults) {
      return;
    }
    const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (matches.length >= maxResults) {
        return;
      }
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      const content = await fs.promises.readFile(absolutePath, "utf8").catch(() => null);
      if (content === null) {
        continue;
      }
      const lines = content.split("\n");
      for (let index = 0; index < lines.length && matches.length < maxResults; index += 1) {
        if (lines[index]?.includes(query)) {
          matches.push({
            path: absolutePath,
            line: index + 1,
            snippet: lines[index]!.trim(),
          });
        }
      }
    }
  }

  await walk(normalizeAbsolutePath(rootPath));
  return matches;
}
