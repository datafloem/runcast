import {
  test as base,
  type Dialog,
  type Download,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
import { showFile } from "./file-viewer.ts";
import {
  PERMISSION_BINDING,
  permissionDecisions,
  wrapPermissions,
  type PermissionDecision,
  type PermissionsOption,
} from "./permissions.ts";
import { captureRootFor } from "./project.ts";
import type { ShowTransition, VideoCard } from "./scenario.ts";
import type {
  Box,
  Capture,
  FocusKind,
  ScenePlaceholder,
  SourceSwitch,
} from "./capture-log.ts";
import { blockNetwork, sizeWindow, TabCapture } from "./tab-capture.ts";
import { fitWindow, VideoCapture } from "./video-capture.ts";
import { VirtualMouse } from "./virtual-mouse.ts";

/** Recording fast (Recorder.fastRecording): real time spent of a viewer pause... */
const FAST_HOLD_HEAD_MS = 300;
/** ...of the cursor's rest on a target (hover states need it)... */
const FAST_AIM_HEAD_MS = 150;
/** ...and per typed character (one frame at 30 fps, so typing stretches cleanly). */
const FAST_TYPE_DELAY_MS = 40;

/** Recording fast, the gap between the two screenshots that tell whether the page still changes. */
const CHANGE_PROBE_MS = 150;

/** How long rec.download waits for the download to start. */
const DOWNLOAD_WAIT_MS = 15_000;

/** How long rec.download({ open: true }) shows the file on the stage. */
const OPEN_FILE_MS = 3_000;

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
  /** Exact start on the capture clock (ms); `seconds` is rounded to 0.1 s. */
  startMs: number;
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
   * `rec` action that opens it. `text` answers a prompt. If that action
   * opens no dialog, the answer lapses (with a warning) instead of
   * answering a later, unrelated one.
   */
  onDialog(answer: { accept: boolean; text?: string }): void {
    this.nextDialog = answer;
  }

  /** Values typed with typeSecret: kept out of failure reports. */
  private readonly secrets = new Set<string>();

  /** Nesting of rec actions (an action may use others, e.g. select → click). */
  private actionDepth = 0;

  /**
   * Runs one rec action. A pending onDialog answer that was there before
   * the action and is still unused after it lapses.
   */
  private async act<T>(fn: () => Promise<T>): Promise<T> {
    const outer = this.actionDepth === 0;
    const pending = outer ? this.nextDialog : null;
    this.actionDepth++;
    try {
      return await fn();
    } finally {
      this.actionDepth--;
      if (pending && this.nextDialog === pending) {
        this.nextDialog = null;
        console.warn(
          "rec.onDialog: the next action opened no dialog, so its answer was dropped. Call it right before the action that opens the dialog.",
        );
      }
    }
  }

  /**
   * Answers the page's dialogs from now on (the rec fixture does this, in
   * every mode). On camera in video mode each one is logged, and the video
   * holds the frame and draws it being answered.
   */
  watchDialogs(): void {
    this.page.on("dialog", (dialog) => void this.answerDialog(dialog));
  }

  /** The scenario's answer per permission (usePermissions). */
  private permissionAnswers: Record<string, PermissionDecision> = {};
  /** Permissions the page already asked for, per origin: Chrome asks once. */
  private permissionsAsked = new Set<string>();

  /**
   * Decides the page's permissions before its first load (the scenario's
   * `permissions`): allowed ones are granted, blocked ones fail as Chrome
   * fails them, so nothing ever waits on a prompt. The first request per
   * permission and origin is logged on camera as a "permission" dialog,
   * which the video draws as Chrome's prompt being answered.
   */
  async usePermissions(option: PermissionsOption): Promise<void> {
    const answers = permissionDecisions(option);
    if (Object.keys(answers).length === 0) return;
    this.permissionAnswers = answers;
    const allowed = Object.keys(answers).filter((name) => answers[name] === "allow");
    if (allowed.length) await this.page.context().grantPermissions(allowed);
    await this.page.exposeBinding(PERMISSION_BINDING, (source, names: Array<string>) => {
      let origin = "";
      try {
        origin = new URL(source.frame.url()).host;
      } catch {
        origin = "";
      }
      this.permissionAsked(names, origin);
    });
    await this.page.addInitScript(wrapPermissions, answers);
  }

  private permissionAsked(names: Array<string>, origin: string): void {
    const fresh = names.filter(
      (name) => this.permissionAnswers[name] && !this.permissionsAsked.has(`${origin} ${name}`),
    );
    if (fresh.length === 0) return;
    for (const name of fresh) this.permissionsAsked.add(`${origin} ${name}`);
    if (!this.capture || !this.paced || this.suspended) return;
    const allowed = fresh.every((name) => this.permissionAnswers[name] === "allow");
    this.capture.dialog("permission", fresh.join(","), allowed, undefined, origin || undefined);
  }

  private async answerDialog(dialog: Dialog): Promise<void> {
    // On camera, logged with the time it opened, once its answer is known.
    const capture = this.capture && this.paced ? this.capture : null;
    const at = capture?.now();
    let origin: string | undefined;
    try {
      origin = new URL(this.page.url()).host || undefined;
    } catch {
      origin = undefined;
    }
    const log = (accepted: boolean, text?: string) =>
      capture?.dialog(dialog.type(), dialog.message(), accepted, text, origin, at);

    // The step listens for dialogs itself (page.on / once / waitForEvent):
    // it answers, and the video shows what it answered.
    const listeners = (this.page as unknown as { listenerCount(event: string): number })
      .listenerCount("dialog");
    if (listeners > 1) {
      const accept = dialog.accept.bind(dialog);
      const dismiss = dialog.dismiss.bind(dialog);
      dialog.accept = (text?: string) => {
        log(true, dialog.type() === "prompt" ? (text ?? dialog.defaultValue()) : undefined);
        return accept(text);
      };
      dialog.dismiss = () => {
        log(false);
        return dismiss();
      };
      return;
    }

    const answer = this.nextDialog ?? { accept: this.dialogs === "accept" };
    this.nextDialog = null;
    const text = dialog.type() === "prompt" && answer.accept
      ? (answer.text ?? dialog.defaultValue())
      : undefined;
    log(answer.accept, text);
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
    /**
     * cursor: false hides the cursor while the stage shows (a scene).
     * prepare loads what the stage shows before the video changes to it, so
     * the transition never shows the stage's previous page.
     */
    options: { cursor?: boolean; prepare?: (stage: Page) => Promise<void> } = {},
  ): Promise<T> {
    const app = this.liveMouse();
    if (!app) throw new Error("rec.onStage runs on camera only (video and rehearsal).");
    const stage = await this.stagePage();
    this.stageMouse ??= new VirtualMouse(stage, this.capture, app.at, this.fastRecording);
    this.stageMouse.place(app.at);
    if (options.prepare) {
      await options.prepare(stage);
      // In the stage's recording before the video turns to it.
      if (this.capture instanceof TabCapture && !this.suspended) {
        await this.capture.stageFrameAfter(Date.now());
      }
    }
    this.switchTo("stage", transition, options.cursor ?? true);
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
    cursor = true,
  ): void {
    if (this.capture instanceof TabCapture && !this.suspended) {
      this.capture.source(source, transition, cursor);
    }
  }

  /**
   * Runs `fn` and lets what it shows play at its real speed in the video:
   * never sped up or shortened (an animation, a scene). Logged as a stretch
   * whose video length is its own.
   */
  async realTime<T>(fn: () => Promise<T>): Promise<T> {
    const capture = this.paced ? this.capture : null;
    const from = capture?.now();
    try {
      return await fn();
    } finally {
      if (capture && from !== undefined) {
        const to = capture.now();
        capture.span("hold", from, to, to - from);
      }
    }
  }

  /** The recording folder of this test's scenario. */
  get projectDir(): string {
    return projectDirOf(this.testInfo.file);
  }

  /**
   * A scene the renderer adds here (steps.scene, render-time): logged in the
   * capture (video mode), its beats marked as steps `<id>.<beat id>`, and its
   * length added to the clock without waiting (rehearsal counts it too).
   */
  scenePlaceholder(
    step: { id: string; title: string },
    placeholder: Omit<ScenePlaceholder, "t">,
  ): void {
    if (!this.onCamera) return;
    const at = this.elapsedMs();
    this.capture?.scene({ ...placeholder, step: step.id, title: step.title });
    for (const beat of placeholder.beats) {
      this.markAt(at + beat.at, `${step.title} › ${beat.id}`, `${step.id}.${beat.id}`);
    }
    this.offCameraMs -= placeholder.duration;
  }

  /** A step mark at `ms` on the recording's clock (see step). */
  private markAt(ms: number, title: string, id: string): void {
    const seconds = ms / 1000;
    const at = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(
      Math.floor(seconds % 60),
    ).padStart(2, "0")}`;
    this.steps.push({ id, at, seconds: Math.round(seconds * 10) / 10, startMs: Math.round(ms), title });
    console.log(`[${at}] ${title}`);
  }

  /** On camera: recording runs at a person's pace (video, rehearsal), not off camera. */
  get onCamera(): boolean {
    return this.liveMouse() !== null;
  }

  /** Whether a stage tab can be shown: rehearsal, or video with tab capture. */
  private get hasStage(): boolean {
    return !isVideoMode || (this.capture instanceof TabCapture && this.capture.stage !== null);
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
      await blockNetwork(this.rehearsalStage);
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
    extra: {
      id?: string;
      transition?: string;
      /**
       * @deprecated Ignored: narration is fitted when rendering, from the
       * scenario's narration file. Accepted so older helpers still compile.
       */
      narration?: unknown;
    } = {},
  ): Promise<void> {
    if (!this.live) {
      console.log(`(preparation) ${title}`);
      return Promise.resolve();
    }
    const elapsed = this.elapsedMs();
    const seconds = elapsed / 1000;
    const at = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(
      Math.floor(seconds % 60),
    ).padStart(2, "0")}`;
    this.steps.push({
      id: extra.id,
      at,
      seconds: Math.round(seconds * 10) / 10,
      startMs: Math.round(elapsed),
      title,
      note,
      transition: extra.transition,
    });
    console.log(`[${at}] ${title}${note ? ` — ${note}` : ""}`);
    return Promise.resolve();
  }

  hover(target: Target): Promise<void> {
    return this.act(async () => {
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
    });
  }

  click(target: Target): Promise<void> {
    return this.act(async () => {
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
    });
  }

  doubleClick(target: Target): Promise<void> {
    return this.act(async () => {
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
    });
  }

  rightClick(target: Target): Promise<void> {
    return this.act(async () => {
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
    });
  }

  /** Drags from one element to another, e.g. a card to another column. */
  drag(from: Target, to: Target): Promise<void> {
    return this.act(async () => {
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
    });
  }

  /**
   * Picks an option of a native <select> by its label. Never click a select
   * yourself: its list is drawn by the browser outside the page. In video
   * and rehearsal the kit draws the list under the select, the cursor
   * clicks the option, then the value is set (selectOption) and the list
   * goes. Test mode: selectOption only.
   */
  select(target: Locator, label: string): Promise<void> {
    return this.act(async () => {
      await this.pickWithStandIn(
        target,
        () => target.evaluate(showOptions),
        this.page.locator(`[data-runcast-ui] [data-label=${cssString(label)}]`),
        () => target.selectOption({ label }).then(() => undefined),
      );
    });
  }

  /**
   * Sets a date input to `value` (YYYY-MM-DD; a datetime-local input takes
   * YYYY-MM-DDTHH:MM). In video and rehearsal the kit draws a month grid
   * under the field and the cursor clicks the day, then the value is set
   * (fill); a text field is typed into. Time, month and week inputs fail
   * with a clear message. Test mode: fill.
   */
  pickDate(target: Locator, value: string): Promise<void> {
    return this.act(async () => {
      const type = (await target.getAttribute("type")) ?? "text";
      if (["time", "month", "week"].includes(type)) {
        throw new Error(
          `rec.pickDate sets dates; ${target.toString()} is a ${type} input, which it cannot pick. ` +
            "Use a date or datetime-local input, or a text field with rec.type.",
        );
      }
      const pattern =
        type === "datetime-local" ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/;
      if (!pattern.test(value)) {
        throw new Error(
          `rec.pickDate: "${value}" is not ${type === "datetime-local" ? "a date and time (YYYY-MM-DDTHH:MM)" : "a date (YYYY-MM-DD)"}.`,
        );
      }
      if (type !== "date" && type !== "datetime-local") {
        await this.type(target, value);
        return;
      }
      // datetime-local: the day is picked in the month grid, the time set with it.
      const day = value.slice(0, 10);
      await this.pickWithStandIn(
        target,
        () => target.evaluate(showMonth, day),
        this.page.locator(`[data-runcast-ui] [data-day="${Number(day.slice(8))}"]`),
        () => target.fill(value),
      );
    });
  }

  /**
   * Uploads files through the app's file chooser: clicking `trigger` opens
   * it. In video and rehearsal the stage shows a file manager with the
   * files, the cursor picks them and clicks Open, and the video goes back to
   * the app (`transition`, default "fade"); then the chooser gets the files.
   * Test mode: the trigger is clicked and the files are set. Relative paths
   * are from the recording folder.
   */
  chooseFiles(
    trigger: Target,
    files: Array<string>,
    options: { transition?: SourceSwitch["transition"] } = {},
  ): Promise<void> {
    return this.act(async () => {
      const paths = this.filePaths(files);
      const chooserOpens = this.page.waitForEvent("filechooser", { timeout: 15_000 });
      await this.click(trigger);
      const chooser = await chooserOpens;
      if (paths.length > 1 && !chooser.isMultiple()) {
        throw new Error(
          `rec.chooseFiles: the file chooser takes one file, ${paths.length} were given.`,
        );
      }
      // Screen capture has no stage: the click is shown, the files are set.
      if (this.liveMouse() && this.hasStage) {
        await this.onStage(
          async (stage, mouse) => {
            await this.pickFiles(stage, mouse, paths);
            const open = stage.locator('[data-action="open"]');
            await mouse.moveTo(await centreOf(open));
            await this.rest("aim", settings.aimMs);
            await mouse.click(await centreOf(open));
            await sleep(150);
          },
          options.transition ?? "fade",
          options.transition ?? "fade",
          { prepare: (stage) => this.showFileManager(stage, paths, "open") },
        );
      }
      await chooser.setFiles(paths);
    });
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
  dropFiles(
    zone: Locator,
    files: Array<string>,
    options: { transition?: SourceSwitch["transition"] } = {},
  ): Promise<void> {
    return this.act(async () => {
      const paths = this.filePaths(files);
      const payload = paths.map((file) => ({
        name: path.basename(file),
        type: mimeType(file),
        base64: readFileSync(file).toString("base64"),
      }));
      // A zone that never calls preventDefault on dragover drops nothing in
      // a real browser either: usually the selector points elsewhere.
      let accepted = false;
      const send = async (
        type: "dragenter" | "dragover" | "drop",
        at: Point,
        withFiles: boolean,
      ) => {
        const prevented = await this.page.evaluate(dispatchDrag, {
          type,
          x: at.x,
          y: at.y,
          ...(withFiles ? { files: payload } : {}),
        });
        if (type === "dragover" && prevented) accepted = true;
      };
      const warnIfRefused = () => {
        if (accepted) return;
        console.warn(
          `rec.dropFiles: ${zone.toString()} never accepted the drag (no preventDefault on dragover), ` +
            "so a browser would not drop there. Check that the locator is the drop zone.",
        );
      };

      const mouse = this.liveMouse();
      if (!mouse) {
        const at = await this.pagePoint(zone);
        await send("dragenter", at, true);
        await send("dragover", at, false);
        await send("drop", at, false);
        warnIfRefused();
        return;
      }

      await this.pagePoint(zone); // the zone must be ready before the files are picked
      let grabbedAt = 0;
      if (this.hasStage) {
        let stageMouse: VirtualMouse | null = null;
        await this.onStage(
          async (stage, cursor) => {
            const last = await this.pickFiles(stage, cursor, paths);
            await cursor.down(last);
            grabbedAt = this.capture?.now() ?? 0;
            await sleep(150);
            stageMouse = cursor;
          },
          "fade",
          options.transition ?? "lift",
          { prepare: (stage) => this.showFileManager(stage, paths, "drag") },
        );
        // The press stays on the stage; let go there quietly.
        await (stageMouse as VirtualMouse | null)?.release().catch(() => {});
      }
      // Screen capture has no stage: the cursor carries the files from where it is.
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
      warnIfRefused();
      if (this.capture instanceof TabCapture && !this.suspended) {
        const label = paths.length === 1 ? path.basename(paths[0]!) : `${paths.length} files`;
        this.capture.carry(grabbedAt, this.capture.now(), label);
      }
      this.logFocus("drag", zone, target);
    });
  }

  /**
   * Clicks `target` and saves the file the page downloads; returns its path,
   * so the scenario can check what is in it. Saved with the take
   * (.captures/<scenario>/downloads/) once the video records, otherwise in
   * the test's output folder. On camera the video shows the browser's
   * download bubble; `open` then shows the file on the stage tab (a table,
   * text, picture or PDF; other files as their icon, name and size) for
   * `open.ms` (default 3 s), reached and left with "lift".
   */
  download(
    target: Target,
    options: { open?: boolean | { ms?: number }; timeoutMs?: number } = {},
  ): Promise<string> {
    return this.act(async () => {
      const timeout = options.timeoutMs ?? DOWNLOAD_WAIT_MS;
      const starts = this.page.waitForEvent("download", { timeout });
      starts.catch(() => {});
      await this.click(target);
      let download: Download;
      try {
        download = await starts;
      } catch {
        const name = "in" in target ? target.in.toString() : target.toString();
        throw new Error(`rec.download: clicking ${name} started no download within ${timeout / 1000} s.`);
      }
      const name = path.basename(download.suggestedFilename()) || "download";
      const dir = this.capture
        ? path.join(this.captureRoot(), "downloads")
        : this.testInfo.outputPath("downloads");
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, name);
      await download.saveAs(file);
      // Playwright's own copy, kept until the browser closes otherwise.
      await download.delete().catch(() => {});
      if (this.capture && this.paced && !this.suspended) {
        this.capture.download(name, statSync(file).size);
      }
      if (options.open) {
        const ms = typeof options.open === "object" ? (options.open.ms ?? OPEN_FILE_MS) : OPEN_FILE_MS;
        await this.openDownload(file, ms);
      }
      return file;
    });
  }

  /** On camera, shows a downloaded file on the stage tab for `ms`. */
  private async openDownload(file: string, ms: number): Promise<void> {
    if (!this.liveMouse()) return;
    if (!this.hasStage) {
      console.warn(
        `rec.download: { open } shows the file on the stage tab, which screen capture does not have; ${path.basename(file)} is not shown.`,
      );
      return;
    }
    // A moment for the bubble before the video turns to the file.
    await this.pause(800);
    await this.onStage(() => this.pause(ms), "lift", "lift", {
      cursor: false,
      prepare: (stage) => showFile(stage, file),
    });
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

  /** Selects the files in the file manager (Ctrl/Cmd-click for each further one); returns where the last click was. */
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
  type(target: Target, text: string, delayMs = 60): Promise<void> {
    return this.act(async () => {
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
    });
  }

  /** Same as `type`, for secrets: kept out of Playwright's step log. */
  typeSecret(target: Locator, text: string): Promise<void> {
    return this.act(async () => {
      if (text.length >= 3) this.secrets.add(text);
      await this.click(target);
      // Set in the page, not typed or filled: Playwright's action log (and
      // its traces) record what fill and the keyboard send. The field is
      // marked: blurred on screen, emptied before a failure is reported.
      await target.evaluate((el, value) => {
        const field = el as HTMLInputElement;
        const own = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value");
        (own?.set ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!).call(
          field,
          value,
        );
        field.setAttribute("data-rec-secret", "");
        if (!document.getElementById("rec-secret-style")) {
          const style = document.createElement("style");
          style.id = "rec-secret-style";
          style.textContent = '[data-rec-secret]:not([type="password"]) { filter: blur(6px) !important; }';
          document.head.append(style);
        }
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
      }, text);
    });
  }

  /**
   * Empties password fields and fields filled with typeSecret, in every
   * frame: run before a failed test's page snapshot, screenshot and error
   * context are written, so no secret ends up in them.
   */
  async forgetSecrets(): Promise<void> {
    for (const frame of this.page.frames()) {
      // Nothing comes back: Playwright's trace records what evaluate returns.
      await frame
        .evaluate(() => {
          for (const field of Array.from(
            document.querySelectorAll('input[type="password"], [data-rec-secret]'),
          ) as Array<HTMLInputElement>) {
            field.value = "";
          }
        })
        .catch(() => {});
    }
  }

  /**
   * Replaces every secret in a failed test's errors (messages, and the page
   * snapshot a failed expect takes) before Playwright writes them to
   * error-context.md, the report and the trace.
   */
  scrubErrors(errors: Array<{ message?: string; stack?: string; errorContext?: string }>): void {
    if (this.secrets.size === 0) return;
    const scrub = (text: string | undefined) => {
      if (text === undefined) return text;
      let out = text;
      for (const secret of this.secrets) out = out.split(secret).join("•••••");
      return out;
    };
    for (const error of errors) {
      error.message = scrub(error.message);
      error.stack = scrub(error.stack);
      if (error.errorContext !== undefined) error.errorContext = scrub(error.errorContext);
    }
  }

  /**
   * How long the video is so far: elapsedMs plus what the video adds to a
   * fast recording (pauses and cursor rests recorded short, fast moves).
   */
  videoElapsedMs(): number {
    return this.elapsedMs() + (this.capture?.stretchMs ?? 0);
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

  /**
   * A pause for the viewer. Skipped in test mode: never use it to wait for
   * the app. Recording fast, only its head is recorded and the renderer holds
   * the last frame; if the page is still changing then (an animation, a
   * video, a canvas), it is recorded in real time instead, with a warning.
   * `live: true` is rec.watch(ms).
   */
  pause(ms = 1000, options: { live?: boolean } = {}): Promise<void> {
    if (options.live) return this.watch(ms);
    return settings.pauses && this.paced
      ? this.rest("hold", ms)
      : Promise.resolve();
  }

  /**
   * A pause for the viewer while something on the page moves (an animation,
   * a video, a scene in the app): always recorded in real time, never held.
   * Skipped in test mode, like rec.pause.
   */
  watch(ms = 1000): Promise<void> {
    if (!(settings.pauses && this.paced) || ms <= 0) return Promise.resolve();
    return this.realTime(() => sleep(ms));
  }

  /**
   * What still changes on the page, or null: a running animation, a playing
   * video or sound, or (canvas, script-driven motion) two screenshots that
   * differ. The text caret is left out of the screenshots.
   */
  private async pageChange(): Promise<string | null> {
    const reason = await this.page
      .evaluate(() => {
        if (document.getAnimations().some((a) => a.playState === "running")) {
          return "an animation is running";
        }
        const media = Array.from(document.querySelectorAll("video, audio")) as Array<HTMLMediaElement>;
        if (media.some((m) => !m.paused && !m.ended)) return "a video or sound is playing";
        return null;
      })
      .catch(() => null);
    if (reason) return reason;
    try {
      const shot = () => this.page.screenshot({ type: "jpeg", quality: 40, scale: "css", caret: "hide" });
      const first = await shot();
      await sleep(CHANGE_PROBE_MS);
      const second = await shot();
      return first.equals(second) ? null : "the picture keeps changing";
    } catch {
      return null;
    }
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
    let head =
      capture && this.fastRecording
        ? Math.min(ms, kind === "aim" ? FAST_AIM_HEAD_MS : FAST_HOLD_HEAD_MS)
        : ms;
    const startedMs = capture?.now();
    // A held frame would freeze what still moves: record the pause live.
    if (capture && kind === "hold" && head < ms) {
      const change = await this.pageChange();
      if (change) {
        head = ms;
        const step = this.steps.at(-1)?.title ?? "before the first step";
        console.warn(
          `rec.pause(${ms}) in "${step}": the page is still changing (${change}), so it was recorded ` +
            "in real time instead of held. Use rec.watch(ms) for pauses that show something moving.",
        );
      }
    }
    const spent = capture && startedMs !== undefined ? capture.now() - startedMs : 0;
    await sleep(Math.max(0, head - spent));
    if (capture && startedMs !== undefined) {
      capture.span(kind, startedMs, capture.now(), ms);
    }
  }

  /** Holds the last frame, then stops the recording. */
  async finish(): Promise<void> {
    this.resume();
    if (this.live) await this.rest("hold", settings.endHoldMs);
    // A recording that stopped mid-way fails the test, after its step times
    // are written: what was recorded still renders.
    let stopError: unknown = null;
    if (this.capture) {
      try {
        const file = await this.capture.stop();
        console.log(`Video capture: ${path.dirname(file)}`);
      } catch (error) {
        stopError = error;
      }
    }
    if (this.steps.length > 0) {
      const endSeconds = this.elapsedMs() / 1000;
      this.steps.forEach((mark, i) => {
        const next = this.steps[i + 1]?.startMs ?? endSeconds * 1000;
        mark.durationMs = Math.round(next - mark.startMs);
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
    if (stopError) throw stopError;
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
    let centreNext = false;
    for (let stale = 0; ; ) {
      // Not retried: an element that never shows up fails here, once.
      await locator.waitFor({ state: "visible" });
      let problem = "it has no size";
      try {
        // Plain scrolling: Playwright's scrollIntoViewIfNeeded waits for a
        // box that stays exactly put, which a sub-pixel jitter never does.
        await locator.evaluate(
          (el, centre) =>
            el.scrollIntoView(
              centre
                ? { block: "center", inline: "center" }
                : { block: "nearest", inline: "nearest" },
            ),
          centreNext,
          { timeout: 5_000 },
        );
        centreNext = false;
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
            problem = again ? `it is still moving: ${describeMove(box, again)}` : "it is still moving";
          } else if (problem.startsWith("it is covered")) {
            // A sticky header or footer of its scroll box: bring it to the
            // middle of its scroll container, then look again.
            centreNext = true;
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

/**
 * Whether two boxes are the same place, to the whole pixel: a page drawn at a
 * fractional scale jitters below a pixel (and by one at a rounding edge).
 */
function sameBox(a: Box, b: Box): boolean {
  return (
    Math.abs(a.x - b.x) <= 1 &&
    Math.abs(a.y - b.y) <= 1 &&
    Math.abs(a.width - b.width) <= 1 &&
    Math.abs(a.height - b.height) <= 1
  );
}

/** How a box moved between two frames, for the "still moving" message. */
function describeMove(a: Box, b: Box): string {
  const f = (n: number) => String(Math.round(n * 10) / 10);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const size =
    Math.abs(b.width - a.width) > 1 || Math.abs(b.height - a.height) > 1
      ? `, size ${f(a.width)}x${f(a.height)} → ${f(b.width)}x${f(b.height)}`
      : "";
  return `it moved ${f(Math.hypot(dx, dy))} px in two frames (x ${f(a.x)} → ${f(b.x)}, y ${f(a.y)} → ${f(b.y)}${size})`;
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
    // Before Playwright snapshots the failed page and writes its error context.
    if (testInfo.status !== testInfo.expectedStatus) {
      await rec.forgetSecrets();
      rec.scrubErrors(testInfo.errors as Array<{ message?: string; stack?: string; errorContext?: string }>);
    }
    await rec.finish();
  },
});

export { expect } from "@playwright/test";
