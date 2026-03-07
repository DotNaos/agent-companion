import { WebSocket } from "ws";
import { relayRequestSchema } from "@agent-companion/shared";
import { loadRunnerEnv } from "./env.js";
import { startControlServer } from "./control-server.js";
import { RunnerState } from "./state.js";

const env = loadRunnerEnv();
const state = new RunnerState(env);

let relaySocket: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

await startControlServer(state, env.LOCAL_RUNNER_PORT);
connectRelay();

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function connectRelay() {
  const url = new URL("/runner/connect", env.REMOTE_SERVER_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("runnerId", env.RUNNER_ID);

  relaySocket = new WebSocket(url, {
    headers: {
      authorization: `Bearer ${env.RUNNER_TOKEN}`,
    },
  });

  relaySocket.on("open", () => {
    state.setRelayConnection(true);
    state.logActivity("status", "Connected to remote relay");
  });

  relaySocket.on("message", async (data) => {
    try {
      const request = relayRequestSchema.parse(JSON.parse(data.toString("utf8")));
      const result = await state.handleRelayRequest(request);
      relaySocket?.send(JSON.stringify({ requestId: request.requestId, result }));
    } catch (error) {
      state.logActivity("error", error instanceof Error ? error.message : "Relay request failed", {});
    }
  });

  relaySocket.on("close", () => {
    state.setRelayConnection(false);
    scheduleReconnect();
  });

  relaySocket.on("error", (error) => {
    state.logActivity("error", `Relay connection error: ${error.message}`);
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

function shutdown() {
  relaySocket?.close();
  state.shutdown();
  process.exit(0);
}
