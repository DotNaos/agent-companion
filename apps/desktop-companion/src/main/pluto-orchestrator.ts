import type { RunnerBridge } from "./runner-bridge.js";

interface ScreenshotCapture {
  mimeType: string;
  base64: string;
}

export class PlutoOrchestrator {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly runnerBridge: RunnerBridge,
    private readonly captureScreenshot: () => Promise<ScreenshotCapture | null>,
  ) {}

  start() {
    this.runnerBridge.on("snapshot", this.syncSchedule);
    this.syncSchedule();
  }

  stop() {
    this.runnerBridge.off("snapshot", this.syncSchedule);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async requestCommentary(contextHint = "Give one short comment about what the user appears to be doing on screen.") {
    return this.captureAndComment({
      contextHint,
      requireAutoEnabled: false,
      skipWhenApprovalsPending: false,
    });
  }

  private readonly syncSchedule = () => {
    const snapshot = this.runnerBridge.getSnapshot();
    const config = snapshot.config?.pluto;
    const shouldRun =
      this.runnerBridge.isConnected &&
      snapshot.pluto.available &&
      !!config?.autoCommentaryEnabled;

    if (!shouldRun) {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      return;
    }

    const intervalMs = config?.commentaryIntervalMs ?? 30_000;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);

    void this.tick();
  };

  private async tick() {
    try {
      await this.captureAndComment({
        contextHint: "Give one short comment about what the user appears to be doing on screen.",
        requireAutoEnabled: true,
        skipWhenApprovalsPending: true,
      });
    } catch {
      // Pluto can miss a beat without taking the whole desktop down with it.
    }
  }

  private async captureAndComment({
    contextHint,
    requireAutoEnabled,
    skipWhenApprovalsPending,
  }: {
    contextHint: string;
    requireAutoEnabled: boolean;
    skipWhenApprovalsPending: boolean;
  }) {
    if (this.running) {
      throw new Error("Pluto is already preparing commentary.");
    }

    const snapshot = this.runnerBridge.getSnapshot();
    const config = snapshot.config?.pluto;
    if (!this.runnerBridge.isConnected) {
      throw new Error("Local runner is not connected.");
    }
    if (!snapshot.pluto.available) {
      throw new Error("Pluto is unavailable.");
    }
    if (requireAutoEnabled && !config?.autoCommentaryEnabled) {
      return null;
    }
    if (skipWhenApprovalsPending && snapshot.approvals.length > 0) {
      return null;
    }
    if (snapshot.pluto.pending) {
      throw new Error("Pluto is already composing a message.");
    }

    this.running = true;
    try {
      const screenshot = await this.captureScreenshot();
      if (!screenshot) {
        throw new Error("No screenshot could be captured.");
      }
      return await this.runnerBridge.createPlutoCommentary({
        screenshotBase64: screenshot.base64,
        mimeType: screenshot.mimeType,
        contextHint,
      });
    } finally {
      this.running = false;
    }
  }
}
