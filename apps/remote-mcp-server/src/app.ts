import { AppError, toErrorEnvelope } from "@agent-companion/shared";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
    createOAuthMetadata,
    getOAuthProtectedResourceMetadataUrl,
    mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { NextFunction, Request, Response } from "express";
import http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { loadRemoteEnv, type RemoteEnv } from "./env.js";
import { createRemoteLogger } from "./logger.js";
import { createMcpToolServer } from "./mcp-server.js";
import { RemoteOAuthProvider } from "./oauth-provider.js";
import { RelayRegistry } from "./relay-registry.js";

interface CreateRemoteMcpAppOptions {
  env?: RemoteEnv;
  relayRegistry?: RelayRegistry;
}

export function createRemoteMcpApp(options: CreateRemoteMcpAppOptions = {}) {
  const env = options.env ?? loadRemoteEnv();
  const logger = createRemoteLogger(env.LOG_LEVEL);
  const relayRegistry = options.relayRegistry ?? new RelayRegistry(env.REQUEST_TIMEOUT_MS);

  const publicBaseUrl = new URL("/", env.REMOTE_PUBLIC_BASE_URL);
  const publicMcpUrl = new URL("/mcp", publicBaseUrl);
  const oauthProvider = new RemoteOAuthProvider(env, [publicBaseUrl, publicMcpUrl]);

  const oauthMetadata = createOAuthMetadata({
    provider: oauthProvider,
    issuerUrl: publicBaseUrl,
    scopesSupported: ["mcp:tools"],
  });

  const app = createMcpExpressApp({ host: "0.0.0.0" });
  app.use((req, _res, next) => {
    logger.info(
      {
        method: req.method,
        path: req.path,
        ip: req.ip,
      },
      "incoming_request",
    );
    next();
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: publicBaseUrl,
      resourceServerUrl: publicBaseUrl,
      scopesSupported: ["mcp:tools"],
      resourceName: "agent-companion MCP server",
    }),
  );

  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
    res.json({
      resource: publicMcpUrl.href,
      authorization_servers: [oauthMetadata.issuer],
      scopes_supported: ["mcp:tools"],
      resource_name: "agent-companion MCP endpoint",
    });
  });

  app.get("/oauth/callback/google", async (req, res, next) => {
    try {
      const state = typeof req.query.state === "string" ? req.query.state : null;
      const code = typeof req.query.code === "string" ? req.query.code : null;
      if (!state || !code) {
        throw new AppError("INVALID_OAUTH_STATE", "OAuth callback is missing state or code", 400);
      }
      const redirectUrl = await oauthProvider.handleGoogleCallback(code, state);
      res.redirect(redirectUrl.toString());
    } catch (error) {
      next(error);
    }
  });

  const rootAuthMiddleware = requireBearerAuth({
    verifier: {
      verifyAccessToken: async (token) => await oauthProvider.verifyIncomingBearerToken(token),
    },
    requiredScopes: ["mcp:tools"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(publicBaseUrl),
  });

  const mcpAuthMiddleware = requireBearerAuth({
    verifier: {
      verifyAccessToken: async (token) => await oauthProvider.verifyIncomingBearerToken(token),
    },
    requiredScopes: ["mcp:tools"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(publicMcpUrl),
  });

  app.get("/health", (_req, res) => {
    logger.debug(
      {
        runnerConnected: relayRegistry.isRunnerConnected(),
        runnerId: relayRegistry.getRunnerId(),
      },
      "health_checked",
    );
    res.json({
      status: "ok",
      runnerConnected: relayRegistry.isRunnerConnected(),
      runnerId: relayRegistry.getRunnerId(),
      oauth: {
        issuer: oauthMetadata.issuer,
        protectedResourceMetadata: getOAuthProtectedResourceMetadataUrl(publicBaseUrl),
        mcpProtectedResourceMetadata: getOAuthProtectedResourceMetadataUrl(publicMcpUrl),
      },
    });
  });

  const handleMcpRequest = async (req: Request, res: Response) => {
    const auth = req.auth;
    const email = typeof auth?.extra?.email === "string" ? auth.extra.email : null;
    const subject = typeof auth?.extra?.subject === "string" ? auth.extra.subject : null;
    if (!email || !subject) {
      res.status(401).json({
        error: "invalid_token",
        error_description: "The validated access token did not resolve to an admin identity.",
      });
      return;
    }

    logger.info({ email }, "auth_success");

    const server = createMcpToolServer(relayRegistry, { email, subject });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      logger.info({ email }, "mcp_request_completed");
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
    } catch (error) {
      const envelope = toErrorEnvelope(error);
      logger.error({ error: envelope }, "mcp_request_failed");
      if (!res.headersSent) {
        res.status(error instanceof AppError ? error.statusCode : 500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: envelope.message,
            data: envelope,
          },
          id: null,
        });
      }
    }
  };

  app.post("/", rootAuthMiddleware, handleMcpRequest);
  app.post("/mcp", mcpAuthMiddleware, handleMcpRequest);

  app.all("/", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    });
  });

  app.all("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const envelope = toErrorEnvelope(error);
    logger.error({ error: envelope }, "remote_mcp_server_error");
    if (!res.headersSent) {
      res.status(error instanceof AppError ? error.statusCode : 500).json(envelope);
    }
  });

  const server = http.createServer(app);
  const runnerWs = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (requestUrl.pathname !== "/runner/connect") {
      rejectUpgrade(socket, 404, "Runner relay endpoint not found.");
      return;
    }

    const authHeader = req.headers.authorization;
    const runnerTokenHeader = getRunnerTokenHeader(req);
    if (authHeader !== `Bearer ${env.RUNNER_TOKEN}` && runnerTokenHeader !== env.RUNNER_TOKEN) {
      logger.warn(
        {
          hasAuthorizationHeader: Boolean(authHeader),
          hasRunnerTokenHeader: Boolean(runnerTokenHeader),
          runnerId: requestUrl.searchParams.get("runnerId") ?? "unknown-runner",
        },
        "runner_upgrade_rejected",
      );
      rejectUpgrade(socket, 401, "Runner relay authentication failed. Check RUNNER_TOKEN on both the remote MCP server and local runner.");
      return;
    }

    runnerWs.handleUpgrade(req, socket, head, (ws) => {
      runnerWs.emit("connection", ws, requestUrl.searchParams.get("runnerId") ?? "unknown-runner");
    });
  });

  runnerWs.on("connection", (socket, runnerId) => {
    const resolvedRunnerId = typeof runnerId === "string" ? runnerId : "unknown-runner";
    logger.info({ runnerId: resolvedRunnerId }, "runner_connected");
    relayRegistry.attachRunner(socket, resolvedRunnerId);
    socket.on("close", (code, reasonBuffer) => {
      logger.warn(
        {
          runnerId: resolvedRunnerId,
          code,
          reason: reasonBuffer.toString("utf8").trim() || null,
        },
        "runner_disconnected",
      );
    });
    socket.on("error", (error) => {
      logger.error(
        {
          runnerId: resolvedRunnerId,
          err: error,
        },
        "runner_socket_error",
      );
    });
  });

  return {
    app,
    env,
    logger,
    oauthProvider,
    relayRegistry,
    server,
  };
}

function getRunnerTokenHeader(req: http.IncomingMessage) {
  const header = req.headers["x-agent-companion-runner-token"];
  return typeof header === "string" ? header : null;
}

function rejectUpgrade(socket: Duplex, statusCode: number, message: string) {
  const statusText = http.STATUS_CODES[statusCode] ?? "Error";
  const body = JSON.stringify({
    error: message,
  });

  socket.end(
    [
      `HTTP/1.1 ${statusCode} ${statusText}`,
      "Connection: close",
      "Content-Type: application/json; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "",
      body,
    ].join("\r\n"),
  );
}
