import type { AgentCompanionConfig } from "@agent-companion/shared";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession } from "./auth.js";
import type { DesktopEnv } from "./env.js";
import { createDesktopServer } from "./server.js";
import { UserStore } from "./user-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("desktop admin server", () => {
  it("rejects unauthenticated admin requests", async () => {
    const { app } = createTestServer({
      allowedOrigins: ["https://admin.example.com"],
    });

    const response = await request(app).get("/api/admin/status");

    expect(response.status).toBe(401);
  });

  it("rejects disallowed origins even with a valid admin session", async () => {
    const { app, env } = createTestServer({
      allowedOrigins: ["https://admin.example.com"],
    });
    const session = await signSession(
      {
        email: "admin@example.com",
        subject: "subject-1",
      },
      env.SESSION_SECRET,
    );

    const response = await request(app)
      .get("/api/admin/status")
      .set("Origin", "https://evil.example.com")
      .set("Cookie", `agent_companion_session=${session}`);

    expect(response.status).toBe(403);
  });

  it("starts and stops the tunnel from the desktop API", async () => {
    const { app, tunnelManager } = createTestServer({
      allowedOrigins: ["https://admin.example.com"],
    });

    const started = await request(app)
      .post("/api/desktop/tunnel/start")
      .set("x-desktop-token", "desktop-token");

    expect(started.status).toBe(200);
    expect(tunnelManager.isRunning()).toBe(true);

    const stopped = await request(app)
      .post("/api/desktop/tunnel/stop")
      .set("x-desktop-token", "desktop-token");

    expect(stopped.status).toBe(200);
    expect(tunnelManager.isRunning()).toBe(false);
  });

  it("triggers manual Pluto commentary from the desktop API", async () => {
    const { app, plutoOrchestrator } = createTestServer({
      allowedOrigins: ["https://admin.example.com"],
    });

    const response = await request(app)
      .post("/api/desktop/pluto/commentary")
      .set("x-desktop-token", "desktop-token")
      .send({ contextHint: "Say hello" });

    expect(response.status).toBe(200);
    expect(plutoOrchestrator.requestCommentary).toHaveBeenCalledWith("Say hello");
  });


});

function createTestServer({ allowedOrigins }: { allowedOrigins: string[] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-companion-desktop-"));
  tempDirs.push(dir);
  const env: DesktopEnv = {
    DESKTOP_PORT: 4318,
    LOCAL_RUNNER_PORT: 4317,
    SESSION_SECRET: "super-secret-session-key",
    GOOGLE_OIDC_CLIENT_ID: "",
    GOOGLE_OIDC_CLIENT_SECRET: "",
    DESKTOP_PUBLIC_BASE_URL: "https://admin.example.com",
    USER_STORE_PATH: path.join(dir, "users.json"),
    CLOUDFLARED_BIN: "cloudflared",
    CLOUDFLARED_CONFIG_PATH: path.join(dir, "cloudflared.yml"),
    VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
  };

  const config = {
    version: 1 as const,
    projectsRoot: null,
    mcpAccessMode: "default",
    allowedPaths: [],
    tasks: [],
    devServerTasks: [],
    runCommandRules: [],
    approvalPolicy: {
      toolApprovals: {},
      alwaysRequireApprovalForSensitiveTools: false,
    },
    auth: {
      adminEmail: "admin@example.com",
      allowedGoogleClientIds: [],
      allowedOrigins,
    },
    pluto: {
      muted: false,
      autoCommentaryEnabled: false,
      commentaryIntervalMs: 30000,
    },
  } as AgentCompanionConfig;

  class FakeRunnerBridge extends EventEmitter {
    getSnapshot() {
      return {
        status: {
          connectedToRemote: true,
          lastSeenAt: new Date().toISOString(),
          pendingApprovals: 0,
          runningProcesses: 0,
        },
        config,
        activity: [],
        approvals: [],
          pluto: {
            available: false,
            muted: false,
            autoCommentaryEnabled: false,
            commentaryIntervalMs: 30000,
            model: "models/gemini-2.5-flash-native-audio-preview-12-2025",
            pending: false,
            lastError: null,
            activeMessage: null,
            history: [],
          },
      };
    }

    async updateConfig() {
      return config;
    }

    async decideApproval() {
      return { ok: true };
    }
  }

  class FakeTunnelManager extends EventEmitter {
    private running = false;

    isRunning() {
      return this.running;
    }

    start() {
      this.running = true;
      this.emit("status", true);
    }

    stop() {
      this.running = false;
      this.emit("status", false);
    }
  }

  class FakeCursorTracker extends EventEmitter {
    getSnapshot() {
      return {
        x: 0,
        y: 0,
        distance: 9999,
        near: false,
      };
    }
  }

  const plutoOrchestrator = {
    requestCommentary: vi.fn(async (contextHint?: string) => ({
      ok: true,
      contextHint: contextHint ?? null,
    })),
  };

  const tunnelManager = new FakeTunnelManager();
  const cursorTracker = new FakeCursorTracker();

  const server = createDesktopServer({
    env,
    cursorTracker: cursorTracker as never,
    runnerBridge: new FakeRunnerBridge() as never,
    plutoOrchestrator: plutoOrchestrator as never,
    tunnelManager: tunnelManager as never,
    userStore: new UserStore(env.USER_STORE_PATH),
    desktopToken: "desktop-token",
  });

  return { app: server.app, env, tunnelManager, plutoOrchestrator };
}
