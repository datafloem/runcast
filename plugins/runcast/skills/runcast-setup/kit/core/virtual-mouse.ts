import type { Page } from "@playwright/test";
import { sleep, type Point } from "./cursor.ts";
import type { VideoCapture } from "./video-capture.ts";

/** How much faster the cursor moves while recording fast. */
const FAST_MOVE_FACTOR = 3;

/**
 * The recorded cursor: moves Playwright's mouse inside the page with a
 * person's easing and pace (so hover states show), and logs every position
 * for the renderer, which draws the cursor. Without a capture (rehearsal) it
 * only keeps the pace. `fast` (video mode, REC_RECORD_PACE) moves three times
 * faster and logs each move with its natural length, which the renderer
 * plays it at.
 */
export class VirtualMouse {
  private position: Point;

  constructor(
    private readonly page: Page,
    private readonly capture: VideoCapture | null,
    start: Point,
    private readonly fast = false,
  ) {
    this.position = start;
    capture?.pointer(start, "move");
  }

  async moveTo(to: Point, durationMs?: number): Promise<void> {
    const from = this.position;
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const natural =
      durationMs ?? Math.min(1200, Math.max(300, distance * 1.2));
    const duration = this.fast ? natural / FAST_MOVE_FACTOR : natural;
    const steps = Math.max(1, Math.round(duration / 16));
    const startedMs = this.capture?.now();
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const point = {
        x: from.x + (to.x - from.x) * eased,
        y: from.y + (to.y - from.y) * eased,
      };
      await this.page.mouse.move(point.x, point.y);
      this.capture?.pointer(point, "move");
      await sleep(duration / steps);
    }
    this.position = to;
    if (this.capture && startedMs !== undefined) {
      this.capture.span("move", startedMs, this.capture.now(), natural);
    }
  }

  async click(at: Point): Promise<void> {
    await this.page.mouse.move(at.x, at.y);
    this.capture?.pointer(at, "down");
    await this.page.mouse.down();
    await sleep(70);
    await this.page.mouse.up();
    this.capture?.pointer(at, "up");
    this.position = at;
  }

  async doubleClick(at: Point): Promise<void> {
    this.capture?.pointer(at, "down");
    await this.page.mouse.dblclick(at.x, at.y);
    this.capture?.pointer(at, "up");
    await sleep(90);
    this.capture?.pointer(at, "down");
    this.capture?.pointer(at, "up");
    this.position = at;
  }

  async rightClick(at: Point): Promise<void> {
    this.capture?.pointer(at, "down");
    await this.page.mouse.click(at.x, at.y, { button: "right" });
    this.capture?.pointer(at, "up");
    this.position = at;
  }

  async drag(from: Point, to: Point): Promise<void> {
    await this.moveTo(from);
    await this.page.mouse.down();
    this.capture?.pointer(from, "down");
    await sleep(150);
    await this.moveTo(to, 900);
    await sleep(150);
    await this.page.mouse.up();
    this.capture?.pointer(to, "up");
  }
}
