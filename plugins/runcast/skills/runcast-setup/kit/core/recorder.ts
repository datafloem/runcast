import {
  test as base,
  type Dialog,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { sleep, type Point } from "./cursor.ts";
import {
  recordsVertically,
  VERTICAL_PAGE,
  type VideoFormat,
} from "./format.ts";
import {
  isTestMode,
  isVideoMode,
  pageSize,
  settings,
  type AppAudio,
} from "./mode.ts";
import { projectDirOf } from "./narration.ts";
import {
  dispatchDrag,
  removeStandIn,
  showMonth,
  showOptions,
} from "./native-ui.ts";
import { screenProblem } from "./on-screen.ts";
import { captureRootFor } from "./project.ts";
import type { ShowTransition, VideoCard } from "./scenario.ts";
import type { Box, Capture, FocusKind, SourceSwitch } from "./capture-log.ts";
import { sizeWindow, TabCapture } from "./tab-capture.ts";
import { fitWindow, VideoCapture } from "./video-capture.ts";
import { VirtualMouse } from "./virtual-mouse.ts";

/** Recording fast (Recorder.fastRecording): real time spent of a viewer pause... */
const FAST_HOLD_HEAD_MS = 300;
/** ...of the cursor's rest on a target (hover states need it)... */
const FAST_AIM_HEAD_MS = 150;
/** ...and per typed character (one frame at 30 fps, so typing stretches cleanly). */
const FAST_TYPE_DELAY_MS = 40;

/** How long rec waits for a target to be shown and usable before failing the step. */
const ON_SCREEN_WAIT_MS = 5_000;

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

interface StepMark {
  /** The step's id (lib/steps), when the step came from a scenario. */
  id?: string;
  at: string;
  seconds: number;
  title: string;
  /** The on-screen message for this step (scenario-specific). */
  note?: string;
  /** A transition the renderer draws over this step ("cube"). */
  transition?: string;
  /** How long the step ran in the recording (filled at the end). */
  durationMs?: number;
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
  private capture: Capture | null = null;
  /** Box of the element the last action aimed at (page coordinates). */
  private lastBox: Box | undefined;
  private live = false;
  /** Off camera (an `offCamera` step): fast actions, not recorded. */
  private suspended = false;
  private suspendedAt = 0;
  /** Time spent off camera so far: left out of the recording's clock. */
  private offCameraMs = 0;
  private startedAt = Date.now();
  private readonly steps: Array<StepMark> = [];
  /** Whether the video shows the step notes as captions (see ScenarioDefinition). */
  captions = false;
  /** Whether the renderer may shorten app waits to fit narration (see ScenarioDefinition). */
  compressWaits = true;
  /** Title cards before / after the recording (see ScenarioDefinition). */
  cards: { intro?: VideoCard; outro?: VideoCard } = {};
  /** How rec.show reaches an element when it names no transition (see ScenarioDefinition). */
  showTransition: ShowTransition = "pan";
  /** The app's sound in the video (see ScenarioDefinition.appAudio); null: off. */
  appAudio: AppAudio | null = null;
  /** How browser dialogs are answered (see ScenarioDefinition.dialogs). */
  dialogs: "accept" | "dismiss" = "accept";
  /** The answer for the next dialog only (onDialog). */
  private nextDialog: { accept: boolean; text?: string } | null = null;
  /** The video's shape (see ScenarioDefinition); set by useFormat(). */
  private format: VideoFormat = "landscape";
  /** Tab capture: the window has been sized to the page size. */
  private sized = false;
  /** Rehearsal's stage page (video mode records TabCapture's). */
  private rehearsalStage: Page | null = null;
  /** The cursor on the stage tab (same coordinates as the app's). */
  private stageMouse: VirtualMouse | null = null;

  private readonly page: Page;
  private readonly testInfo: TestInfo;

  constructor(page: Page, testInfo: TestInfo) {
    this.page = page;
    this.testInfo = testInfo;
  }

  /**
   * Answers the next browser dialog (alert, confirm, prompt, beforeunload)
   * this way instead of the scenario's `dialogs`; call it right before the
   * action that opens it. `text` answers a prompt.
   */
  onDialog(answer: { accept: boolean; text?: string }): void {
    this.nextDialog = answer;
  }

  /**
   * Answers the page's dialogs from now on (the rec fixture does this, in
   * every mode). On camera in video mode each one is logged, and the video
   * holds the frame and draws it being answered.
   */
  watchDialogs(): void {
    this.page.on("dialog", (dialog) => void this.answerDialog(dialog));
  }

  private async answerDialog(dialog: Dialog): Promise<void> {
    const answer = this.nextDialog ?? { accept: this.dialogs === "accept" };
    this.nextDialog = null;
    const text = dialog.type() === "prompt" && answer.accept
      ? (answer.text ?? dialog.defaultValue())
      : undefined;
    if (this.capture && this.paced) {
      let origin: string | undefined;
      try {
        origin = new URL(this.page.url()).host || undefined;
      } catch {
        origin = undefined;
      }
      this.capture.dialog(dialog.type(), dialog.message(), answer.accept, text, origin);
    }
    try {
      if (answer.accept) await dialog.accept(text);
      else await dialog.dismiss();
    } catch {
      // The page went away (a navigation answered a beforeunload).
    }
  }

  /** True once `start()` ran: actions are the ones the video shows. */
  get isLive(): boolean {
    return this.live;
  }

  /**
   * Sets the video's shape. "vertical" makes the page 9:16 right away (a
   * 540x960 page; with screen capture a narrow window), so the app is
   * prepared and recorded in its mobile layout. Tab capture sizes the
   * window to the page size here, before the first page load.
   */
  async useFormat(format: VideoFormat): Promise<void> {
    this.format = format;
    if (isVideoMode && settings.capture === "tab") {
      await this.sizeTab();
      return;
    }
    if (!recordsVertically(format)) return;
    if (isVideoMode) await fitWindow(this.page, true);
    else await this.page.setViewportSize(VERTICAL_PAGE);
  }

  /** Tab capture: the window around the page, sized to the format's page size. */
  private async sizeTab(): Promise<void> {
    await sizeWindow(
      this.page,
      recordsVertically(this.format) ? VERTICAL_PAGE : pageSize,
    );
    this.sized = true;
  }

  /**
   * Ends the preparation phase: from here on actions run at a person's pace
   * (video, rehearsal) and, in video mode, the page is recorded.
   */
  async start(): Promise<void> {
    this.live = true;
    this.startedAt = Date.now();
    if (isTestMode) return;
    let capture: Capture | null = null;
    let viewport = this.page.viewportSize() ?? pageSize;
    if (isVideoMode) {
      rmSync(this.captureRoot(), { recursive: true, force: true });
      const dir = path.join(this.captureRoot(), "capture");
      const scenario = path.basename(this.testInfo.file, ".spec.ts");
      if (settings.capture === "tab") {
        if (!this.sized) await this.sizeTab();
        // The sound is always captured: that is what keeps it off the
        // speakers. The renderer mixes it only when the scenario asks.
        capture = new TabCapture(this.page, dir, scenario, {
          scale: settings.scale,
          audio: true,
        });
      } else {
        capture = new VideoCapture(
          this.page,
          dir,
          scenario,
          recordsVertically(this.format),
        );
      }
      // Time zero is when the recording runs.
      const started = await capture.start();
      this.startedAt = started.startedAt;
      viewport = started.viewport;
      this.capture = capture;
    }
    this.mouse = new VirtualMouse(
      this.page,
      capture,
      { x: viewport.width / 2, y: viewport.height / 2 },
      this.fastRecording,
    );
  }

  /**
   * Runs `fn` on the stage, a second recorded tab of the page's size, with
   * its own cursor, and shows it in the video from now until `fn` ends:
   * reached by `transition`, left by `back` (default the same). For what
   * the app's tab cannot show: a file manager, a drag source, a scene. Video
   * (tab capture) and rehearsal only.
   */
  async onStage<T>(
    fn: (stage: Page, mouse: VirtualMouse) => Promise<T>,
    transition: SourceSwitch["transition"] = "fade",
    back: SourceSwitch["transition"] = transition,
  ): Promise<T> {
    const app = this.liveMouse();
    if (!app) throw new Error("rec.onStage runs on camera only (video and rehearsal).");
    const stage = await this.stagePage();
    this.stageMouse ??= new VirtualMouse(stage, this.capture, app.at, this.fastRecording);
    this.stageMouse.place(app.at);
    this.switchTo("stage", transition);
    try {
      return await fn(stage, this.stageMouse);
    } finally {
      app.place(this.stageMouse.at);
      this.switchTo("app", back);
    }
  }

  /** Logs which tab the video shows from now on (tab capture). */
  private switchTo(
    source: SourceSwitch["source"],
    transition: SourceSwitch["transition"],
  ): void {
    if (this.capture instanceof TabCapture && !this.suspended) {
      this.capture.source(source, transition);
    }
  }

  /** The stage tab: the recorded one in video mode, a plain page in rehearsal. */
  private async stagePage(): Promise<Page> {
    if (this.capture instanceof TabCapture && this.capture.stage) return this.capture.stage;
    if (isVideoMode) {
      throw new Error(
        "The stage needs tab capture: unset REC_CAPTURE (or REC_CAPTURE=tab).",
      );
    }
    if (!this.rehearsalStage) {
      this.rehearsalStage = await this.page.context().newPage();
      await this.rehearsalStage.setViewportSize(
        this.page.viewportSize() ?? pageSize,
      );
      await this.page.bringToFront();
    }
    return this.rehearsalStage;
  }

  /**
   * Marks a step of the script: logs its time in the recording and writes it,
   * with its note, to steps.json (the renderer reads it and fits the
   * step's narration to it).
   */
  step(
    title: string,
    note?: string,
    extra: { id?: string; transition?: string } = {},
  ): Promise<void> {
    if (!this.live) {
      console.log(`(preparation) ${title}`);
      return Promise.resolve();
    }
    const seconds = this.elapsedMs() / 1000;
    const at = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(
      Math.floor(seconds % 60),
    ).padStart(2, "0")}`;
    this.steps.push({
      id: extra.id,
      at,
      seconds: Math.round(seconds * 10) / 10,
      title,
      note,
      transition: extra.transition,
    });
    console.log(`[${at}] ${title}${note ? ` — ${note}` : ""}`);
    return Promise.resolve();
  }

  async hover(target: Target): Promise<void> {
    const mouse = this.liveMouse();
    if (!mouse) {
      await this.pagePoint(target);
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
      await this.pagePoint(target);
      if (isLocator(target)) await target.click();
      else await this.page.mouse.click(...xy(await this.pagePoint(target)));
      await sleep(this.aimMs);
      return;
    }
    const point = await this.pagePoint(target);
    await mouse.moveTo(point);
    await this.rest("aim", settings.aimMs);
    await mouse.click(point);
    this.logFocus("click", target, point);
  }

  async doubleClick(target: Target): Promise<void> {
    const mouse = this.liveMouse();
    if (!mouse) {
      await this.pagePoint(target);
      if (isLocator(target)) await target.dblclick();
      else await this.page.mouse.dblclick(...xy(await this.pagePoint(target)));
      await sleep(this.aimMs);
      return;
    }
    const point = await this.pagePoint(target);
    await mouse.moveTo(point);
    await this.rest("aim", settings.aimMs);
    await mouse.doubleClick(point);
    this.logFocus("double-click", target, point);
  }

  async rightClick(target: Target): Promise<void> {
    const mouse = this.liveMouse();
    if (!mouse) {
      await this.pagePoint(target);
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
    await this.rest("aim", settings.aimMs);
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

  /**
   * Picks an option of a native <select> by its label. Never click a select
   * yourself: its list is drawn by the browser outside the page. In video
   * and rehearsal the kit draws the list under the select, the cursor
   * clicks the option, then the value is set (selectOption) and the list
   * goes. Test mode: selectOption only.
   */
  async select(target: Locator, label: string): Promise<void> {
    await this.pickWithStandIn(
      target,
      () => target.evaluate(showOptions),
      this.page.locator(`[data-runcast-ui] [data-label=${cssString(label)}]`),
      () => target.selectOption({ label }).then(() => undefined),
    );
  }

  /**
   * Sets a date input to `value` (YYYY-MM-DD). In video and rehearsal the kit
   * draws a month grid under the field and the cursor clicks the day, then
   * the value is set (fill); other inputs are typed into. Test mode: fill.
   */
  async pickDate(target: Locator, value: string): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error(`rec.pickDate: "${value}" is not a date (YYYY-MM-DD).`);
    }
    const type = await target.getAttribute("type");
    if (type !== "date") {
      await this.type(target, value);
      return;
    }
    await this.pickWithStandIn(
      target,
      () => target.evaluate(showMonth, value),
      this.page.locator(`[data-runcast-ui] [data-day="${Number(value.slice(8))}"]`),
      () => target.fill(value),
    );
  }

  /**
   * Uploads files through the app's file chooser: clicking `trigger` opens
   * it. In video and rehearsal the stage shows a file manager with the
   * files, the cursor picks them and clicks Open, and the video goes back to
   * the app (`transition`, default "fade"); then the chooser gets the files.
   * Test mode: the trigger is clicked and the files are set. Relative paths
   * are from the recording folder.
   */
  async chooseFiles(
    trigger: Target,
    files: Array<string>,
    options: { transition?: SourceSwitch["transition"] } = {},
  ): Promise<void> {
    const paths = this.filePaths(files);
    const chooserOpens = this.page.waitForEvent("filechooser", { timeout: 15_000 });
    await this.click(trigger);
    const chooser = await chooserOpens;
    if (paths.length > 1 && !chooser.isMultiple()) {
      throw new Error(
        `rec.chooseFiles: the file chooser takes one file, ${paths.length} were given.`,
      );
    }
    if (this.liveMouse()) {
      await this.onStage(async (stage, mouse) => {
        await this.showFileManager(stage, paths, "open");
        await this.pickFiles(stage, mouse, paths);
        const open = stage.locator('[data-action="open"]');
        await mouse.moveTo(await centreOf(open));
        await this.rest("aim", settings.aimMs);
        await mouse.click(await centreOf(open));
        await sleep(150);
      }, options.transition ?? "fade");
    }
    await chooser.setFiles(paths);
  }

  /**
   * Drops files on a drop zone, as if dragged from the desktop. In video and
   * rehearsal the stage shows a file manager, the cursor grabs the files
   * there and carries them (the video draws their icon at the cursor) to
   * the zone; the video goes back to the app with `transition` (default
   * "lift": the file manager goes behind). The zone gets dragenter, dragover
   * on the way and a drop with real File objects. Test mode: the three
   * events at the zone's centre. Relative paths are from the recording folder.
   */
  async dropFiles(
    zone: Locator,
    files: Array<string>,
    options: { transition?: SourceSwitch["transition"] } = {},
  ): Promise<void> {
    const paths = this.filePaths(files);
    const payload = paths.map((file) => ({
      name: path.basename(file),
      type: mimeType(file),
      base64: readFileSync(file).toString("base64"),
    }));
    const send = (
      type: "dragenter" | "dragover" | "drop",
      at: Point,
      withFiles: boolean,
    ) =>
      this.page.evaluate(dispatchDrag, {
        type,
        x: at.x,
        y: at.y,
        ...(withFiles ? { files: payload } : {}),
      });

    const mouse = this.liveMouse();
    if (!mouse) {
      const at = await this.pagePoint(zone);
      await send("dragenter", at, true);
      await send("dragover", at, false);
      await send("drop", at, false);
      return;
    }

    await this.pagePoint(zone); // the zone must be ready before the files are picked
    let grabbedAt = 0;
    let stageMouse: VirtualMouse | null = null;
    await this.onStage(
      async (stage, cursor) => {
        await this.showFileManager(stage, paths, "drag");
        const last = await this.pickFiles(stage, cursor, paths);
        await cursor.down(last);
        grabbedAt = this.capture?.now() ?? 0;
        await sleep(150);
        stageMouse = cursor;
      },
      "fade",
      options.transition ?? "lift",
    );
    // The press stays on the stage; let go there quietly.
    await (stageMouse as VirtualMouse | null)?.up(mouse.at).catch(() => {});
    const target = await this.pagePoint(zone);
    const box = this.lastBox;
    let entered = false;
    const inside = (at: Point) =>
      !!box && at.x >= box.x && at.x <= box.x + box.width && at.y >= box.y && at.y <= box.y + box.height;
    await mouse.moveTo(target, undefined, async (at) => {
      if (!inside(at)) return;
      await send(entered ? "dragover" : "dragenter", at, !entered);
      entered = true;
    });
    if (!entered) await send("dragenter", target, true);
    await send("dragover", target, false);
    await sleep(120);
    await send("drop", target, false);
    await mouse.up(target, false);
    if (this.capture instanceof TabCapture && !this.suspended) {
      const label = paths.length === 1 ? path.basename(paths[0]!) : `${paths.length} files`;
      this.capture.carry(grabbedAt, this.capture.now(), label);
    }
    this.logFocus("drag", zone, target);
  }

  /** The files as absolute paths (relative ones from the recording folder), checked. */
  private filePaths(files: Array<string>): Array<string> {
    if (files.length === 0) throw new Error("No files given.");
    const base = projectDirOf(this.testInfo.file);
    return files.map((file) => {
      const full = path.resolve(base, file);
      try {
        statSync(full);
      } catch {
        throw new Error(`File not found: ${file} (${full}).`);
      }
      return full;
    });
  }

  /** Opens the kit's file manager on the stage, listing the files. */
  private async showFileManager(
    stage: Page,
    paths: Array<string>,
    mode: "open" | "drag",
  ): Promise<void> {
    const spec = {
      mode,
      title: path.basename(path.dirname(paths[0]!)),
      files: paths.map((file) => {
        const stat = statSync(file);
        return { name: path.basename(file), size: stat.size, modified: stat.mtimeMs };
      }),
    };
    const page = pathToFileURL(path.join(import.meta.dirname, "stage", "files.html")).href;
    // In the query, not the hash: a new query loads the page again.
    await stage.goto(`${page}?${encodeURIComponent(JSON.stringify(spec))}`);
    await stage.locator("[data-file]").first().waitFor();
  }

  /** Selects the files in the file manager (Shift-click for more); returns where the last click was. */
  private async pickFiles(
    stage: Page,
    mouse: VirtualMouse,
    paths: Array<string>,
  ): Promise<Point> {
    let at = mouse.at;
    for (const [i, file] of paths.entries()) {
      at = await centreOf(stage.locator(`[data-file=${cssString(path.basename(file))}]`));
      await mouse.moveTo(at);
      await this.rest("aim", settings.aimMs);
      if (i === 0) await mouse.click(at);
      else await mouse.clickWith(at, [process.platform === "darwin" ? "Meta" : "Control"]);
    }
    return at;
  }

  /**
   * A control whose picker the browser draws outside the page: the cursor
   * goes to it and taps it (shown, not sent), the kit's stand-in appears,
   * the cursor clicks the entry, `set` sets the real value, the stand-in
   * goes. Test mode and preparation: `set` only.
   */
  private async pickWithStandIn(
    target: Locator,
    show: () => Promise<void>,
    entry: Locator,
    set: () => Promise<void>,
  ): Promise<void> {
    const mouse = this.liveMouse();
    const point = await this.pagePoint(target);
    if (!mouse) {
      await set();
      return;
    }
    await mouse.moveTo(point);
    await this.rest("aim", settings.aimMs);
    await mouse.tap(point);
    this.logFocus("click", target, point);
    try {
      await show();
      await this.click(entry);
      await set();
    } finally {
      await this.page.evaluate(removeStandIn).catch(() => {});
    }
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
    const fast = this.fastRecording && this.capture !== null;
    await this.page.keyboard.type(text, {
      delay: !this.paced ? 0 : fast ? FAST_TYPE_DELAY_MS : settings.typeDelay(delayMs),
    });
    if (this.paced && this.capture && startedMs !== undefined) {
      const endedMs = this.capture.now();
      const outMs = fast ? text.length * delayMs : endedMs - startedMs;
      this.capture.span("type", startedMs, endedMs, outMs);
    }
    if (this.capture && this.lastBox && !this.suspended) {
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

  /** Time since the recording started, time off camera left out (0 before it). */
  elapsedMs(): number {
    if (!this.live) return 0;
    const now = this.suspended ? this.suspendedAt : Date.now();
    return now - this.startedAt - this.offCameraMs;
  }

  /**
   * Takes what follows off camera, until `resume()`: actions run fast, as in
   * preparation, and the time is cut out of the video (the renderer joins
   * both sides with a short cross-fade). Used for `offCamera` steps.
   */
  suspend(): void {
    if (!this.live || this.suspended) return;
    this.suspended = true;
    this.suspendedAt = Date.now();
    this.capture?.pause();
  }

  /** Back on camera after `suspend()`. */
  resume(): void {
    if (!this.suspended) return;
    this.offCameraMs += Date.now() - this.suspendedAt;
    this.suspended = false;
    this.capture?.resume();
  }

  /**
   * Points the camera at an element without touching it: the video frames it
   * (zooms in, or moves a vertical crop there) and stays until the next
   * action. For what a step wants the viewer to look at, e.g. the cards a
   * dashboard opens with. It fills the frame. `transition` is how the camera
   * gets there (default: the scenario's showTransition, else "pan"). `ms`
   * also holds it for the viewer (video and rehearsal). In test mode it
   * checks the element is visible.
   */
  async show(
    target: Target,
    options: { ms?: number; transition?: ShowTransition } = {},
  ): Promise<void> {
    const point = await this.pagePoint(target);
    const startedMs = this.capture?.now();
    if (options.ms) await this.pause(options.ms);
    if (!this.paced || !this.capture) return;
    const box = isLocator(target) ? this.lastBox : undefined;
    const transition = options.transition ?? this.showTransition;
    this.capture.focus("show", point, box, startedMs, transition);
  }

  /**
   * @deprecated Does nothing: narration is fitted when rendering, and the
   * render report shows steps that run longer than their voice.
   */
  markOverrun(_ms: number): void {}

  /** A pause for the viewer. Skipped in test mode: never use it to wait for the app. */
  pause(ms = 1000): Promise<void> {
    return settings.pauses && this.paced
      ? this.rest("hold", ms)
      : Promise.resolve();
  }

  /**
   * A rest for the viewer: a pause ("hold") or the cursor resting on its
   * target ("aim"). Recording fast, only its head is spent (time for an
   * animation to finish); the renderer holds the frame for the rest. The
   * span records the full length either way.
   */
  private async rest(kind: "aim" | "hold", ms: number): Promise<void> {
    if (ms <= 0) return;
    const capture = this.paced ? this.capture : null;
    const head =
      capture && this.fastRecording
        ? Math.min(ms, kind === "aim" ? FAST_AIM_HEAD_MS : FAST_HOLD_HEAD_MS)
        : ms;
    const startedMs = capture?.now();
    await sleep(head);
    if (capture && startedMs !== undefined) {
      capture.span(kind, startedMs, capture.now(), ms);
    }
  }

  /** Holds the last frame, then stops the recording. */
  async finish(): Promise<void> {
    this.resume();
    if (this.live) await this.rest("hold", settings.endHoldMs);
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
      // With the video it belongs to (out of .results, which Playwright
      // empties on every run); a rehearsal's stays in .results.
      const file = this.capture
        ? path.join(this.captureRoot(), "steps.json")
        : this.testInfo.outputPath("steps.json");
      const scenario = path.basename(this.testInfo.file, ".spec.ts");
      writeFileSync(
        file,
        JSON.stringify(
          {
            scenario,
            captions: this.captions,
            compressWaits: this.compressWaits,
            format: this.format,
            ...(this.appAudio ? { appAudio: this.appAudio } : {}),
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

  /**
   * Video mode: .captures/<scenario>/ of the recording folder. Recording a
   * scenario again replaces its previous recording.
   */
  private captureRoot(): string {
    return captureRootFor(
      projectDirOf(this.testInfo.file),
      path.basename(this.testInfo.file, ".spec.ts"),
    );
  }

  /** The virtual cursor once recording runs; null = fast Playwright actions. */
  private liveMouse(): VirtualMouse | null {
    return this.paced ? this.mouse : null;
  }

  /**
   * Video mode records fast (settings.fastRecording), except with the app's
   * sound, which cannot be stretched: then at the viewer's pace.
   */
  private get fastRecording(): boolean {
    return settings.fastRecording && !this.appAudio;
  }

  private get aimMs(): number {
    return this.paced ? settings.aimMs : 0;
  }

  /** On camera: actions at a person's pace (video, rehearsal). */
  private get paced(): boolean {
    return this.live && !this.suspended;
  }

  /** Video mode: where the camera should look for this action. */
  private logFocus(
    kind: FocusKind,
    target: Target,
    point: Point,
    from?: number,
  ): void {
    if (!this.capture || this.suspended) return;
    // A spot inside a big element (e.g. the canvas) is not the element: zoom on the point.
    const box = isLocator(target) ? this.lastBox : undefined;
    this.capture.focus(kind, point, box, from);
  }

  /**
   * The target's point in page (CSS pixel) coordinates, once it is scrolled
   * into view, on screen, not covered by another element, not animating and
   * not moving. Waits up to ON_SCREEN_WAIT_MS for that (toasts go away,
   * dialogs finish opening), then fails the step: in every mode, so a test
   * run catches what would spoil the video.
   */
  private async pagePoint(target: Target): Promise<Point> {
    const locator = "in" in target ? target.in : target;
    const fx = "in" in target ? target.x : 0.5;
    const fy = "in" in target ? target.y : 0.5;
    const deadline = Date.now() + ON_SCREEN_WAIT_MS;

    // Lists re-render while they load (spinner -> empty state -> rows), so the
    // element found first can be replaced before we measure it. Find it again.
    for (let stale = 0; ; ) {
      // Not retried: an element that never shows up fails here, once.
      await locator.waitFor({ state: "visible" });
      let problem = "it has no size";
      try {
        await locator.scrollIntoViewIfNeeded({ timeout: 5_000 });
        const box = await locator.boundingBox({ timeout: 5_000 });
        if (box) {
          const point = {
            x: box.x + box.width * fx,
            y: box.y + box.height * fy,
          };
          problem = (await locator.evaluate(screenProblem, point)) ?? "";
          if (!problem) {
            // Two frames later it must still be where it was.
            await this.page.evaluate(
              () =>
                new Promise((done) =>
                  requestAnimationFrame(() => requestAnimationFrame(done)),
                ),
            );
            const again = await locator.boundingBox({ timeout: 5_000 });
            if (again && sameBox(box, again)) {
              this.lastBox = box;
              return point;
            }
            problem = "it is still moving";
          }
        }
      } catch (error) {
        if (++stale >= 5 || !isStaleElementError(error)) throw error;
        problem = "it was replaced while being measured";
      }
      if (Date.now() > deadline) {
        throw new Error(
          `${locator.toString()} cannot be shown: ${problem}. ` +
            "Wait for it in the helper before acting on it (an expect on what " +
            "covers it or on the finished screen).",
        );
      }
      await sleep(200);
    }
  }
}

function sameBox(a: Box, b: Box): boolean {
  return (
    Math.abs(a.x - b.x) < 1 &&
    Math.abs(a.y - b.y) < 1 &&
    Math.abs(a.width - b.width) < 1 &&
    Math.abs(a.height - b.height) < 1
  );
}

function isStaleElementError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not attached|detached|not stable|Timeout \d+ms exceeded/i.test(
    message,
  );
}

/** The centre of an element on its page (CSS pixels). */
async function centreOf(locator: Locator): Promise<Point> {
  await locator.waitFor({ state: "visible" });
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${locator.toString()} has no size.`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A file's type from its name, as a browser would guess it. */
function mimeType(file: string): string {
  const types: Record<string, string> = {
    csv: "text/csv",
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json",
    pdf: "application/pdf",
    zip: "application/zip",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  return types[path.extname(file).slice(1).toLowerCase()] ?? "application/octet-stream";
}

/** A CSS string literal (attribute selectors) for any text. */
function cssString(text: string): string {
  return `"${text.replace(/["\\]/g, "\\$&").replace(/\n/g, "\\a ")}"`;
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
    rec.watchDialogs();
    await provide(rec);
    await rec.finish();
  },
});

export { expect } from "@playwright/test";
