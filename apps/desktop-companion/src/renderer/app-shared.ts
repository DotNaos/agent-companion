import type {
  ActivityEvent,
  AgentCompanionConfig,
  ApprovalRequest,
  PlutoMessage,
  PlutoState,
  PlutoVoiceSessionSummary,
  RunnerStatus,
} from "@agent-companion/shared";

export type Bootstrap = {
  runner: {
    status: RunnerStatus;
    config: AgentCompanionConfig | null;
    activity: ActivityEvent[];
    approvals: ApprovalRequest[];
    pluto: PlutoState;
    plutoVoiceSessions: PlutoVoiceSessionSummary[];
  };
  desktop: {
    runnerRunning: boolean;
    runnerLastError: string | null;
    tunnelRunning: boolean;
    publicAdminUrl: string | null;
    publicMcpUrl: string | null;
    cursor: {
      x: number;
      y: number;
      distance: number;
      near: boolean;
    };
  };
};

export type Mode = "desktop" | "overlay" | "admin" | "login";
export type MCPAccessMode = AgentCompanionConfig["mcpAccessMode"];
export type RunCommandMatchMode =
  AgentCompanionConfig["runCommandRules"][number]["matchMode"];

export type PlutoVoiceSelection = {
  sessionId: string | null;
  clientId: string | null;
};

export const ACCESS_MODE_OPTIONS: Array<{
  value: MCPAccessMode;
  label: string;
  description: string;
}> = [
  {
    value: "read-only",
    label: "Read only",
    description: "Can read, search and list files inside the allowed paths.",
  },
  {
    value: "default",
    label: "Default",
    description:
      "Can edit files, run tasks and execute only commands that are explicitly allowlisted.",
  },
  {
    value: "full-access",
    label: "Full access",
    description:
      "Can use all MCP features inside the allowed paths, including arbitrary commands.",
  },
];

export const PLUTO_VOICE_SELECTION_STORAGE_KEY =
  "agent-companion.pluto-voice-selection";

export function formatSessionStatus(status: PlutoVoiceSessionSummary["status"]) {
  switch (status) {
    case "idle":
      return "Idle";
    case "listening":
      return "Listening";
    case "responding":
      return "Responding";
    case "error":
      return "Error";
  }
}

export function formatRelativeTime(timestamp: string) {
  const deltaMs = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(deltaMs) || deltaMs < 0) {
    return "just now";
  }

  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 10) {
    return "just now";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatApprovalPreview(toolName: string, payload: unknown) {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const runCommandPreview = previewRunCommand(record, toolName);
    if (runCommandPreview) {
      return runCommandPreview;
    }

    const taskPreview = previewTask(record, toolName);
    if (taskPreview) {
      return taskPreview;
    }

    const pathPreview = previewPath(record);
    if (pathPreview) {
      return pathPreview;
    }
  }

  const raw = JSON.stringify(payload);
  return raw && raw !== "{}" ? raw : "Approval requested";
}

function previewRunCommand(
  record: Record<string, unknown>,
  toolName: string,
) {
  if (toolName !== "run_command") {
    return null;
  }
  const command = Array.isArray(record.command) ? record.command.join(" ") : "";
  const cwd =
    typeof record.workingDirectory === "string" ? record.workingDirectory : "";
  return `${cwd} $ ${command}`.trim();
}

function previewTask(record: Record<string, unknown>, toolName: string) {
  if (toolName !== "run_repo_task" && toolName !== "start_dev_server") {
    return null;
  }
  const cwd = typeof record.projectPath === "string" ? record.projectPath : "";
  const taskId = typeof record.taskId === "string" ? record.taskId : "";
  return `${cwd} • ${taskId}`.trim();
}

function previewPath(record: Record<string, unknown>) {
  return typeof record.path === "string" ? record.path : null;
}

export function getVisiblePlutoMessage(message: PlutoMessage | null) {
  if (!message?.expiresAt) {
    return message;
  }
  return new Date(message.expiresAt).getTime() > Date.now() ? message : null;
}

export function derivePathLabel(inputPath: string) {
  const normalized = inputPath.trim().replace(/[\\/]+$/, "");
  if (!normalized) {
    return "Manual grant";
  }
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? normalized;
}

export function readPlutoVoiceSelection(): PlutoVoiceSelection {
  if (globalThis.localStorage === undefined) {
    return {
      sessionId: null,
      clientId: null,
    };
  }

  try {
    const raw = globalThis.localStorage.getItem(
      PLUTO_VOICE_SELECTION_STORAGE_KEY,
    );
    if (!raw) {
      return {
        sessionId: null,
        clientId: null,
      };
    }
    const parsed = JSON.parse(raw) as PlutoVoiceSelection;
    return {
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
      clientId: typeof parsed.clientId === "string" ? parsed.clientId : null,
    };
  } catch {
    return {
      sessionId: null,
      clientId: null,
    };
  }
}

export function writePlutoVoiceSelection(selection: PlutoVoiceSelection) {
  if (globalThis.localStorage === undefined) {
    return;
  }

  globalThis.localStorage.setItem(
    PLUTO_VOICE_SELECTION_STORAGE_KEY,
    JSON.stringify(selection),
  );
}
