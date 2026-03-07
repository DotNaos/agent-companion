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
    notifyPlutoInputSchema,
    plutoCommentaryInputSchema,
    plutoVoiceSessionAudioChunkSchema,
    plutoVoiceSessionAudioStreamEndInputSchema,
    plutoStateSchema,
    plutoVoiceSessionAttachInputSchema,
    plutoVoiceSessionClientSchema,
    plutoVoiceSessionCreateInputSchema,
    plutoVoiceSessionEventEnvelopeSchema,
    plutoVoiceSessionSchema,
    plutoVoiceSessionSummarySchema,
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
    type PlutoMessage,
    type PlutoVoiceSession,
    type PlutoVoiceSessionClient,
    type PlutoVoiceSessionEventEnvelope,
    type PlutoVoiceSessionStreamEvent,
    type RelayRequest,
    type ToolName,
} from "@agent-companion/shared";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { RunnerEnv } from "./env.js";
import { PlutoService } from "./pluto.js";
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

type PlutoVoiceSessionRecord = PlutoVoiceSession;

export class RunnerState {
  readonly events = new EventEmitter();
  readonly processManager: ProcessManager;
  readonly configStore: FileBackedStore<AgentCompanionConfig>;
  readonly todoStore: FileBackedStore<z.infer<typeof todoStoreSchema>>;
  readonly plutoService: PlutoService;
  private readonly recentActivity: ActivityEvent[] = [];
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly approvalWaiters = new Map<string, ApprovalWaiter[]>();
  private readonly approvedGrantKeys = new Set<string>();
  private activePlutoMessage: PlutoMessage | null = null;
  private readonly plutoHistory: PlutoMessage[] = [];
  private readonly plutoVoiceSessions = new Map<string, PlutoVoiceSessionRecord>();
  private plutoPending = false;
  private plutoLastError: string | null = null;
  private connectedToRemote = false;
  private lastSeenAt: string | null = null;

