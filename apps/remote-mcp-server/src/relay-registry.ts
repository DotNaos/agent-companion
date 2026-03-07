import { randomUUID } from "node:crypto";
import { AppError, relayResponseSchema, type RelayRequest } from "@agent-companion/shared";
import type { WebSocket } from "ws";

type RelayDispatchResult = {
  ok: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
};

interface PendingRequest {
  resolve: (value: RelayDispatchResult) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}

export class RelayRegistry {
  private runnerSocket: WebSocket | null = null;
  private runnerId: string | null = null;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly requestTimeoutMs: number) {}

  attachRunner(socket: WebSocket, runnerId: string) {
    this.runnerSocket = socket;
    this.runnerId = runnerId;

    socket.on("message", (data) => {
      const parsed = relayResponseSchema.parse(JSON.parse(data.toString("utf8")));
      const pending = this.pending.get(parsed.requestId);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(parsed.requestId);
      pending.resolve(parsed.result);
    });

    socket.on("close", () => {
      this.runnerSocket = null;
      this.runnerId = null;
      for (const [requestId, pending] of this.pending.entries()) {
        clearTimeout(pending.timer);
        pending.reject(new AppError("RUNNER_DISCONNECTED", "Local runner disconnected", 503));
        this.pending.delete(requestId);
      }
    });
  }

  isRunnerConnected() {
    return this.runnerSocket !== null;
  }

  getRunnerId() {
    return this.runnerId;
  }

  async dispatch(request: Omit<RelayRequest, "requestId">) {
    if (!this.runnerSocket) {
      throw new AppError("RUNNER_UNAVAILABLE", "No local runner is connected", 503);
    }
    const requestId = randomUUID();
    const envelope: RelayRequest = {
      requestId,
      ...request,
    };

    const response = await new Promise<RelayDispatchResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new AppError("RUNNER_TIMEOUT", "Local runner did not respond in time", 504));
      }, this.requestTimeoutMs);

      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
      });

      this.runnerSocket?.send(JSON.stringify(envelope));
    });

    return response;
  }
}
