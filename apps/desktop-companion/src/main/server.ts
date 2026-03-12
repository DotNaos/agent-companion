import {
    AppError,
    agentCompanionConfigSchema,
    approvalDecisionSchema,
    mobileBootstrapOutputSchema,
    mobilePlutoHistoryOutputSchema,
    plutoVoiceSessionAttachInputSchema,
    plutoVoiceSessionCreateInputSchema,
    plutoVoiceSessionDetachInputSchema,
    toErrorEnvelope,
} from "@agent-companion/shared";
import cookieParser from "cookie-parser";
import express, { type Request, type Response } from "express";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
    createLoginUrl,
    exchangeCodeForSession,
    signSession,
    verifySession,
    writeSessionCookie,
} from "./auth.js";
import type { CursorTracker } from "./cursor-tracker.js";
import type { DesktopEnv } from "./env.js";
import { MobileAuthManager, resolveMobileAccessToken } from "./mobile-auth.js";
import type { PlutoOrchestrator } from "./pluto-orchestrator.js";
import type { RunnerBridge } from "./runner-bridge.js";

import type { TunnelManager } from "./tunnel-manager.js";
import type { UserStore } from "./user-store.js";

interface CreateDesktopServerOptions {
  env: DesktopEnv;
  cursorTracker: CursorTracker;
  runnerBridge: RunnerBridge;
  plutoOrchestrator: PlutoOrchestrator;
  tunnelManager: TunnelManager;
  userStore: UserStore;
  desktopToken: string;
}

