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
    if (this.running) {
      return;
    }

    const snapshot = this.runnerBridge.getSnapshot();
    const config = snapshot.config?.pluto;
    if (
      !this.runnerBridge.isConnected ||
      !snapshot.pluto.available ||
      !config?.autoCommentaryEnabled ||
      snapshot.approvals.length > 0 ||
      snapshot.pluto.pending
    ) {
      return;
    }

    this.running = true;
    try {
      const screenshot = await this.captureScreenshot();
      if (!screenshot) {
        return;
      }
      await this.runnerBridge.createPlutoCommentary({
        screenshotBase64: screenshot.base64,
        mimeType: screenshot.mimeType,
        contextHint: "Give one short comment about what the user appears to be doing on screen.",
      });
    } catch {
      // Pluto can miss a beat without taking the whole desktop down with it.
    } finally {
      this.running = false;
    }
  }
}
