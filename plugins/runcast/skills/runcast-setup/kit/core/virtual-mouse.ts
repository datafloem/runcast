import type { Page } from "@playwright/test";
import { sleep, type Point } from "./cursor.ts";
import type { Capture } from "./capture-log.ts";

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

  private readonly page: Page;
  private readonly capture: Capture | null;
  private readonly fast: boolean;

  constructor(page: Page, capture: Capture | null, start: Point, fast = false) {
    this.page = page;
    this.capture = capture;
    this.fast = fast;
    this.position = start;
    capture?.pointer(start, "move");
  }

  /** Where the cursor is (page CSS pixels). */
  get at(): Point {
    return this.position;
  }

  /** Puts the cursor at `point` without moving it there (another tab took over). */
  place(point: Point): void {
    this.position = point;
  }

  /** `onStep` runs after each step of the move (e.g. to send drag events). */
  async moveTo(
    to: Point,
    durationMs?: number,
    onStep?: (at: Point) => Promise<void>,
  ): Promise<void> {
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
      await onStep?.(point);
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

  /** Presses the button at `at` (a grab), shown and sent. */
  async down(at: Point): Promise<void> {
    await this.page.mouse.move(at.x, at.y);
    this.capture?.pointer(at, "down");
    await this.page.mouse.down();
    this.position = at;
  }

  /** Lets go at `at`: shown; sent only when `send` (this page had the press). */
  async up(at: Point, send = true): Promise<void> {
    if (send) await this.page.mouse.up();
    this.capture?.pointer(at, "up");
    this.position = at;
  }

  /** A click with keys held (Shift, Control, Meta), e.g. to select several files. */
  async clickWith(at: Point, modifiers: Array<"Shift" | "Control" | "Meta">): Promise<void> {
    for (const key of modifiers) await this.page.keyboard.down(key);
    try {
      await this.click(at);
    } finally {
      for (const key of modifiers) await this.page.keyboard.up(key);
    }
  }

  /**
   * A click the video shows without sending it: for a control whose real
   * click would open something the browser draws outside the page (a
   * select's list), which the kit shows itself instead.
   */
  async tap(at: Point): Promise<void> {
    this.capture?.pointer(at, "down");
    await sleep(70);
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
