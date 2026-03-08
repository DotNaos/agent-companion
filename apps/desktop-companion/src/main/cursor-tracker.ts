import { screen, type Rectangle } from "electron";
import { EventEmitter } from "node:events";

export interface CursorSnapshot {
  x: number;
  y: number;
  distance: number;
  near: boolean;
}

export class CursorTracker extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private snapshot: CursorSnapshot = {
    x: 0,
    y: 0,
    distance: 9999,
    near: false,
  };

  constructor(private readonly getOverlayBounds: () => Rectangle | null) {
    super();
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.scheduleNextTick(0);
  }

  stop() {
    this.running = false;
    if (!this.timer) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = null;
  }

  getSnapshot() {
    return this.snapshot;
  }

  private tick() {
    const bounds = this.getOverlayBounds();
    if (!bounds) {
      this.scheduleNextTick(250);
      return;
    }

    const point = screen.getCursorScreenPoint();
    // Die berechneten Zentrums-Koordinaten (wo sich Pluto befindet) in der Overlay-Shell.
    // Overlay Fenster ist 432x480. Pluto ist rechts unten: padding-right: 12px, padding-bottom: 8px.
    // Seine Breite/Höhe ist jeweils 220px.
    const centerX = bounds.x + bounds.width - 12 - (220 / 2);
    const centerY = bounds.y + bounds.height - 8 - (220 / 2);
    const dx = point.x - centerX;
    const dy = point.y - centerY;
    const distance = Math.hypot(dx, dy);

    // Kreisförmiges Clamping statt Quadratischem: Erhält den korrekten Blickwinkel (Aspect Ratio)
    // zur Maus. 350 Pixel wirken gut, um nicht zu ruckartig ans Maximum zu springen.
    const LOOK_RADIUS = 350;
    const distRatio = Math.min(distance / LOOK_RADIUS, 1);

    let clampedX = 0;
    let clampedY = 0;

    if (distance > 0) {
      const angle = Math.atan2(dy, dx);
      clampedX = Math.cos(angle) * distRatio;
      clampedY = Math.sin(angle) * distRatio;
    }

    const next: CursorSnapshot = {
      x: clampedX,
      y: clampedY,
      distance,
      near: distance < 260,
    };

    if (
      Math.abs(next.x - this.snapshot.x) > 0.005 ||
      Math.abs(next.y - this.snapshot.y) > 0.005 ||
      next.near !== this.snapshot.near
    ) {
      this.snapshot = next;
      this.emit("status", this.snapshot);
    } else {
      this.snapshot = next;
    }

    this.scheduleNextTick(next.near ? 33 : 80);
  }

  private scheduleNextTick(delayMs: number) {
    if (!this.running) {
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delayMs);
  }
}
