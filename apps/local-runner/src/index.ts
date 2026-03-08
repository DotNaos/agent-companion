import { relayRequestSchema } from "@agent-companion/shared";
import type { IncomingMessage } from "node:http";
import type { RawData } from "ws";
import { WebSocket } from "ws";
import { startControlServer } from "./control-server.js";
import { loadRunnerEnv } from "./env.js";
import { logger } from "./logger.js";
import { RunnerState } from "./state.js";

const env = loadRunnerEnv();
const state = new RunnerState(env);

let relaySocket: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let lastRelayIssue: { key: string; loggedAt: number } | null = null;

const controlServer = await startControlServer(state, env.LOCAL_RUNNER_PORT);
logger.info(
  {
    port: controlServer.port,
    runnerId: env.RUNNER_ID,
  },
  "local_runner_control_server_started",
);
connectRelay();

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  logger.error({ err: error }, "local_runner_uncaught_exception");
});
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "local_runner_unhandled_rejection");
});

function decodeWebSocketMessage(data: RawData) {
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

function connectRelay() {
  const url = new URL("/runner/connect", env.REMOTE_SERVER_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("runnerId", env.RUNNER_ID);

  logger.info(
    {
      relayUrl: url.toString(),
      runnerId: env.RUNNER_ID,
    },
    "relay_connect_attempt",
  );

  relaySocket = new WebSocket(url, {
    headers: {
      authorization: `Bearer ${env.RUNNER_TOKEN}`,
      "x-agent-companion-runner-token": env.RUNNER_TOKEN,
    },
  });

  relaySocket.on("open", () => {
    clearRelayIssueDeduplication();
    state.setRelayConnection(true);
    state.logActivity("status", "Connected to remote relay", {
      relayUrl: url.toString(),
      runnerId: env.RUNNER_ID,
    });
  });

  relaySocket.on("message", async (data) => {
    try {
      const request = relayRequestSchema.parse(JSON.parse(decodeWebSocketMessage(data)));
      const result = await state.handleRelayRequest(request);
      relaySocket?.send(JSON.stringify({ requestId: request.requestId, result }));
    } catch (error) {
      state.logActivity("error", error instanceof Error ? error.message : "Relay request failed", {});
    }
  });

  relaySocket.on("close", (code, reasonBuffer) => {
    state.setRelayConnection(false);
    relaySocket = null;
    const reason = reasonBuffer.toString("utf8").trim();
    const disconnectMessage = reason
      ? `Remote relay disconnected: ${reason}`
      : "Remote relay disconnected";
    logRelayIssue(
      disconnectMessage,
      {
        code,
        reason: reason || null,
        relayUrl: url.toString(),
        runnerId: env.RUNNER_ID,
      },
      code === 1000 ? "info" : "warn",
    );
    scheduleReconnect();
  });

  relaySocket.on("error", (error) => {
    logRelayIssue(
      getRelayErrorMessage(error),
      {
        relayUrl: url.toString(),
        runnerId: env.RUNNER_ID,
      },
      "warn",
    );
  });

  relaySocket.on("unexpected-response", (_request, response) => {
    void logUnexpectedRelayResponse(response, url);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectRelay();
  }, 2000);
}

function shutdown(signal: NodeJS.Signals) {
  logger.info({ signal }, "local_runner_shutdown_requested");
  relaySocket?.close();
  state.shutdown();
  process.exit(0);
}

function getRelayErrorMessage(error: Error) {
  if (error.message === "socket hang up") {
    return "Relay connection failed: remote server closed the socket during handshake. Check REMOTE_SERVER_URL, RUNNER_TOKEN, and that the remote MCP server is running.";
  }
  return `Relay connection error: ${error.message}`;
}

async function logUnexpectedRelayResponse(response: IncomingMessage, url: URL) {
  const responseBody = await readIncomingMessage(response);
  const statusCode = response.statusCode ?? 0;
  const baseMessage =
    statusCode === 401
      ? "Relay authentication failed. Check that RUNNER_TOKEN matches on the remote MCP server and local runner."
      : `Relay handshake failed with HTTP ${statusCode || "unknown"}.`;

  logRelayIssue(
    responseBody ? `${baseMessage} ${responseBody}` : baseMessage,
    {
      statusCode: statusCode || null,
      relayUrl: url.toString(),
      runnerId: env.RUNNER_ID,
    },
    "warn",
  );
}

function readIncomingMessage(response: IncomingMessage) {
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    response.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8").trim());
    });
    response.on("error", () => resolve(""));
  });
}

function logRelayIssue(
  message: string,
  data: Record<string, unknown>,
  level: "info" | "warn" | "error",
) {
  const dedupeKey = `${level}:${message}`;
  const now = Date.now();
  if (lastRelayIssue?.key === dedupeKey && now - lastRelayIssue.loggedAt < 30_000) {
    return;
  }

  lastRelayIssue = {
    key: dedupeKey,
    loggedAt: now,
  };
  state.logActivity("error", message, data, level);
}

function clearRelayIssueDeduplication() {
  lastRelayIssue = null;
}
