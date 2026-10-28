import {
  test as base,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { sleep, type Point } from "./cursor.ts";
import { isTestMode, isVideoMode, pageSize, settings } from "./mode.ts";
import type { VideoCard } from "./scenario.ts";
import { VideoCapture, type Box, type FocusKind } from "./video-capture.ts";
import { VirtualMouse } from "./virtual-mouse.ts";

/** A point inside an element, as fractions of its box (0.5, 0.5 = centre). */
export interface Spot {
  in: Locator;
  x: number;
  y: number;
}
export type Target = Locator | Spot;

/** What every helper and step works with: the page and the recorder driving it. */
export interface Ui {
  page: Page;
  rec: Recorder;
}

export function spot(locator: Locator, x: number, y: number): Spot {
  return { in: locator, x, y };
}

/** Voice-over spoken over a step (lib/narration.ts). */
export interface StepNarration {
  text: string;
  /** Audio file mixed into the video at the step's time, relative to tests/recording/. */
  audio: string | null;
  /** Measured length of the audio, or an estimate when there is none yet. */
  durationMs: number;
  measured: boolean;
}

interface StepMark {
  /** The step's id (lib/steps), when the step came from a scenario. */
  id?: string;
  at: string;
  seconds: number;
  title: string;
  /** The on-screen message for this step (scenario-specific). */
  note?: string;
  narration?: StepNarration;
  /** A transition the renderer draws over this step ("cube"). */
  transition?: string;
  /** How long the step ran (filled at the end). */
  durationMs?: number;
  /** How much longer the step ran than its narration plus gap. */
  overrunMs?: number;
}

/**
 * The steps of a scenario, in every mode (lib/mode.ts):
 *
 * - video / rehearsal: a virtual cursor moves inside the page at a person's
 *   pace and clicks there; pauses keep the pace for the viewer. In video mode
 *   the page is also recorded and every action logged for the camera.
 * - test: Playwright's own actions (with their auto-waiting), no pauses — a
 *   plain, fast end-to-end run.
 *
 * Before `start()` the recorder is in its **preparation** phase, in every
 * mode: actions are fast Playwright actions, pauses are skipped and steps are
 * not marked. A scenario started from a later step (REC_FROM) runs the earlier
 * steps this way, then starts recording.
 */
export class Recorder {
  private mouse: VirtualMouse | null = null;
  private capture: VideoCapture | null = null;
  /** Box of the element the last action aimed at (page coordinates). */
  private lastBox: Box | undefined;
  private live = false;
  private startedAt = Date.now();
  private readonly steps: Array<StepMark> = [];
  /** Whether the video shows the step notes as captions (see ScenarioDefinition). */
  captions = false;
  /** Title cards before / after the recording (see ScenarioDefinition). */
  cards: { intro?: VideoCard; outro?: VideoCard } = {};

  constructor(
    private readonly page: Page,
    private readonly testInfo: TestInfo,
  ) {}

  /** True once `start()` ran: actions are the ones the video shows. */
  get isLive(): boolean {
    return this.live;
  }

  /**
   * Ends the preparation phase: from here on actions run at a person's pace
   * (video, rehearsal) and, in video mode, the screen is recorded.
   */
  async start(): Promise<void> {
    this.live = true;
    this.startedAt = Date.now();
    if (isTestMode) return;
    let capture: VideoCapture | null = null;
    let viewport = pageSize;
    if (isVideoMode) {
      capture = new VideoCapture(
        this.page,
        this.testInfo.outputPath("capture"),
        this.startedAt,
        path.basename(this.testInfo.file, ".spec.ts"),
      );
      // Time zero is when the screen recording runs.
      const started = await capture.start();
      this.startedAt = started.startedAt;
      viewport = started.viewport;
      this.capture = capture;
    }
    this.mouse = new VirtualMouse(this.page, capture, {
      x: viewport.width / 2,
      y: viewport.height / 2,
    });
  }

  /**
   * Marks a step of the script: logs its time in the recording and writes it,
   * with its note and voice-over, to steps.json (the renderer reads it).
   */
  step(
    title: string,
    note?: string,
    extra: { id?: string; narration?: StepNarration; transition?: string } = {},
  ): Promise<void> {
    if (!this.live) {
      console.log(`(preparation) ${title}`);
      return Promise.resolve();
    }
    const seconds = (Date.now() - this.startedAt) / 1000;
    const at = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(
      Math.floor(seconds % 60),
    ).padStart(2, "0")}`;
    this.steps.push({
      id: extra.id,
      at,
      seconds: Math.round(seconds * 10) / 10,
      title,
      note,
      narration: extra.narration,
      transition: extra.transition,
    });
    console.log(`[${at}] ${title}${note ? ` — ${note}` : ""}`);
    return Promise.resolve();
  }

  async hover(target: Target): Promise<void> {
    const mouse = this.liveMouse();
    if (!mouse) {
      if (isLocator(target)) await target.hover();
      else await this.page.mouse.move(...xy(await this.pagePoint(target)));
      return;
    }
    const point = await this.pagePoint(target);
    await mouse.moveTo(point);
    this.logFocus("hover", target, point);
  }

  async click(target: Target): Promise<void> {
    const mouse = this.liveMouse();
    if (!mouse) {
      if (isLocator(target)) await target.click();
      else await this.page.mouse.click(...xy(await this.pagePoint(target)));
      await sleep(this.aimMs);
      return;
    }
    const point = await this.pagePoint(target);
    await mouse.moveTo(point);
    await sleep(settings.aimMs);
    await mouse.click(point);
    this.logFocus("click", target, point);
  }

  async doubleClick(target: Target): Promise<void> {
    const mouse = this.liveMouse();
    if (!mouse) {
      if (isLocator(target)) await target.dblclick();
      else await this.page.mouse.dblclick(...xy(await this.pagePoint(target)));
      await sleep(this.aimMs);
      return;
    }
    const point = await this.pagePoint(target);
    await mouse.moveTo(point);
    await sleep(settings.aimMs);
    await mouse.doubleClick(point);
    this.logFocus("double-click", target, point);
  }

  async rightClick(target: Target): Promise<void> {
    const mouse = this.liveMouse();
    if (!mouse) {
      if (isLocator(target)) await target.click({ button: "right" });
      else
        await this.page.mouse.click(...xy(await this.pagePoint(target)), {
          button: "right",
        });
      await sleep(this.aimMs);
      return;
    }
    const point = await this.pagePoint(target);
    await mouse.moveTo(point);
    await sleep(settings.aimMs);
    await mouse.rightClick(point);
    this.logFocus("right-click", target, point);
  }

  /** Drags from one element to another, e.g. a card to another column. */
  async drag(from: Target, to: Target): Promise<void> {
    const mouse = this.liveMouse();
    if (!mouse) {
      const start = await this.pagePoint(from);
      const end = await this.pagePoint(to);
      await this.page.mouse.move(...xy(start));
      await this.page.mouse.down();
      await this.page.mouse.move(...xy(end), { steps: 25 });
      await this.page.mouse.up();
      return;
    }
    const start = await this.pagePoint(from);
    const end = await this.pagePoint(to);
    const startedMs = this.capture?.now();
    await mouse.drag(start, end);
    this.logFocus("drag", to, end, startedMs);
  }

  /** Clicks the field, then types like a person (instantly in test mode). */
  async type(target: Target, text: string, delayMs = 60): Promise<void> {
    await this.click(target);
    // A click measured while a panel still scrolls can miss the field; then
    // the text would go nowhere. Make sure the field has the focus.
    const field = "in" in target ? target.in : target;
    if (!(await field.evaluate((el) => el === document.activeElement))) {
      await field.focus();
    }
    const startedMs = this.capture?.now();
    await this.page.keyboard.type(text, {
      delay: this.live ? settings.typeDelay(delayMs) : 0,
    });
    if (this.capture && this.lastBox) {
      const box = this.lastBox;
      const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      this.capture.focus("type", centre, box, startedMs);
    }
  }

  /** Same as `type`, for secrets: kept out of Playwright's step log. */
  async typeSecret(target: Locator, text: string): Promise<void> {
    await this.click(target);
    await target.fill(text);
  }

  /** Seconds since the recording started (0 before it). */
  elapsedMs(): number {
    return this.live ? Date.now() - this.startedAt : 0;
  }

  /** Notes that the last marked step ran longer than its narration. */
  markOverrun(ms: number): void {
    const last = this.steps.at(-1);
    if (last) last.overrunMs = Math.round(ms);
  }

  /** A pause for the viewer. Skipped in test mode: never use it to wait for the app. */
  pause(ms = 1000): Promise<void> {
    return settings.pauses && this.live ? sleep(ms) : Promise.resolve();
  }

  /** Holds the last frame, then stops the recording. */
  async finish(): Promise<void> {
    if (this.live) await sleep(settings.endHoldMs);
    if (this.capture) {
      const file = await this.capture.stop();
      console.log(`Video capture: ${path.dirname(file)}`);
    }
    if (this.steps.length > 0) {
      const endSeconds = this.elapsedMs() / 1000;
      this.steps.forEach((mark, i) => {
        const next = this.steps[i + 1]?.seconds ?? endSeconds;
        mark.durationMs = Math.round((next - mark.seconds) * 1000);
      });
      const file = this.testInfo.outputPath("steps.json");
      const scenario = path.basename(this.testInfo.file, ".spec.ts");
      writeFileSync(
        file,
        JSON.stringify(
          {
            scenario,
            captions: this.captions,
            ...this.cards,
            steps: this.steps,
          },
          null,
          2,
        ),
      );
      console.log(`Step times: ${file}`);
    }
  }

  /** The virtual cursor once recording runs; null = fast Playwright actions. */
  private liveMouse(): VirtualMouse | null {
    return this.live ? this.mouse : null;
  }

  private get aimMs(): number {
    return this.live ? settings.aimMs : 0;
  }

  /** Video mode: where the camera should look for this action. */
  private logFocus(
    kind: FocusKind,
    target: Target,
    point: Point,
    from?: number,
  ): void {
    if (!this.capture) return;
    // A spot inside a big element (e.g. the canvas) is not the element: zoom on the point.
    const box = isLocator(target) ? this.lastBox : undefined;
    this.capture.focus(kind, point, box, from);
  }

  /** The target's point in page (CSS pixel) coordinates. */
  private async pagePoint(target: Target): Promise<Point> {
    const locator = "in" in target ? target.in : target;
    const fx = "in" in target ? target.x : 0.5;
    const fy = "in" in target ? target.y : 0.5;

    // Lists re-render while they load (spinner -> empty state -> rows), so the
    // element found first can be replaced before we measure it. Find it again.
    for (let attempt = 1; ; attempt++) {
      // Not retried: an element that never shows up fails here, once.
      await locator.waitFor({ state: "visible" });
      try {
        await locator.scrollIntoViewIfNeeded({ timeout: 5_000 });
        const box = await locator.boundingBox({ timeout: 5_000 });
        if (box) {
          this.lastBox = box;
          return { x: box.x + box.width * fx, y: box.y + box.height * fy };
        }
      } catch (error) {
        if (attempt >= 5 || !isStaleElementError(error)) throw error;
      }
      if (attempt >= 5)
        throw new Error(`Element is not visible: ${locator.toString()}`);
      await sleep(300);
    }
  }
}

function isStaleElementError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not attached|detached|not stable|Timeout \d+ms exceeded/i.test(
    message,
  );
}

function isLocator(target: Target): target is Locator {
  return !("in" in target);
}

function xy(point: Point): [number, number] {
  return [point.x, point.y];
}

export const test = base.extend<{ rec: Recorder }>({
  rec: async ({ page }, provide, testInfo) => {
    const rec = new Recorder(page, testInfo);
    await provide(rec);
    await rec.finish();
  },
});

export { expect } from "@playwright/test";
