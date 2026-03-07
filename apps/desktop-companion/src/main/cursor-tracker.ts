import { EventEmitter } from "node:events";
import { screen, type Rectangle } from "electron";

export interface CursorSnapshot {
  x: number;
  y: number;
  distance: number;
  near: boolean;
}

export class CursorTracker extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
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
    if (this.timer) {
      return;
    }
    this.tick();
    this.timer = setInterval(() => this.tick(), 160);
  }

  stop() {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  getSnapshot() {
    return this.snapshot;
  }

  private tick() {
    const bounds = this.getOverlayBounds();
    if (!bounds) {
      return;
    }

    const point = screen.getCursorScreenPoint();
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2 + 40;
    const dx = point.x - centerX;
    const dy = point.y - centerY;
    const distance = Math.hypot(dx, dy);
    const clampedX = clamp(dx / 180, -1, 1);
    const clampedY = clamp(dy / 180, -1, 1);

    const next: CursorSnapshot = {
      x: clampedX,
      y: clampedY,
      distance,
      near: distance < 260,
    };

    if (
      Math.abs(next.x - this.snapshot.x) > 0.02 ||
      Math.abs(next.y - this.snapshot.y) > 0.02 ||
      next.near !== this.snapshot.near
    ) {
      this.snapshot = next;
      this.emit("status", this.snapshot);
    } else {
      this.snapshot = next;
    }
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