export function createDesktopServer(options: CreateDesktopServerOptions) {
  const { env, cursorTracker, runnerBridge, plutoOrchestrator, tunnelManager, userStore, desktopToken } = options;
  const mobileAuth = new MobileAuthManager(
    env.SESSION_SECRET,
    path.join(path.dirname(env.USER_STORE_PATH), "mobile-devices.json"),
  );
  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));
  if (!env.VITE_DEV_SERVER_URL) {
    app.use("/assets", express.static(path.resolve(process.cwd(), "dist/renderer/assets")));
  }

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      tunnelRunning: tunnelManager.isRunning(),
      publicAdminUrl: getPublicUrls(env).adminUrl,
      publicMcpUrl: getPublicUrls(env).mcpUrl,
      runner: runnerBridge.getSnapshot().status,
    });
  });

  app.get("/auth/login/google", (_req, res, next) => {
    try {
      const { url, state } = createLoginUrl(env);
      res.cookie("agent_companion_oauth_state", state, {
        httpOnly: true,
        sameSite: "lax",
        secure: true,
        path: "/",
      });
      res.redirect(url);
    } catch (error) {
      next(error);
    }
  });

  app.get("/auth/callback/google", async (req, res, next) => {
    try {
      const code = typeof req.query.code === "string" ? req.query.code : null;
      const state = typeof req.query.state === "string" ? req.query.state : null;
      if (!code || !state || req.cookies.agent_companion_oauth_state !== state) {
        throw new AppError("INVALID_OAUTH_STATE", "OAuth callback state validation failed", 400);
      }
      const snapshot = runnerBridge.getSnapshot();
      const adminEmail = snapshot.config?.auth.adminEmail ?? "admin@example.com";
      const session = await exchangeCodeForSession(code, state, env, userStore, adminEmail);
      const token = await signSession(session, env.SESSION_SECRET);
      writeSessionCookie(res, token);
      res.redirect("/admin");
    } catch (error) {
      next(error);
    }
  });

  app.post("/auth/logout", (_req, res) => {
    res.clearCookie("agent_companion_session");
    res.status(204).end();
  });

  app.post("/api/mobile/auth/exchange", async (req, res, next) => {
    try {
      res.json(await mobileAuth.exchangePairingCode(req.body ?? {}));
    } catch (error) {
      next(error);
    }
  });

  app.get("/desktop", requireDesktopToken(desktopToken), renderAppShell(env, "desktop"));
  app.get("/overlay", requireDesktopToken(desktopToken), renderAppShell(env, "overlay"));
  app.get("/admin", renderAppShell(env, "admin"));
  app.get("/login", renderAppShell(env, "login"));

  app.post("/api/desktop/mobile/pairing-code", requireDesktopToken(desktopToken), (req, res) => {
    res.json(buildMobilePairingCodeResponse(req, env, mobileAuth));
  });

  app.get("/api/desktop/bootstrap", requireDesktopToken(desktopToken), (_req, res) => {
    res.json(buildBootstrap(env, runnerBridge, tunnelManager, cursorTracker));
  });
  app.get("/api/desktop/activity", requireDesktopToken(desktopToken), (_req, res) => {
    res.json({ entries: runnerBridge.getSnapshot().activity });
  });
  app.get("/api/desktop/approvals", requireDesktopToken(desktopToken), (_req, res) => {
    res.json({ approvals: runnerBridge.getSnapshot().approvals });
  });
  app.get("/api/desktop/status", requireDesktopToken(desktopToken), (_req, res) => {
    res.json(buildBootstrap(env, runnerBridge, tunnelManager, cursorTracker));
  });
  app.get("/api/desktop/pluto/audio/:messageId", requireDesktopToken(desktopToken), async (req, res, next) => {
    try {
      const messageId = Array.isArray(req.params.messageId) ? req.params.messageId[0] : req.params.messageId;
      const audio = await runnerBridge.fetchPlutoAudio(messageId);
      res.type(audio.contentType).send(audio.buffer);
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/desktop/pluto/commentary", requireDesktopToken(desktopToken), async (req, res, next) => {
    try {
      const contextHint = typeof req.body?.contextHint === "string" ? req.body.contextHint : undefined;
      res.json(await plutoOrchestrator.requestCommentary(contextHint));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/desktop/pluto/sessions", requireDesktopToken(desktopToken), async (req, res, next) => {
    try {
      const input = plutoVoiceSessionCreateInputSchema.parse(req.body ?? {});
      res.status(201).json(await runnerBridge.createPlutoVoiceSession(input));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/desktop/pluto/sessions/:sessionId/attach", requireDesktopToken(desktopToken), async (req, res, next) => {
    try {
      const input = plutoVoiceSessionAttachInputSchema.parse(req.body ?? {});
      res.json(await runnerBridge.attachPlutoVoiceSession(getRouteParam(req.params.sessionId), input));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/desktop/pluto/sessions/:sessionId/detach", requireDesktopToken(desktopToken), async (req, res, next) => {
    try {
      const input = plutoVoiceSessionDetachInputSchema.parse(req.body ?? {});
      res.json(await runnerBridge.detachPlutoVoiceSession(getRouteParam(req.params.sessionId), input));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/desktop/pluto/sessions/:sessionId/close", requireDesktopToken(desktopToken), async (req, res, next) => {
    try {
      res.json(await runnerBridge.closePlutoVoiceSession(getRouteParam(req.params.sessionId)));
    } catch (error) {
      next(error);
    }
  });
  app.put("/api/desktop/config", requireDesktopToken(desktopToken), async (req, res, next) => {
    try {
      const config = agentCompanionConfigSchema.parse(req.body);
      const updated = await runnerBridge.updateConfig(config);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/desktop/approvals/decision", requireDesktopToken(desktopToken), async (req, res, next) => {
    try {
      const decision = approvalDecisionSchema.parse(req.body);
      res.json(await runnerBridge.decideApproval(decision));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/desktop/tunnel/start", requireDesktopToken(desktopToken), (_req, res) => {
    tunnelManager.start();
    res.json(buildBootstrap(env, runnerBridge, tunnelManager, cursorTracker));
  });
  app.post("/api/desktop/tunnel/stop", requireDesktopToken(desktopToken), (_req, res) => {
    tunnelManager.stop();
    res.json(buildBootstrap(env, runnerBridge, tunnelManager, cursorTracker));
  });
  app.post("/api/desktop/runner/start", requireDesktopToken(desktopToken), (_req, res) => {
    res.status(501).json({ error: "Runner lifecycle is managed externally in this setup." });
  });
  app.post("/api/desktop/runner/stop", requireDesktopToken(desktopToken), (_req, res) => {
    res.status(501).json({ error: "Runner lifecycle is managed externally in this setup." });
  });

  app.use("/api/admin", requireAdminSession(env.SESSION_SECRET));
  app.use("/api/admin", requireAllowedOrigin(runnerBridge));
  app.get("/api/admin/bootstrap", (_req, res) => {
    res.json(buildBootstrap(env, runnerBridge, tunnelManager, cursorTracker));
  });
  app.get("/api/admin/status", (_req, res) => {
    res.json(buildBootstrap(env, runnerBridge, tunnelManager, cursorTracker));
  });
  app.get("/api/admin/activity", (_req, res) => {
    res.json({ entries: runnerBridge.getSnapshot().activity });
  });
  app.get("/api/admin/approvals", (_req, res) => {
    res.json({ approvals: runnerBridge.getSnapshot().approvals });
  });
  app.get("/api/admin/pluto/audio/:messageId", async (req, res, next) => {
    try {
      const messageId = Array.isArray(req.params.messageId) ? req.params.messageId[0] : req.params.messageId;
      const audio = await runnerBridge.fetchPlutoAudio(messageId);
      res.type(audio.contentType).send(audio.buffer);
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/admin/pluto/commentary", async (req, res, next) => {
    try {
      const contextHint = typeof req.body?.contextHint === "string" ? req.body.contextHint : undefined;
      res.json(await plutoOrchestrator.requestCommentary(contextHint));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/admin/pluto/sessions", async (req, res, next) => {
    try {
      const input = plutoVoiceSessionCreateInputSchema.parse(req.body ?? {});
      res.status(201).json(await runnerBridge.createPlutoVoiceSession(input));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/admin/pluto/sessions/:sessionId/attach", async (req, res, next) => {
    try {
      const input = plutoVoiceSessionAttachInputSchema.parse(req.body ?? {});
      res.json(await runnerBridge.attachPlutoVoiceSession(getRouteParam(req.params.sessionId), input));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/admin/pluto/sessions/:sessionId/detach", async (req, res, next) => {
    try {
      const input = plutoVoiceSessionDetachInputSchema.parse(req.body ?? {});
      res.json(await runnerBridge.detachPlutoVoiceSession(getRouteParam(req.params.sessionId), input));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/admin/pluto/sessions/:sessionId/close", async (req, res, next) => {
    try {
      res.json(await runnerBridge.closePlutoVoiceSession(getRouteParam(req.params.sessionId)));
    } catch (error) {
      next(error);
    }
  });
  app.put("/api/admin/config", async (req, res, next) => {
    try {
      const config = agentCompanionConfigSchema.parse(req.body);
      const updated = await runnerBridge.updateConfig(config);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/admin/approvals/decision", async (req, res, next) => {
    try {
      const decision = approvalDecisionSchema.parse(req.body);
      res.json(await runnerBridge.decideApproval(decision));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/admin/tunnel/start", (_req, res) => {
    tunnelManager.start();
    res.json(buildBootstrap(env, runnerBridge, tunnelManager, cursorTracker));
  });
  app.post("/api/admin/tunnel/stop", (_req, res) => {
    tunnelManager.stop();
    res.json(buildBootstrap(env, runnerBridge, tunnelManager, cursorTracker));
  });
  app.post("/api/admin/runner/start", (_req, res) => {
    res.status(501).json({ error: "Runner lifecycle is managed externally in this setup." });
  });
  app.post("/api/admin/runner/stop", (_req, res) => {
    res.status(501).json({ error: "Runner lifecycle is managed externally in this setup." });
  });

  app.post("/api/admin/mobile/pairing-code", (req, res) => {
    res.json(buildMobilePairingCodeResponse(req, env, mobileAuth));
  });

  app.use("/api/mobile", requireMobileAccess(mobileAuth));
  app.get("/api/mobile/bootstrap", (_req, res) => {
    res.json(buildMobileBootstrap(env, runnerBridge, tunnelManager));
  });
  app.get("/api/mobile/pluto/history", (_req, res) => {
    res.json(
      mobilePlutoHistoryOutputSchema.parse({
        history: runnerBridge.getSnapshot().pluto.history,
      }),
    );
  });
  app.get("/api/mobile/pluto/sessions", (_req, res) => {
    res.json({ sessions: runnerBridge.getSnapshot().plutoVoiceSessions });
  });
  app.get("/api/mobile/pluto/sessions/:sessionId/history", async (req, res, next) => {
    try {
      const limit = Number(req.query.limit ?? 200);
      res.json(await runnerBridge.fetchPlutoVoiceSessionHistory(getRouteParam(req.params.sessionId), limit));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/mobile/pluto/sessions", async (req, res, next) => {
    try {
      const input = plutoVoiceSessionCreateInputSchema.parse(req.body ?? {});
      res.status(201).json(await runnerBridge.createPlutoVoiceSession(input));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/mobile/pluto/sessions/:sessionId/attach", async (req, res, next) => {
    try {
      const input = plutoVoiceSessionAttachInputSchema.parse(req.body ?? {});
      res.json(await runnerBridge.attachPlutoVoiceSession(getRouteParam(req.params.sessionId), input));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/mobile/pluto/sessions/:sessionId/detach", async (req, res, next) => {
    try {
      const input = plutoVoiceSessionDetachInputSchema.parse(req.body ?? {});
      res.json(await runnerBridge.detachPlutoVoiceSession(getRouteParam(req.params.sessionId), input));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/mobile/pluto/sessions/:sessionId/close", async (req, res, next) => {
    try {
      res.json(await runnerBridge.closePlutoVoiceSession(getRouteParam(req.params.sessionId)));
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/mobile/pluto/audio/:messageId", async (req, res, next) => {
    try {
      const messageId = Array.isArray(req.params.messageId) ? req.params.messageId[0] : req.params.messageId;
      const audio = await runnerBridge.fetchPlutoAudio(messageId);
      res.type(audio.contentType).send(audio.buffer);
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/mobile/approvals/decision", async (req, res, next) => {
    try {
      const decision = approvalDecisionSchema.parse(req.body);
      res.json(await runnerBridge.decideApproval(decision));
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    const envelope = toErrorEnvelope(error);
    res.status(error instanceof AppError ? error.statusCode : 500).json(envelope);
  });

  const server = http.createServer(app);
  const wsServer = new WebSocketServer({ noServer: true });
  const plutoSessionProxyServer = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req, socket, head) => {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const isDesktop = requestUrl.pathname === "/api/desktop/stream";
    const isAdmin = requestUrl.pathname === "/api/admin/stream";
    const desktopSessionMatch = /^\/api\/desktop\/pluto\/sessions\/([^/]+)\/stream$/.exec(requestUrl.pathname);
    const adminSessionMatch = /^\/api\/admin\/pluto\/sessions\/([^/]+)\/stream$/.exec(requestUrl.pathname);
    const mobileSessionMatch = /^\/api\/mobile\/pluto\/sessions\/([^/]+)\/stream$/.exec(requestUrl.pathname);
    const isDesktopSession = Boolean(desktopSessionMatch);
    const isAdminSession = Boolean(adminSessionMatch);
    const isMobileSession = Boolean(mobileSessionMatch);

    if (!isDesktop && !isAdmin && !isDesktopSession && !isAdminSession && !isMobileSession) {
      socket.destroy();
      return;
    }

    try {
      if (isDesktop || isDesktopSession) {
        const token =
          requestUrl.searchParams.get("desktopToken") ?? req.headers["x-desktop-token"]?.toString();
        if (token !== desktopToken) {
          throw new AppError("UNAUTHORIZED", "Desktop token required", 401);
        }
      }
      if (isAdmin || isAdminSession) {
        ensureOriginAllowed(req, runnerBridge);
        const cookies = parseCookieHeader(req.headers.cookie);
        await verifySession(cookies.agent_companion_session, env.SESSION_SECRET);
      }
      if (isMobileSession) {
        await mobileAuth.verifyAccessToken(resolveMobileAccessToken({
          headers: req.headers,
          query: Object.fromEntries(requestUrl.searchParams.entries()),
        }));
      }
    } catch {
      socket.destroy();
      return;
    }

    if (isDesktop || isAdmin) {
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        wsServer.emit("connection", ws);
      });
      return;
    }

    const sessionId = decodeURIComponent(desktopSessionMatch?.[1] ?? adminSessionMatch?.[1] ?? mobileSessionMatch?.[1] ?? "");
    plutoSessionProxyServer.handleUpgrade(req, socket, head, (ws) => {
      plutoSessionProxyServer.emit("connection", ws, sessionId);
    });
  });

  wsServer.on("connection", (ws) => {
    ws.send(
      JSON.stringify({ type: "bootstrap", data: buildBootstrap(env, runnerBridge, tunnelManager, cursorTracker) }),
    );
    const sendSnapshot = () => {
      ws.send(
        JSON.stringify({ type: "bootstrap", data: buildBootstrap(env, runnerBridge, tunnelManager, cursorTracker) }),
      );
    };
    runnerBridge.on("snapshot", sendSnapshot);
    cursorTracker.on("status", sendSnapshot);
    tunnelManager.on("status", sendSnapshot);
    ws.on("close", () => {
      runnerBridge.off("snapshot", sendSnapshot);
      cursorTracker.off("status", sendSnapshot);
      tunnelManager.off("status", sendSnapshot);
    });
  });

  plutoSessionProxyServer.on("connection", (ws, sessionId: string) => {
    const upstreamUrl = new URL(
      `/internal/pluto/sessions/${encodeURIComponent(sessionId)}/stream`,
      `http://127.0.0.1:${env.LOCAL_RUNNER_PORT}`,
    );
    upstreamUrl.protocol = "ws:";

    const upstream = new WebSocket(upstreamUrl);
    const pendingMessages: Array<string | Buffer | ArrayBuffer | Buffer[]> = [];

    const flushPending = () => {
      while (pendingMessages.length > 0 && upstream.readyState === WebSocket.OPEN) {
        const next = pendingMessages.shift();
        if (next !== undefined) {
          upstream.send(next);
        }
      }
    };

    upstream.on("open", () => {
      flushPending();
    });

    upstream.on("message", (data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    upstream.on("error", (error) => {
      if (ws.readyState === WebSocket.OPEN) {
        const message = error instanceof Error ? error.message : "Desktop Pluto session proxy failed";
        ws.send(
          JSON.stringify({
            type: "error",
            code: "PLUTO_DESKTOP_PROXY_ERROR",
            message,
          }),
        );
        ws.close(1011, limitCloseReason(message));
      }
    });

    upstream.on("close", (code, reasonBuffer) => {
      if (ws.readyState === WebSocket.OPEN) {
        const reason = reasonBuffer.toString("utf8").trim();
        ws.close(normalizeCloseCode(code), reason ? limitCloseReason(reason) : undefined);
      }
    });

    ws.on("message", (data) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data);
        return;
      }
      pendingMessages.push(data);
    });

    ws.on("close", () => {
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close();
      }
    });
  });

  return {
    app,
    server,
    listen: async () => {
      await new Promise<void>((resolve) => {
        server.listen(env.DESKTOP_PORT, "127.0.0.1", () => resolve());
      });
    },
    close: async () => {
      wsServer.close();
      plutoSessionProxyServer.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function normalizeCloseCode(code: number) {
  if (code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 && code !== 1015) {
    return code;
  }
  return 1000;
}

function limitCloseReason(reason: string) {
  return reason.slice(0, 123);
}

function getRouteParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function buildBootstrap(
  env: DesktopEnv,
  runnerBridge: RunnerBridge,
  tunnelManager: TunnelManager,
  cursorTracker: CursorTracker,
) {
  const snapshot = runnerBridge.getSnapshot();
  const publicUrls = getPublicUrls(env);
  return {
    runner: snapshot,
    desktop: {
      runnerRunning: runnerBridge.isConnected,
      runnerLastError: null,
      tunnelRunning: tunnelManager.isRunning(),
      publicAdminUrl: publicUrls.adminUrl,
      publicMcpUrl: publicUrls.mcpUrl,
      cursor: cursorTracker.getSnapshot(),
    },
  };
}

function buildMobileBootstrap(
  env: DesktopEnv,
  runnerBridge: RunnerBridge,
  tunnelManager: TunnelManager,
) {
  const snapshot = runnerBridge.getSnapshot();
  const publicUrls = getPublicUrls(env);
  return mobileBootstrapOutputSchema.parse({
    runner: snapshot.status,
    pluto: snapshot.pluto,
    plutoVoiceSessions: snapshot.plutoVoiceSessions,
    desktop: {
      runnerRunning: runnerBridge.isConnected,
      tunnelRunning: tunnelManager.isRunning(),
      publicAdminUrl: publicUrls.adminUrl,
      publicMcpUrl: publicUrls.mcpUrl,
    },
  });
}

function buildMobilePairingCodeResponse(
  req: Request,
  env: DesktopEnv,
  mobileAuth: MobileAuthManager,
) {
  const base = mobileAuth.createPairingCode();
  const serverBaseUrls = getMobilePairingServerBaseUrls(req, env);
  const serverBaseUrl = serverBaseUrls[0] ?? null;
  const pairingUrl = buildMobilePairingUrl(base.code, serverBaseUrls);

  return {
    ...base,
    serverBaseUrl,
    serverBaseUrls,
    pairingUrl,
  };
}

function getMobilePairingServerBaseUrls(req: Request, env: DesktopEnv) {
  const publicUrls = getPublicUrls(env);
  const localCandidates = new Set<string>();
  const publicCandidates = new Set<string>();
  const requestOrigin = getRequestOrigin(req);
  const preferredPublicOrigin = toOriginOrNull(publicUrls.adminUrl);

  if (requestOrigin && !isLoopbackOrigin(requestOrigin)) {
    publicCandidates.add(requestOrigin);
  }

  const protocol = requestOrigin?.startsWith("https://") ? "https" : "http";
  const port = getRequestPort(req, protocol === "https" ? 443 : 80);
  for (const address of getLocalNetworkAddresses()) {
    const portSuffix = shouldIncludePort(protocol, port) ? `:${port}` : "";
    localCandidates.add(`${protocol}://${address}${portSuffix}`);
  }

  if (preferredPublicOrigin) {
    publicCandidates.add(preferredPublicOrigin);
  }

  return [...localCandidates, ...publicCandidates];
}

function buildMobilePairingUrl(code: string, serverBaseUrls: string[]) {
  if (serverBaseUrls.length === 0) {
    return null;
  }

  const query = new URLSearchParams();
  query.set("code", code);
  for (const server of serverBaseUrls) {
    query.append("server", server);
  }

  return `agentcompanion://pair?${query.toString()}`;
}

function getRequestOrigin(req: Request) {
  const host = req.get("host");
  if (!host) {
    return null;
  }
  const forwardedProto = req.get("x-forwarded-proto");
  const protocol = forwardedProto?.split(",")[0]?.trim() || req.protocol || "http";
  return `${protocol}://${host}`;
}

function getRequestPort(req: Request, fallback: number) {
  const host = req.get("host");
  if (!host) {
    return fallback;
  }

  if (host.startsWith("[")) {
    const end = host.lastIndexOf("]:");
    if (end >= 0) {
      return Number.parseInt(host.slice(end + 2), 10) || fallback;
    }
    return fallback;
  }

  const segments = host.split(":");
  if (segments.length >= 2) {
    return Number.parseInt(segments.at(-1) ?? "", 10) || fallback;
  }
  return fallback;
}

function shouldIncludePort(protocol: "http" | "https", port: number) {
  return (protocol === "http" && port !== 80) || (protocol === "https" && port !== 443);
}

function getLocalNetworkAddresses() {
  return Object.values(os.networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address)
    .sort((left, right) => left.localeCompare(right));
}

function toOriginOrNull(value: string | null) {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isLoopbackOrigin(value: string) {
  try {
    const { hostname } = new URL(value);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

function getPublicUrls(env: DesktopEnv) {
  let adminUrl = env.DESKTOP_PUBLIC_BASE_URL ?? null;
  let mcpUrl: string | null = null;

  try {
    const config = fs.readFileSync(resolveCloudflaredConfigPath(env), "utf8");
    const hostnames = [...config.matchAll(/^\s*- hostname:\s*(.+)\s*$/gm)].map((match) => match[1].trim());
    if (!adminUrl) {
      const adminHost = hostnames.find((hostname) => hostname.startsWith("admin."));
      if (adminHost) {
        adminUrl = `https://${adminHost}`;
      }
    }
    const mcpHost = hostnames.find((hostname) => hostname.startsWith("mcp."));
    if (mcpHost) {
      mcpUrl = `https://${mcpHost}`;
    }
  } catch {
    // Ignore config lookup errors here; the dashboard can still run without public URL hints.
  }

  return {
    adminUrl,
    mcpUrl,
  };
}

function resolveCloudflaredConfigPath(env: DesktopEnv) {
  if (fs.existsSync(env.CLOUDFLARED_CONFIG_PATH)) {
    return env.CLOUDFLARED_CONFIG_PATH;
  }
  return path.join(process.env.HOME ?? "", ".cloudflared", "config.yml");
}

function requireDesktopToken(desktopToken: string) {
  return (req: Request, _res: Response, next: express.NextFunction) => {
    const token = (req.query.desktopToken as string | undefined) ?? req.header("x-desktop-token");
    if (token !== desktopToken) {
      next(new AppError("UNAUTHORIZED", "Desktop token required", 401));
      return;
    }
    next();
  };
}

function requireAdminSession(secret: string) {
  return async (req: Request, _res: Response, next: express.NextFunction) => {
    try {
      const session = await verifySession(req.cookies.agent_companion_session, secret);
      (req as Request & { session?: unknown }).session = session;
      next();
    } catch (error) {
      next(error);
    }
  };
}

function requireMobileAccess(mobileAuth: MobileAuthManager) {
  return async (req: Request, _res: Response, next: express.NextFunction) => {
    try {
      const device = await mobileAuth.verifyAccessToken(
        resolveMobileAccessToken({
          headers: req.headers,
          query: req.query as Record<string, unknown>,
        }),
      );
      (req as Request & { mobileDevice?: unknown }).mobileDevice = device;
      next();
    } catch (error) {
      next(error);
    }
  };
}

function requireAllowedOrigin(runnerBridge: RunnerBridge) {
  return (req: Request, _res: Response, next: express.NextFunction) => {
    try {
      ensureOriginAllowed(req, runnerBridge);
      next();
    } catch (error) {
      next(error);
    }
  };
}

function ensureOriginAllowed(req: { headers: http.IncomingHttpHeaders }, runnerBridge: RunnerBridge) {
  const allowedOrigins = runnerBridge.getSnapshot().config?.auth.allowedOrigins ?? [];
  if (allowedOrigins.length === 0) {
    return;
  }
  const origin = req.headers.origin;
  if (!origin || !allowedOrigins.includes(origin)) {
    throw new AppError("ORIGIN_NOT_ALLOWED", "Origin is not allowlisted for the remote admin interface", 403);
  }
}

function renderAppShell(env: DesktopEnv, mode: "desktop" | "overlay" | "admin" | "login") {
  return (_req: Request, res: Response) => {
    const csp = [
      "default-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173",
      "script-src 'self' 'unsafe-inline' http://127.0.0.1:5173",
      "style-src 'self' 'unsafe-inline' http://127.0.0.1:5173",
      "img-src 'self' data: blob: http://127.0.0.1:5173",
      "font-src 'self' data: http://127.0.0.1:5173",
      "connect-src 'self' ws: wss: http://127.0.0.1:5173 http://127.0.0.1:4318",
      "media-src 'self' blob: data:",
      "worker-src 'self' blob:",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');
    res.setHeader("Content-Security-Policy", csp);

    if (env.VITE_DEV_SERVER_URL) {
      res.type("html").send(`<!doctype html>
<html lang="en" data-mode="${mode}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>agent-companion</title>
    <script type="module">
      import RefreshRuntime from "${env.VITE_DEV_SERVER_URL}/@react-refresh";
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script>
    <script type="module" src="${env.VITE_DEV_SERVER_URL}/@vite/client"></script>
    <script type="module" src="${env.VITE_DEV_SERVER_URL}/src/renderer/main.tsx"></script>
  </head>
  <body data-mode="${mode}">
    <div id="root"></div>
  </body>
</html>`);
      return;
    }

    const indexFile = path.resolve(process.cwd(), "dist/renderer/index.html");
    let html = fs.readFileSync(indexFile, "utf8");
    html = html.replace(/<html[^>]*>/, `<html lang="en" data-mode="${mode}">`);
    html = html.replace(/<body[^>]*>/, `<body data-mode="${mode}">`);
    res.type("html").send(html);
  };
}

function parseCookieHeader(header: string | undefined) {
  return Object.fromEntries(
    (header ?? "")
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [key, ...value] = entry.split("=");
        return [key, decodeURIComponent(value.join("="))];
      }),
  );
}