  constructor(private readonly env: RunnerEnv) {
    this.plutoService = new PlutoService(env);
    this.configStore = new FileBackedStore(
      env.CONFIG_PATH,
      agentCompanionConfigSchema,
      () => ({
        version: 1,
        projectsRoot: null,
        mcpAccessMode: "default",
        pluto: {
          muted: false,
          autoCommentaryEnabled: false,
          commentaryIntervalMs: 30_000,
        },
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

  getPlutoState() {
    const config = this.getConfig();
    return plutoStateSchema.parse({
      available: this.plutoService.isAvailable(),
      muted: config.pluto.muted,
      autoCommentaryEnabled: config.pluto.autoCommentaryEnabled,
      commentaryIntervalMs: config.pluto.commentaryIntervalMs,
      model: this.plutoService.getModel(),
      pending: this.plutoPending,
      lastError: this.plutoLastError,
      activeMessage: this.getVisiblePlutoMessage(),
      history: this.plutoHistory.filter((entry) => !this.isExpired(entry)).slice(0, 10),
    });
  }

  getPlutoAudio(messageId: string) {
    return this.plutoService.readAudio(messageId);
  }

  listPlutoVoiceSessions() {
    return Array.from(this.plutoVoiceSessions.values())
      .map((session) => plutoVoiceSessionSummarySchema.parse(session))
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }

  getPlutoVoiceSession(sessionId: string) {
    const session = this.plutoVoiceSessions.get(sessionId);
    if (!session) {
      throw new AppError("PLUTO_SESSION_NOT_FOUND", "Pluto voice session not found", 404);
    }
    return plutoVoiceSessionSchema.parse(session);
  }

  createPlutoVoiceSession(input: unknown) {
    const parsed = plutoVoiceSessionCreateInputSchema.parse(input);
    const now = new Date().toISOString();
    const sessionId = randomUUID();
    const session: PlutoVoiceSessionRecord = plutoVoiceSessionSchema.parse({
      id: sessionId,
      title: parsed.title ?? null,
      host: {
        id: this.env.RUNNER_ID,
        type: "local",
        label: "This Mac",
      },
      status: "idle",
      model: this.plutoService.getModel(),
      createdAt: now,
      lastActivityAt: now,
      ownerClientId: null,
      speakerClientId: null,
      clients: [],
    });

    let client: PlutoVoiceSessionClient | null = null;
    if (parsed.client) {
      client = this.attachClientToVoiceSessionRecord(session, parsed.client);
      session.ownerClientId = client.id;
    }

    this.plutoVoiceSessions.set(session.id, session);
    this.plutoService.registerVoiceSession(session.id, {
      emit: (event) => this.handlePlutoVoiceSessionEvent(session.id, event),
    });
    this.logActivity("pluto", `Pluto voice session created`, {
      sessionId: session.id,
      title: session.title,
    });
    this.emitPlutoVoiceSessions();
    return {
      session: plutoVoiceSessionSchema.parse(session),
      client,
    };
  }

  attachPlutoVoiceSession(sessionId: string, input: unknown) {
    const session = this.requirePlutoVoiceSessionRecord(sessionId);
    const parsed = plutoVoiceSessionAttachInputSchema.parse(input);
    const client = this.attachClientToVoiceSessionRecord(session, parsed);
    this.touchPlutoVoiceSession(session);
    this.emitPlutoVoiceSessions();
    return {
      session: plutoVoiceSessionSchema.parse(session),
      client,
    };
  }

  detachPlutoVoiceSession(sessionId: string, clientId: string) {
    const session = this.requirePlutoVoiceSessionRecord(sessionId);
    const nextClients = session.clients.filter((client) => client.id !== clientId);
    if (nextClients.length === session.clients.length) {
      throw new AppError("PLUTO_SESSION_CLIENT_NOT_FOUND", "Pluto voice session client not found", 404);
    }
    session.clients = nextClients;
    if (session.ownerClientId === clientId) {
      session.ownerClientId = session.clients[0]?.id ?? null;
    }
    if (session.speakerClientId === clientId) {
      session.speakerClientId = null;
      session.status = "idle";
    }
    this.touchPlutoVoiceSession(session);
    this.emitPlutoVoiceSessions();
    return {
      session: plutoVoiceSessionSchema.parse(session),
      detachedClientId: clientId,
    };
  }

  closePlutoVoiceSession(sessionId: string) {
    const session = this.requirePlutoVoiceSessionRecord(sessionId);
    this.plutoVoiceSessions.delete(sessionId);
    this.plutoService.unregisterVoiceSession(sessionId);
    this.logActivity("pluto", `Pluto voice session closed`, {
      sessionId,
      title: session.title,
    });
    this.emitPlutoVoiceSessions();
    return {
      closedSessionId: sessionId,
    };
  }

  updateConfig(next: AgentCompanionConfig) {
    const value = this.configStore.write(agentCompanionConfigSchema.parse(next));
    this.events.emit("config", value);
    this.emitPluto();
    return value;
  }

  async createPlutoCommentary(input: unknown) {
    const parsed = plutoCommentaryInputSchema.parse(input);
    const config = this.getConfig();
    if (!this.plutoService.isAvailable()) {
      throw new AppError("PLUTO_UNAVAILABLE", "Gemini is not configured for Pluto", 503);
    }

    this.setPlutoPending(true);
    try {
      const result = await this.plutoService.createAutonomousCommentary(parsed, {
        muted: config.pluto.muted,
      });
      this.publishPlutoMessage(result.message, "Autonomous Pluto commentary generated");
      return {
        messageId: result.message.id,
        text: result.message.text,
        delivery: result.message.delivery,
        audioAvailable: result.message.audioAvailable,
        usedFallback: result.usedFallback,
      };
    } catch (error) {
      this.setPlutoError(error instanceof Error ? error.message : "Pluto commentary failed");
      throw error;
    } finally {
      this.setPlutoPending(false);
    }
  }

  recordAuth(message: string, success: boolean, data?: Record<string, unknown>) {
    this.logActivity("auth", message, { success, ...data }, success ? "info" : "warn");
  }

  async sendPlutoVoiceSessionAudio(sessionId: string, input: unknown) {
    const session = this.requirePlutoVoiceSessionRecord(sessionId);
    const parsed = plutoVoiceSessionAudioChunkSchema.parse(input);
    this.requireSpeakerClient(session, parsed.clientId);
    this.touchPlutoVoiceSessionClient(session, parsed.clientId);
    session.status = "listening";
    this.touchPlutoVoiceSession(session);
    this.emitPlutoVoiceSessions();
    try {
      await this.plutoService.sendVoiceSessionAudioChunk(sessionId, parsed);
    } catch (error) {
      session.status = "error";
      this.touchPlutoVoiceSession(session);
      this.emitPlutoVoiceSessions();
      const message = error instanceof Error ? error.message : "Pluto voice session audio send failed";
      this.handlePlutoVoiceSessionEvent(sessionId, {
        type: "error",
        code: "PLUTO_VOICE_SEND_FAILED",
        message,
      });
      throw new AppError("PLUTO_VOICE_SEND_FAILED", message, 503);
    }
  }

  async endPlutoVoiceSessionAudio(sessionId: string, input: unknown) {
    const session = this.requirePlutoVoiceSessionRecord(sessionId);
    const parsed = plutoVoiceSessionAudioStreamEndInputSchema.parse(input);
    this.requireSpeakerClient(session, parsed.clientId);
    this.touchPlutoVoiceSessionClient(session, parsed.clientId);
    this.touchPlutoVoiceSession(session);
    await this.plutoService.endVoiceSessionAudio(sessionId);
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

  private emitPluto() {
    this.events.emit("pluto", this.getPlutoState());
  }

  private emitPlutoVoiceSessions() {
    this.events.emit("pluto_voice_sessions", this.listPlutoVoiceSessions());
  }

	private emitPlutoVoiceEvent(payload: PlutoVoiceSessionEventEnvelope) {
		this.events.emit("pluto_voice_event", plutoVoiceSessionEventEnvelopeSchema.parse(payload));
	}

  private setPlutoPending(next: boolean) {
    this.plutoPending = next;
    this.emitPluto();
  }

  private setPlutoError(message: string | null) {
    this.plutoLastError = message;
    this.emitPluto();
  }

  private requirePlutoVoiceSessionRecord(sessionId: string) {
    const session = this.plutoVoiceSessions.get(sessionId);
    if (!session) {
      throw new AppError("PLUTO_SESSION_NOT_FOUND", "Pluto voice session not found", 404);
    }
    return session;
  }

  private touchPlutoVoiceSession(session: PlutoVoiceSessionRecord) {
    session.lastActivityAt = new Date().toISOString();
  }

  private touchPlutoVoiceSessionClient(session: PlutoVoiceSessionRecord, clientId: string) {
    const client = session.clients.find((entry) => entry.id === clientId);
    if (!client) {
      throw new AppError("PLUTO_SESSION_CLIENT_NOT_FOUND", "Pluto voice session client not found", 404);
    }
    client.lastSeenAt = new Date().toISOString();
  }

  private requireSpeakerClient(session: PlutoVoiceSessionRecord, clientId: string) {
    const client = session.clients.find((entry) => entry.id === clientId);
    if (!client) {
      throw new AppError("PLUTO_SESSION_CLIENT_NOT_FOUND", "Pluto voice session client not found", 404);
    }
    if (session.speakerClientId !== clientId || !client.canSendAudio) {
      throw new AppError("PLUTO_SESSION_SPEAKER_REQUIRED", "Only the active speaker can send Pluto voice audio", 403);
    }
  }

  private handlePlutoVoiceSessionEvent(sessionId: string, event: PlutoVoiceSessionStreamEvent) {
    const session = this.plutoVoiceSessions.get(sessionId);
    if (session) {
      switch (event.type) {
        case "status":
          session.status = event.status;
          break;
        case "error":
          session.status = "error";
          break;
        case "closed":
          session.status = "idle";
          break;
        case "audio_chunk":
          if (session.status !== "responding") {
            session.status = "responding";
          }
          break;
      }
      this.touchPlutoVoiceSession(session);
      this.emitPlutoVoiceSessions();
    }

    this.emitPlutoVoiceEvent({
      sessionId,
      event,
    });
  }

  private attachClientToVoiceSessionRecord(
    session: PlutoVoiceSessionRecord,
    input: z.infer<typeof plutoVoiceSessionAttachInputSchema>,
  ) {
    if (input.requestedRole === "speaker" && session.speakerClientId) {
      throw new AppError(
        "PLUTO_SESSION_SPEAKER_OCCUPIED",
        "Pluto voice session already has an active speaker",
        409,
      );
    }

    const now = new Date().toISOString();
    const client = plutoVoiceSessionClientSchema.parse({
      id: randomUUID(),
      label: input.label,
      platform: input.platform ?? null,
      joinedAt: now,
      lastSeenAt: now,
      canSendAudio: input.requestedRole === "speaker",
      canReceiveAudio: input.canReceiveAudio,
      canObserve: input.canObserve,
    });
    session.clients.push(client);
    if (input.requestedRole === "speaker") {
      session.speakerClientId = client.id;
    }
    return client;
  }

  private publishPlutoMessage(message: PlutoMessage, activityMessage: string) {
    this.activePlutoMessage = message;
    this.plutoHistory.unshift(message);
    if (this.plutoHistory.length > 20) {
      this.plutoHistory.length = 20;
    }
    this.plutoLastError = null;
    this.logActivity("pluto", activityMessage, {
      messageId: message.id,
      source: message.source,
      delivery: message.delivery,
      title: message.title,
    });
    this.emitPluto();
  }

  private getVisiblePlutoMessage() {
    if (!this.activePlutoMessage) {
      return null;
    }
    return this.isExpired(this.activePlutoMessage) ? null : this.activePlutoMessage;
  }

  private isExpired(message: PlutoMessage) {
    if (!message.expiresAt) {
      return false;
    }
    return new Date(message.expiresAt).getTime() <= Date.now();
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

      case "notify_pluto": {
        const input = notifyPlutoInputSchema.parse(payload);
        const config = this.getConfig();
        this.setPlutoPending(true);
        try {
          const result = await this.plutoService.notify(input, {
            muted: config.pluto.muted,
            actorEmail,
          });
          this.publishPlutoMessage(result.message, `Pluto message queued by ${actorEmail}`);
          return {
            messageId: result.message.id,
            text: result.message.text,
            delivery: result.message.delivery,
            audioAvailable: result.message.audioAvailable,
            usedFallback: result.usedFallback,
          };
        } catch (error) {
          this.setPlutoError(error instanceof Error ? error.message : "Pluto notify failed");
          throw error;
        } finally {
          this.setPlutoPending(false);
        }
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
