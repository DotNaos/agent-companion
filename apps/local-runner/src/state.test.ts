import { findAllowedCommandRule, type AgentCompanionConfig } from "@agent-companion/shared";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunnerEnv } from "./env.js";
import { RunnerState } from "./state.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("RunnerState", () => {
  it("rejects path traversal outside an allowed root", async () => {
    const ctx = createContext();
    const allowedRoot = path.join(ctx.dir, "workspace");
    const secretFile = path.join(ctx.dir, "secret.txt");
    fs.mkdirSync(allowedRoot, { recursive: true });
    fs.writeFileSync(secretFile, "nope");
    ctx.setConfig({
      ...ctx.baseConfig,
      allowedPaths: [manualPath("workspace", allowedRoot, { read: true })],
    });

    const resultPromise = ctx.state.handleRelayRequest({
      requestId: "1",
      toolName: "read_file",
      payload: {
        path: path.join(allowedRoot, "..", "secret.txt"),
      },
      actor: actor(),
    });

    await waitForApprovalQueue();
    const [approval] = ctx.state.listApprovals();
    expect(approval?.summary).toContain("read");
    await ctx.state.applyApprovalDecision({ id: approval!.id, decision: "denied", remember: false });
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("APPROVAL_DENIED");
    expect(result.error?.details).toMatchObject({ escalatedFrom: "PATH_NOT_ALLOWED" });
  });

  it("blocks run_command when the command is not on the allowlist", async () => {
    const ctx = createContext();
    const workspace = path.join(ctx.dir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    ctx.setConfig({
      ...ctx.baseConfig,
      allowedPaths: [manualPath("workspace", workspace, { "run-command": true })],
      runCommandRules: [
        {
          id: "git-status",
          label: "git status",
          command: ["git", "status"],
          matchMode: "exact",
          approvalRequired: false,
        },
      ],
    });

    const resultPromise = ctx.state.handleRelayRequest({
      requestId: "1",
      toolName: "run_command",
      payload: {
        workingDirectory: workspace,
        command: ["npm", "test"],
      },
      actor: actor(),
    });

    await waitForApprovalQueue();
    const [approval] = ctx.state.listApprovals();
    await ctx.state.applyApprovalDecision({ id: approval!.id, decision: "denied", remember: false });
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("APPROVAL_DENIED");
    expect(result.error?.details).toMatchObject({ escalatedFrom: "COMMAND_NOT_ALLOWED" });
  });

  it("rejects invalid tool payloads before execution", async () => {
    const ctx = createContext();

    const result = await ctx.state.handleRelayRequest({
      requestId: "1",
      toolName: "read_file",
      payload: {},
      actor: actor(),
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_SCHEMA");
  });

  it("blocks approval-gated writes until the user approves them", async () => {
    const ctx = createContext();
    const workspace = path.join(ctx.dir, "workspace");
    const filePath = path.join(workspace, "note.txt");
    fs.mkdirSync(workspace, { recursive: true });
    ctx.setConfig({
      ...ctx.baseConfig,
      allowedPaths: [manualPath("workspace", workspace, { write: true })],
      approvalPolicy: {
        toolApprovals: {
          write_file: true,
        },
        alwaysRequireApprovalForSensitiveTools: false,
      },
    });

    const resultPromise = ctx.state.handleRelayRequest({
      requestId: "1",
      toolName: "write_file",
      payload: {
        path: filePath,
        content: "blocked",
      },
      actor: actor(),
    });

    expect(fs.existsSync(filePath)).toBe(false);
    await waitForApprovalQueue();
    expect(ctx.state.listApprovals()).toHaveLength(1);
    await ctx.state.applyApprovalDecision({ id: ctx.state.listApprovals()[0]!.id, decision: "approved", remember: false });
    const result = await resultPromise;
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(filePath, "utf8")).toBe("blocked");
  });

  it("blocks create_project attempts that try to escape the projects root", async () => {
    const ctx = createContext();
    const projectsRoot = path.join(ctx.dir, "projects");
    fs.mkdirSync(projectsRoot, { recursive: true });
    ctx.setConfig({
      ...ctx.baseConfig,
      projectsRoot,
    });

    const result = await ctx.state.handleRelayRequest({
      requestId: "1",
      toolName: "create_project",
      payload: {
        name: "../escape",
      },
      actor: actor(),
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_SCHEMA");
  });

  it("denies file access outside explicit whitelists by default", async () => {
    const ctx = createContext();
    const outside = path.join(ctx.dir, "outside.txt");
    fs.writeFileSync(outside, "secret");

    const resultPromise = ctx.state.handleRelayRequest({
      requestId: "1",
      toolName: "read_file",
      payload: {
        path: outside,
      },
      actor: actor(),
    });

    await waitForApprovalQueue();
    const [approval] = ctx.state.listApprovals();
    await ctx.state.applyApprovalDecision({ id: approval!.id, decision: "denied", remember: false });
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("APPROVAL_DENIED");
    expect(result.error?.details).toMatchObject({ escalatedFrom: "PATH_NOT_ALLOWED" });
  });

  it("enforces read-only mode for write operations", async () => {
    const ctx = createContext();
    const workspace = path.join(ctx.dir, "workspace");
    const filePath = path.join(workspace, "note.txt");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(filePath, "hello");
    ctx.setConfig({
      ...ctx.baseConfig,
      mcpAccessMode: "read-only",
      allowedPaths: [manualPath("workspace", workspace, { read: true })],
    });

    const readResult = await ctx.state.handleRelayRequest({
      requestId: "1",
      toolName: "read_file",
      payload: { path: filePath },
      actor: actor(),
    });
    const writeResultPromise = ctx.state.handleRelayRequest({
      requestId: "2",
      toolName: "write_file",
      payload: { path: filePath, content: "new" },
      actor: actor(),
    });

    await waitForApprovalQueue();
    const [approval] = ctx.state.listApprovals();
    await ctx.state.applyApprovalDecision({ id: approval!.id, decision: "denied", remember: false });
    const writeResult = await writeResultPromise;

    expect(readResult.ok).toBe(true);
    expect(writeResult.ok).toBe(false);
    expect(writeResult.error?.code).toBe("APPROVAL_DENIED");
    expect(writeResult.error?.details).toMatchObject({ escalatedFrom: "CAPABILITY_DENIED" });
  });

  it("denies run_command by default when no whitelist exists", async () => {
    const ctx = createContext();
    const workspace = path.join(ctx.dir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    ctx.setConfig({
      ...ctx.baseConfig,
      allowedPaths: [manualPath("workspace", workspace, { "run-command": true })],
      runCommandRules: [],
    });

    const resultPromise = ctx.state.handleRelayRequest({
      requestId: "1",
      toolName: "run_command",
      payload: {
        workingDirectory: workspace,
        command: ["git", "status"],
      },
      actor: actor(),
    });

    await waitForApprovalQueue();
    const [approval] = ctx.state.listApprovals();
    await ctx.state.applyApprovalDecision({ id: approval!.id, decision: "denied", remember: false });
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("APPROVAL_DENIED");
    expect(result.error?.details).toMatchObject({ escalatedFrom: "COMMAND_NOT_ALLOWED" });
  });

  it("denies run_command in read-only mode", async () => {
    const ctx = createContext();
    const workspace = path.join(ctx.dir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    ctx.setConfig({
      ...ctx.baseConfig,
      mcpAccessMode: "read-only",
      allowedPaths: [manualPath("workspace", workspace, { read: true })],
      runCommandRules: [
        {
          id: "git-status",
          label: "git status",
          command: ["git", "status"],
          matchMode: "exact",
          approvalRequired: false,
        },
      ],
    });

    const resultPromise = ctx.state.handleRelayRequest({
      requestId: "1",
      toolName: "run_command",
      payload: {
        workingDirectory: workspace,
        command: ["git", "status"],
      },
      actor: actor(),
    });

    await waitForApprovalQueue();
    const [approval] = ctx.state.listApprovals();
    await ctx.state.applyApprovalDecision({ id: approval!.id, decision: "denied", remember: false });
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("APPROVAL_DENIED");
    expect(result.error?.details).toMatchObject({ escalatedFrom: "CAPABILITY_DENIED" });
  });

  it("reads a safe file within an approved path", async () => {
    const ctx = createContext();
    const workspace = path.join(ctx.dir, "workspace");
    const filePath = path.join(workspace, "hello.txt");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(filePath, "hello world");
    ctx.setConfig({
      ...ctx.baseConfig,
      allowedPaths: [manualPath("workspace", workspace, { read: true })],
    });

    const result = await ctx.state.handleRelayRequest({
      requestId: "1",
      toolName: "read_file",
      payload: {
        path: filePath,
      },
      actor: actor(),
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      path: filePath,
      content: "hello world",
      truncated: false,
    });
  });

  it("creates a project inside the configured projects root", async () => {
    const ctx = createContext();
    const projectsRoot = path.join(ctx.dir, "projects");
    fs.mkdirSync(projectsRoot, { recursive: true });
    ctx.setConfig({
      ...ctx.baseConfig,
      projectsRoot,
    });

    const result = await ctx.state.handleRelayRequest({
      requestId: "1",
      toolName: "create_project",
      payload: {
        name: "new-project",
      },
      actor: actor(),
    });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(projectsRoot, "new-project"))).toBe(true);
  });

  it("inherits access for child paths under a manually allowed path", async () => {
    const ctx = createContext();
    const workspace = path.join(ctx.dir, "workspace");
    const childDir = path.join(workspace, "nested");
    const filePath = path.join(childDir, "child.txt");
    fs.mkdirSync(childDir, { recursive: true });
    fs.writeFileSync(filePath, "child");
    ctx.setConfig({
      ...ctx.baseConfig,
      allowedPaths: [manualPath("workspace", workspace, { read: true })],
    });

    const result = await ctx.state.handleRelayRequest({
      requestId: "1",
      toolName: "read_file",
      payload: {
        path: filePath,
      },
      actor: actor(),
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ content: "child" });
  });

  it("allows namespace-based command rules via prefix matching", async () => {
    const ctx = createContext();
    const workspace = path.join(ctx.dir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const config: AgentCompanionConfig = {
      ...ctx.baseConfig,
      allowedPaths: [manualPath("workspace", workspace, { "run-command": true })],
      approvalPolicy: {
        toolApprovals: {
          run_command: false,
        },
        alwaysRequireApprovalForSensitiveTools: false,
      },
      runCommandRules: [
        {
          id: "printf-prefix",
          label: "printf namespace",
          command: ["/usr/bin/printf"],
          matchMode: "prefix",
          approvalRequired: false,
        },
      ],
    };

    expect(
      findAllowedCommandRule(config, workspace, ["/usr/bin/printf", "hello"]),
    ).toMatchObject({ approvalRequired: false });
  });

  it("bypasses command allowlists in full-access mode", async () => {
    const ctx = createContext();
    const workspace = path.join(ctx.dir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const config: AgentCompanionConfig = {
      ...ctx.baseConfig,
      mcpAccessMode: "full-access",
      allowedPaths: [manualPath("workspace", workspace, { "run-command": true })],
      approvalPolicy: {
        toolApprovals: {
          run_command: false,
        },
        alwaysRequireApprovalForSensitiveTools: false,
      },
      runCommandRules: [],
    };

    expect(findAllowedCommandRule(config, workspace, ["/bin/pwd"])).toMatchObject({
      approvalRequired: false,
      ruleId: "full-access",
    });
  });

  it("queues a Pluto secretary message for remote agents", async () => {
    const ctx = createContext();

    const result = await ctx.state.handleRelayRequest({
      requestId: "pluto-1",
      toolName: "notify_pluto",
      payload: {
        title: "Build update",
        message: "Sag dem User bitte kurz, dass der Fix fertig ist und Tests grün sind.",
        context:
          "Der Remote Agent hat den Fehler in der Overlay-Logik behoben, die relevanten Tests ausgeführt und alles erfolgreich validiert.",
        delivery: "summarize",
        tone: "encouraging",
      },
      actor: actor(),
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      delivery: "summarize",
      audioAvailable: false,
    });
    expect(ctx.state.getPlutoState().activeMessage).toMatchObject({
      title: "Build update",
      source: "remote-agent",
    });
  });

  it("creates and lists Pluto voice sessions", () => {
    const ctx = createContext();

    const created = ctx.state.createPlutoVoiceSession({
      title: "Laptop Pluto",
      client: {
        label: "Desktop app",
        platform: "macOS",
        requestedRole: "speaker",
      },
    });

    expect(created.session).toMatchObject({
      title: "Laptop Pluto",
      status: "idle",
      host: {
        type: "local",
        label: "This Mac",
      },
    });
    expect(created.client).toMatchObject({
      label: "Desktop app",
      platform: "macOS",
      canSendAudio: true,
    });
    expect(created.session.ownerClientId).toBe(created.client?.id);
    expect(created.session.speakerClientId).toBe(created.client?.id);
    expect(ctx.state.listPlutoVoiceSessions()).toHaveLength(1);
  });

  it("attaches and detaches observer clients from Pluto voice sessions", () => {
    const ctx = createContext();
    const created = ctx.state.createPlutoVoiceSession({
      title: "Shared Pluto",
      client: {
        label: "Desktop app",
        requestedRole: "speaker",
      },
    });

    const attached = ctx.state.attachPlutoVoiceSession(created.session.id, {
      label: "iPhone",
      platform: "iOS",
      requestedRole: "observer",
    });

    expect(attached.client).toMatchObject({
      label: "iPhone",
      platform: "iOS",
      canSendAudio: false,
      canReceiveAudio: true,
    });
    expect(attached.session.clients).toHaveLength(2);
    expect(attached.session.speakerClientId).toBe(created.client?.id);

    const detached = ctx.state.detachPlutoVoiceSession(created.session.id, attached.client.id);

    expect(detached.detachedClientId).toBe(attached.client.id);
    expect(detached.session.clients).toHaveLength(1);
  });

  it("prevents multiple active speaker clients in the same Pluto voice session", () => {
    const ctx = createContext();
    const created = ctx.state.createPlutoVoiceSession({
      title: "Single mic",
      client: {
        label: "Desktop app",
        requestedRole: "speaker",
      },
    });

    expect(() =>
      ctx.state.attachPlutoVoiceSession(created.session.id, {
        label: "Watch",
        platform: "watchOS",
        requestedRole: "speaker",
      }),
    ).toThrowError(/active speaker/i);
  });

  it("closes Pluto voice sessions and removes them from the registry", () => {
    const ctx = createContext();
    const created = ctx.state.createPlutoVoiceSession({ title: "Closable Pluto" });

    const closed = ctx.state.closePlutoVoiceSession(created.session.id);

    expect(closed).toEqual({ closedSessionId: created.session.id });
    expect(ctx.state.listPlutoVoiceSessions()).toHaveLength(0);
  });
});

function createContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-companion-runner-"));
  tempDirs.push(dir);
  const env: RunnerEnv = {
    REMOTE_SERVER_URL: "http://127.0.0.1:8787",
    RUNNER_TOKEN: "runner-token",
    RUNNER_ID: "runner-1",
    GEMINI_API_KEY: "",
    PLUTO_MODEL: "models/gemini-2.5-flash-native-audio-preview-12-2025",
    PLUTO_VOICE_NAME: "Achird",
    LOCAL_RUNNER_PORT: 4317,
    DESKTOP_SERVER_PORT: 4318,
    CONFIG_PATH: path.join(dir, "config.json"),
    TODO_STORE_PATH: path.join(dir, "todos.json"),
    ACTIVITY_LOG_PATH: path.join(dir, "activity.log"),
    PLUTO_AUDIO_DIR: path.join(dir, "pluto-audio"),
    DEFAULT_ADMIN_EMAIL: "admin@example.com",
    DEFAULT_ALLOWED_ORIGINS: "https://admin.example.com",
    DEFAULT_GOOGLE_CLIENT_IDS: "client-id",
    DEFAULT_COMMAND_TIMEOUT_MS: 10_000,
    DEFAULT_OUTPUT_LIMIT_BYTES: 10_000,
  };
  const state = new RunnerState(env);
  const baseConfig = state.getConfig();
  return {
    dir,
    env,
    state,
    baseConfig,
    setConfig(config: AgentCompanionConfig) {
      state.updateConfig(config);
    },
  };
}

function actor() {
  return {
    email: "admin@example.com",
    subject: "admin-subject",
  };
}

async function waitForApprovalQueue() {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

function manualPath(
  label: string,
  targetPath: string,
  capabilities: Partial<AgentCompanionConfig["allowedPaths"][number]["capabilities"]>,
): AgentCompanionConfig["allowedPaths"][number] {
  return {
    id: `${label}-id`,
    label,
    path: targetPath,
    kind: "manual",
    enabled: true,
    capabilities: {
      read: false,
      write: false,
      search: false,
      list: false,
      "execute-tasks": false,
      "run-command": false,
      ...capabilities,
    },
  };
}
