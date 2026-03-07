import path from "node:path";
import {
    DEFAULT_COMMAND_TIMEOUT_MS,
    DEFAULT_OUTPUT_LIMIT_BYTES,
    SENSITIVE_TOOLS,
} from "./constants.js";
import type {
    AgentCompanionConfig,
    AllowedPath,
    Capability,
    MCPAccessMode,
    TaskDefinition,
    ToolName,
} from "./schemas.js";

const ACCESS_MODE_CAPABILITIES: Record<MCPAccessMode, Record<Capability, boolean>> = {
  "read-only": {
    read: true,
    write: false,
    search: true,
    list: true,
    "execute-tasks": false,
    "run-command": false,
  },
  default: {
    read: true,
    write: true,
    search: true,
    list: true,
    "execute-tasks": true,
    "run-command": true,
  },
  "full-access": {
    read: true,
    write: true,
    search: true,
    list: true,
    "execute-tasks": true,
    "run-command": true,
  },
};

function capabilitiesForAccessMode(mode: MCPAccessMode): Record<Capability, boolean> {
  return { ...ACCESS_MODE_CAPABILITIES[mode] };
}

export class PolicyError extends Error {
  constructor(
    public readonly code:
      | "PATH_NOT_ALLOWED"
      | "CAPABILITY_DENIED"
      | "PROJECTS_ROOT_NOT_CONFIGURED"
      | "TASK_NOT_ALLOWED"
      | "COMMAND_NOT_ALLOWED"
      | "APPROVAL_REQUIRED",
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function normalizeAbsolutePath(inputPath: string): string {
  return path.resolve(inputPath);
}

export function isSubPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function listConfiguredRoots(config: AgentCompanionConfig): AllowedPath[] {
  const capabilities = capabilitiesForAccessMode(config.mcpAccessMode);
  const roots = [...config.allowedPaths];
  if (config.projectsRoot) {
    roots.unshift({
      id: "projects-root",
      label: "Projects root",
      path: config.projectsRoot,
      kind: "projects",
      enabled: true,
      capabilities,
    });
  }
  return roots
    .filter((entry) => entry.enabled)
    .map((entry) => ({
      ...entry,
      capabilities,
    }));
}

export function getMatchingPathEntry(
  config: AgentCompanionConfig,
  inputPath: string,
): AllowedPath | null {
  const normalized = normalizeAbsolutePath(inputPath);
  const matches = listConfiguredRoots(config).filter((entry) =>
    isSubPath(normalizeAbsolutePath(entry.path), normalized),
  );
  if (matches.length === 0) {
    return null;
  }
  return matches.sort((a, b) => b.path.length - a.path.length)[0] ?? null;
}

export function assertPathCapability(
  config: AgentCompanionConfig,
  inputPath: string,
  capability: Capability,
): AllowedPath {
  const match = getMatchingPathEntry(config, inputPath);
  if (!match) {
    throw new PolicyError("PATH_NOT_ALLOWED", `Path is outside the allowed roots: ${inputPath}`, {
      inputPath,
    });
  }
  if (!match.capabilities[capability]) {
    throw new PolicyError(
      "CAPABILITY_DENIED",
      `Capability ${capability} is not permitted for ${inputPath}`,
      { inputPath, capability, pathEntryId: match.id },
    );
  }
  return match;
}

export function resolveProjectPath(config: AgentCompanionConfig, name: string): string {
  if (!config.projectsRoot) {
    throw new PolicyError("PROJECTS_ROOT_NOT_CONFIGURED", "Projects root is not configured");
  }
  const target = normalizeAbsolutePath(path.join(config.projectsRoot, name));
  if (!isSubPath(normalizeAbsolutePath(config.projectsRoot), target)) {
    throw new PolicyError("PATH_NOT_ALLOWED", "Project path escapes the projects root", {
      name,
      target,
    });
  }
  return target;
}

export function findAllowedTask(
  tasks: TaskDefinition[],
  taskId: string,
): TaskDefinition {
  const task = tasks.find((entry) => entry.id === taskId);
  if (!task) {
    throw new PolicyError("TASK_NOT_ALLOWED", `Task ${taskId} is not allowed`);
  }
  return task;
}

export function findAllowedCommandRule(
  config: AgentCompanionConfig,
  workingDirectory: string,
  command: string[],
): { ruleId: string; approvalRequired: boolean } {
  assertPathCapability(config, workingDirectory, "run-command");
  if (config.mcpAccessMode === "full-access") {
    return { ruleId: "full-access", approvalRequired: false };
  }
  const match = config.runCommandRules.find((rule) =>
    rule.matchMode === "prefix"
      ? rule.command.every((part, index) => part === command[index])
      : rule.command.length === command.length &&
        rule.command.every((part, index) => part === command[index]),
  );
  if (!match) {
    throw new PolicyError("COMMAND_NOT_ALLOWED", "run_command is denied by default", {
      workingDirectory,
      command,
    });
  }
  return { ruleId: match.id, approvalRequired: match.approvalRequired };
}

export function requiresApproval(config: AgentCompanionConfig, toolName: ToolName): boolean {
  const explicit = config.approvalPolicy.toolApprovals[toolName];
  if (typeof explicit === "boolean") {
    return explicit;
  }
  return config.approvalPolicy.alwaysRequireApprovalForSensitiveTools && SENSITIVE_TOOLS.has(toolName);
}

export function getExecutionLimits(task: TaskDefinition) {
  return {
    timeoutMs: task.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    outputLimitBytes: task.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
  };
}
