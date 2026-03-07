import {
    DEFAULT_ACTIVITY_LIMIT,
    activityEventSchema,
    agentCompanionConfigSchema,
    approvalDecisionSchema,
    approvalRequestSchema,
    plutoCommentaryInputSchema,
    plutoStateSchema,
    runnerStatusSchema,
} from "@agent-companion/shared";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";

export interface RunnerSnapshot {
  status: ReturnType<typeof runnerStatusSchema.parse>;
  config: ReturnType<typeof agentCompanionConfigSchema.parse> | null;
  activity: Array<ReturnType<typeof activityEventSchema.parse>>;
  approvals: Array<ReturnType<typeof approvalRequestSchema.parse>>;
  pluto: ReturnType<typeof plutoStateSchema.parse>;
}

export class RunnerBridge extends EventEmitter {
  private socket: WebSocket | null = null;
  private connected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private snapshot: RunnerSnapshot = {
    status: runnerStatusSchema.parse({
      connectedToRemote: false,
      lastSeenAt: null,
      pendingApprovals: 0,
      runningProcesses: 0,
    }),
    config: null,
    activity: [],
    approvals: [],
    pluto: plutoStateSchema.parse({
      available: false,
      muted: false,
      autoCommentaryEnabled: false,
      commentaryIntervalMs: 30_000,
      model: "models/gemini-2.5-flash-native-audio-preview-12-2025",
      pending: false,
      lastError: null,
      activeMessage: null,
      history: [],
    }),
  };

  constructor(private readonly baseUrl: string) {
    super();
  }

  get isConnected() {
    return this.connected;
  }

  async connect() {
    await this.refresh().catch(() => undefined);
    const streamUrl = new URL("/internal/stream", this.baseUrl);
    streamUrl.protocol = streamUrl.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(streamUrl);
    this.socket.on("open", () => {
      this.connected = true;
      this.emit("snapshot", this.getSnapshot());
    });
    this.socket.on("message", (data) => {
      const message = JSON.parse(data.toString("utf8")) as {
        type: string;
        data: unknown;
      };
      switch (message.type) {
        case "status":
          this.snapshot.status = runnerStatusSchema.parse(message.data);
          break;
        case "activity":
          this.snapshot.activity = [...this.snapshot.activity, activityEventSchema.parse(message.data)].slice(-200);
          break;
        case "activity_snapshot":
          this.snapshot.activity = (message.data as unknown[]).map((entry) => activityEventSchema.parse(entry));
          break;
        case "approvals":
          this.snapshot.approvals = (message.data as unknown[]).map((entry) => approvalRequestSchema.parse(entry));
          break;
        case "config":
          this.snapshot.config = agentCompanionConfigSchema.parse(message.data);
          break;
        case "pluto":
          this.snapshot.pluto = plutoStateSchema.parse(message.data);
          break;
      }
      this.emit("snapshot", this.getSnapshot());
    });
    this.socket.on("close", () => {
      this.connected = false;
      this.snapshot.status.connectedToRemote = false;
      this.emit("snapshot", this.getSnapshot());
      this.scheduleReconnect();
    });
    this.socket.on("error", () => {
      this.connected = false;
      this.emit("snapshot", this.getSnapshot());
      this.scheduleReconnect();
    });
  }

  getSnapshot() {
    return structuredClone(this.snapshot);
  }

  async refresh() {
    const [status, config, activity, approvals, pluto] = await Promise.all([
      this.fetchJson("/internal/status"),
      this.fetchJson("/internal/config"),
      this.fetchJson(`/internal/activity?limit=${DEFAULT_ACTIVITY_LIMIT}`),
      this.fetchJson("/internal/approvals"),
      this.fetchJson("/internal/pluto"),
    ]);

    this.snapshot = {
      status: runnerStatusSchema.parse(status),
      config: agentCompanionConfigSchema.parse(config),
      activity: ((activity as { entries: unknown[] }).entries ?? []).map((entry) => activityEventSchema.parse(entry)),
      approvals: ((approvals as { approvals: unknown[] }).approvals ?? []).map((entry) =>
        approvalRequestSchema.parse(entry),
      ),
      pluto: plutoStateSchema.parse(pluto),
    };
    this.emit("snapshot", this.getSnapshot());
  }

  async updateConfig(config: unknown) {
    const response = await fetch(new URL("/internal/config", this.baseUrl), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });
    if (!response.ok) {
      throw new Error(`Runner config update failed with ${response.status}`);
    }
    await this.refresh();
    return this.snapshot.config;
  }

  async decideApproval(decision: unknown) {
    const payload = approvalDecisionSchema.parse(decision);
    const response = await this.postJson("/internal/approvals/decision", payload);
    if (!response.ok) {
      throw new Error(`Approval decision failed with ${response.status}`);
    }
    await this.refresh();
    return response.json();
  }

  async createPlutoCommentary(input: unknown) {
    const payload = plutoCommentaryInputSchema.parse(input);
    const response = await this.postJson("/internal/pluto/commentary", payload);
    if (!response.ok) {
      throw new Error(`Pluto commentary failed with ${response.status}`);
    }
    await this.refresh();
    return await response.json();
  }

  async fetchPlutoAudio(messageId: string) {
    const response = await fetch(new URL(`/internal/pluto/audio/${encodeURIComponent(messageId)}`, this.baseUrl));
    if (!response.ok) {
      throw new Error(`Pluto audio request failed with ${response.status}`);
    }
    return {
      contentType: response.headers.get("content-type") ?? "audio/wav",
      buffer: Buffer.from(await response.arrayBuffer()),
    };
  }

  private async fetchJson(pathname: string) {
    const response = await fetch(new URL(pathname, this.baseUrl));
    if (!response.ok) {
      throw new Error(`Runner bridge request failed: ${pathname} (${response.status})`);
    }
    return await response.json();
  }

  private postJson(pathname: string, payload: unknown) {
    return fetch(new URL(pathname, this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, 2000);
  }
}
