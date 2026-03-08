import type { AgentCompanionConfig } from "@agent-companion/shared";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { signSession } from "./auth.js";
import type { DesktopEnv } from "./env.js";
import { createDesktopServer } from "./server.js";
import { UserStore } from "./user-store.js";

type FakeSession = {
  id: string;
  title: string | null;
  host: {
    id: string;
    type: "local";
    label: string;
  };
  status: "idle" | "listening" | "responding" | "error";
  model: string;
  createdAt: string;
  lastActivityAt: string;
  ownerClientId: string | null;
  speakerClientId: string | null;
  clients: Array<Record<string, unknown>>;
};

const tempDirs: string[] = [];

function decodeWebSocketMessage(data: string | Buffer | ArrayBuffer | Buffer[]) {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof Buffer) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(new Uint8Array(data)).toString("utf8");
}

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

  it("creates pairing codes and exchanges them for mobile access tokens", async () => {
    const { app } = createTestServer({
      allowedOrigins: ["https://admin.example.com"],
    });

    const pairingResponse = await request(app)
      .post("/api/desktop/mobile/pairing-code")
      .set("x-desktop-token", "desktop-token");

    expect(pairingResponse.status).toBe(200);
    expect(pairingResponse.body.code).toMatch(/^[A-F0-9]{8}$/);

    const exchangeResponse = await request(app)
      .post("/api/mobile/auth/exchange")
      .send({
        code: pairingResponse.body.code,
        device: {
          label: "Oli iPhone",
          platform: "iOS",
        },
      });

    expect(exchangeResponse.status).toBe(200);
    expect(exchangeResponse.body.device).toMatchObject({
      label: "Oli iPhone",
      platform: "iOS",
    });
    expect(exchangeResponse.body.accessToken).toEqual(expect.any(String));
  });

  it("serves mobile bootstrap and Pluto history for authenticated devices", async () => {
    const { app } = createTestServer({
      allowedOrigins: ["https://admin.example.com"],
    });

    const pairingResponse = await request(app)
      .post("/api/desktop/mobile/pairing-code")
      .set("x-desktop-token", "desktop-token");
    const exchangeResponse = await request(app)
      .post("/api/mobile/auth/exchange")
      .send({
        code: pairingResponse.body.code,
        device: {
          label: "Oli iPhone",
          platform: "iOS",
        },
      });
    const token = exchangeResponse.body.accessToken as string;

    const bootstrapResponse = await request(app)
      .get("/api/mobile/bootstrap")
      .set("Authorization", `Bearer ${token}`);

    expect(bootstrapResponse.status).toBe(200);
    expect(bootstrapResponse.body).toMatchObject({
      runner: {
        connectedToRemote: true,
      },
      pluto: {
        history: [
          {
            id: "message-1",
          },
        ],
      },
    });

    const historyResponse = await request(app)
      .get("/api/mobile/pluto/history")
      .set("Authorization", `Bearer ${token}`);

    expect(historyResponse.status).toBe(200);
    expect(historyResponse.body.history).toHaveLength(1);
  });

  it("creates Pluto sessions through the mobile API", async () => {
    const { app } = createTestServer({
      allowedOrigins: ["https://admin.example.com"],
    });

    const pairingResponse = await request(app)
      .post("/api/desktop/mobile/pairing-code")
      .set("x-desktop-token", "desktop-token");
    const exchangeResponse = await request(app)
      .post("/api/mobile/auth/exchange")
      .send({
        code: pairingResponse.body.code,
        device: {
          label: "Oli iPhone",
          platform: "iOS",
        },
      });
    const token = exchangeResponse.body.accessToken as string;

    const createResponse = await request(app)
      .post("/api/mobile/pluto/sessions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Phone Pluto",
        client: {
          label: "Oli iPhone",
          platform: "iOS",
          requestedRole: "speaker",
        },
      });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.session).toMatchObject({
      title: "Phone Pluto",
    });

    const listResponse = await request(app)
      .get("/api/mobile/pluto/sessions")
      .set("Authorization", `Bearer ${token}`);

    expect(listResponse.status).toBe(200);
    expect(listResponse.body.sessions).toHaveLength(1);

    const historyResponse = await request(app)
      .get(`/api/mobile/pluto/sessions/${createResponse.body.session.id}/history`)
      .set("Authorization", `Bearer ${token}`);

    expect(historyResponse.status).toBe(200);
    expect(historyResponse.body).toMatchObject({
      sessionId: createResponse.body.session.id,
      entries: [
        {
          kind: "text_input",
        },
      ],
    });
  });

  it("proxies Pluto voice session websocket traffic for desktop clients", async () => {
    const upstreamServer = http.createServer();
    const upstreamWsServer = new WebSocketServer({ noServer: true });
    const forwardedMessages: string[] = [];

    upstreamServer.on("upgrade", (req, socket, head) => {
      if (req.url !== "/internal/pluto/sessions/session-1/stream") {
        socket.destroy();
        return;
      }
      upstreamWsServer.handleUpgrade(req, socket, head, (ws) => {
        upstreamWsServer.emit("connection", ws);
      });
    });

    upstreamWsServer.on("connection", (ws) => {
      ws.send(
        JSON.stringify({
          type: "session_snapshot",
          session: {
            id: "session-1",
            title: "Proxy test",
            host: { id: "local", type: "local", label: "Mac" },
            status: "idle",
            model: "models/gemini-2.5-flash-native-audio-preview-12-2025",
            createdAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
            ownerClientId: "client-1",
            speakerClientId: "client-1",
            clients: [],
          },
        }),
      );

      ws.on("message", (data) => {
        forwardedMessages.push(decodeWebSocketMessage(data));
        ws.send(
          JSON.stringify({
            type: "input_transcription",
            text: "Hallo vom Proxy",
          }),
        );
      });
    });

    await new Promise<void>((resolve) => {
      upstreamServer.listen(0, "127.0.0.1", () => resolve());
    });

    const upstreamAddress = upstreamServer.address();
    const upstreamPort =
      typeof upstreamAddress === "object" && upstreamAddress ? upstreamAddress.port : 0;
    const { server } = createTestServer({
      allowedOrigins: ["https://admin.example.com"],
      localRunnerPort: upstreamPort,
    });

    try {
      await server.listen();
      const desktopAddress = server.server.address();
      const desktopPort =
        typeof desktopAddress === "object" && desktopAddress ? desktopAddress.port : 0;
      const received: Array<Record<string, unknown>> = [];

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${desktopPort}/api/desktop/pluto/sessions/session-1/stream?desktopToken=desktop-token`,
        );

        ws.on("message", (data) => {
          const parsed = JSON.parse(decodeWebSocketMessage(data)) as Record<string, unknown>;
          received.push(parsed);
          if (parsed.type === "session_snapshot") {
            ws.send(JSON.stringify({ type: "ping" }));
            return;
          }
          if (parsed.type === "input_transcription") {
            ws.close();
            resolve();
          }
        });

        ws.on("error", reject);
      });

      expect(received[0]).toMatchObject({ type: "session_snapshot" });
      expect(received.some((entry) => entry.type === "input_transcription")).toBe(true);
      expect(forwardedMessages).toContain(JSON.stringify({ type: "ping" }));
    } finally {
      await server.close();
      upstreamWsServer.close();
      await new Promise<void>((resolve, reject) => {
        upstreamServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("preserves upstream Pluto stream close reasons for desktop clients", async () => {
    const upstreamServer = http.createServer();
    const upstreamWsServer = new WebSocketServer({ noServer: true });

    upstreamServer.on("upgrade", (req, socket, head) => {
      if (req.url !== "/internal/pluto/sessions/session-1/stream") {
        socket.destroy();
        return;
      }
      upstreamWsServer.handleUpgrade(req, socket, head, (ws) => {
        upstreamWsServer.emit("connection", ws);
      });
    });

    upstreamWsServer.on("connection", (ws) => {
      ws.close(1011, "runner_stream_failed");
    });

    await new Promise<void>((resolve) => {
      upstreamServer.listen(0, "127.0.0.1", () => resolve());
    });

    const upstreamAddress = upstreamServer.address();
    const upstreamPort =
      typeof upstreamAddress === "object" && upstreamAddress ? upstreamAddress.port : 0;
    const { server } = createTestServer({
      allowedOrigins: ["https://admin.example.com"],
      localRunnerPort: upstreamPort,
    });

    try {
      await server.listen();
      const desktopAddress = server.server.address();
      const desktopPort =
        typeof desktopAddress === "object" && desktopAddress ? desktopAddress.port : 0;

      const closeEvent = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${desktopPort}/api/desktop/pluto/sessions/session-1/stream?desktopToken=desktop-token`,
        );

        ws.on("close", (code, reason) => {
          resolve({
            code,
            reason: reason.toString("utf8"),
          });
        });

        ws.on("error", reject);
      });

      expect(closeEvent).toEqual({
        code: 1011,
        reason: "runner_stream_failed",
      });
    } finally {
      await server.close();
      upstreamWsServer.close();
      await new Promise<void>((resolve, reject) => {
        upstreamServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("proxies Pluto voice session websocket traffic for mobile clients", async () => {
    const upstreamServer = http.createServer();
    const upstreamWsServer = new WebSocketServer({ noServer: true });
    const forwardedMessages: string[] = [];

    upstreamServer.on("upgrade", (req, socket, head) => {
      if (req.url !== "/internal/pluto/sessions/session-1/stream") {
        socket.destroy();
        return;
      }
      upstreamWsServer.handleUpgrade(req, socket, head, (ws) => {
        upstreamWsServer.emit("connection", ws);
      });
    });

    upstreamWsServer.on("connection", (ws) => {
      ws.send(
        JSON.stringify({
          type: "session_snapshot",
          session: {
            id: "session-1",
            title: "Mobile proxy test",
            host: { id: "local", type: "local", label: "Mac" },
            status: "idle",
            model: "models/gemini-2.5-flash-native-audio-preview-12-2025",
            createdAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
            ownerClientId: "client-1",
            speakerClientId: "client-1",
            clients: [],
          },
        }),
      );

      ws.on("message", (data) => {
        forwardedMessages.push(decodeWebSocketMessage(data));
        ws.send(JSON.stringify({ type: "output_transcription", turnId: 1, text: "Hallo iPhone" }));
      });
    });

    await new Promise<void>((resolve) => {
      upstreamServer.listen(0, "127.0.0.1", () => resolve());
    });

    const upstreamAddress = upstreamServer.address();
    const upstreamPort =
      typeof upstreamAddress === "object" && upstreamAddress ? upstreamAddress.port : 0;
    const { app, server } = createTestServer({
      allowedOrigins: ["https://admin.example.com"],
      localRunnerPort: upstreamPort,
    });

    try {
      const pairingResponse = await request(app)
        .post("/api/desktop/mobile/pairing-code")
        .set("x-desktop-token", "desktop-token");
      const exchangeResponse = await request(app)
        .post("/api/mobile/auth/exchange")
        .send({
          code: pairingResponse.body.code,
          device: {
            label: "Oli iPhone",
            platform: "iOS",
          },
        });
      const token = exchangeResponse.body.accessToken as string;

      await server.listen();
      const desktopAddress = server.server.address();
      const desktopPort =
        typeof desktopAddress === "object" && desktopAddress ? desktopAddress.port : 0;
      const received: Array<Record<string, unknown>> = [];

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${desktopPort}/api/mobile/pluto/sessions/session-1/stream`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        );

        ws.on("message", (data) => {
          const parsed = JSON.parse(decodeWebSocketMessage(data)) as Record<string, unknown>;
          received.push(parsed);
          if (parsed.type === "session_snapshot") {
            ws.send(JSON.stringify({ type: "ping" }));
            return;
          }
          if (parsed.type === "output_transcription") {
            ws.close();
            resolve();
          }
        });

        ws.on("error", reject);
      });

      expect(received[0]).toMatchObject({ type: "session_snapshot" });
      expect(received.some((entry) => entry.type === "output_transcription")).toBe(true);
      expect(forwardedMessages).toContain(JSON.stringify({ type: "ping" }));
    } finally {
      await server.close();
      upstreamWsServer.close();
      await new Promise<void>((resolve, reject) => {
        upstreamServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });


});

function createTestServer({
  allowedOrigins,
  localRunnerPort = 4317,
}: {
  allowedOrigins: string[];
  localRunnerPort?: number;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-companion-desktop-"));
  tempDirs.push(dir);
  const env: DesktopEnv = {
    DESKTOP_PORT: 0,
    LOCAL_RUNNER_PORT: localRunnerPort,
    LOG_LEVEL: "error",
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
    private readonly sessions: FakeSession[] = [];

    get isConnected() {
      return true;
    }

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
        plutoVoiceSessions: this.sessions,
        pluto: {
          available: false,
          muted: false,
          autoCommentaryEnabled: false,
          commentaryIntervalMs: 30000,
          model: "models/gemini-2.5-flash-native-audio-preview-12-2025",
          pending: false,
          lastError: null,
          activeMessage: null,
          history: [
            {
              id: "message-1",
              source: "system",
              delivery: "bubble",
              tone: "neutral",
              title: "Welcome",
              text: "Pluto ready on mobile.",
              createdAt: new Date().toISOString(),
              expiresAt: null,
              audioAvailable: false,
            },
          ],
        },
      };
    }

    async updateConfig() {
      return config;
    }

    async decideApproval() {
      return { ok: true };
    }

    async createPlutoVoiceSession(input: Record<string, unknown>) {
      const now = new Date().toISOString();
      const session: FakeSession = {
        id: `session-${this.sessions.length + 1}`,
        title: typeof input.title === "string" ? input.title : null,
        host: {
          id: "local",
          type: "local",
          label: "Mac",
        },
        status: "idle",
        model: "models/gemini-2.5-flash-native-audio-preview-12-2025",
        createdAt: now,
        lastActivityAt: now,
        ownerClientId: "client-1",
        speakerClientId: "client-1",
        clients: [],
      };
      this.sessions.unshift(session);
      return {
        session,
        client: {
          id: "client-1",
          label: "Oli iPhone",
          platform: "iOS",
          joinedAt: now,
          lastSeenAt: now,
          canSendAudio: true,
          canReceiveAudio: true,
          canObserve: true,
        },
      };
    }

    async attachPlutoVoiceSession(sessionId: string, input: Record<string, unknown>) {
      const session = this.sessions.find((entry) => entry.id === sessionId) ?? this.sessions[0];
      if (!session) {
        throw new Error("No fake Pluto session available for attach");
      }
      const now = new Date().toISOString();
      const client = {
        id: `client-${session.clients.length + 2}`,
        label: input.label ?? "Observer",
        platform: input.platform ?? null,
        joinedAt: now,
        lastSeenAt: now,
        canSendAudio: input.requestedRole === "speaker",
        canReceiveAudio: true,
        canObserve: true,
      };
      session.clients.push(client);
      return { session, client };
    }

    async detachPlutoVoiceSession(sessionId: string, input: Record<string, unknown>) {
      const session = this.sessions.find((entry) => entry.id === sessionId) ?? this.sessions[0];
      if (!session) {
        throw new Error("No fake Pluto session available for detach");
      }
      session.clients = session.clients.filter((entry) => entry.id !== input.clientId);
      return { session, detachedClientId: input.clientId };
    }

    async closePlutoVoiceSession(sessionId: string) {
      const index = this.sessions.findIndex((entry) => entry.id === sessionId);
      if (index >= 0) {
        this.sessions.splice(index, 1);
      }
      return { closedSessionId: sessionId };
    }

    async fetchPlutoAudio() {
      return {
        contentType: "audio/wav",
        buffer: Buffer.from("fake"),
      };
    }

    async fetchPlutoVoiceSessionHistory(sessionId: string) {
      return {
        sessionId,
        entries: [
          {
            kind: "text_input",
            id: "history-1",
            sessionId,
            createdAt: new Date().toISOString(),
            clientId: "client-1",
            text: "Hallo vom iPhone",
          },
        ],
      };
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

  return { app: server.app, env, tunnelManager, plutoOrchestrator, server };
}
