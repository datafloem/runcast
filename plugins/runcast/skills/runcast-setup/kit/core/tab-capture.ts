// Tab capture (REC_CAPTURE=tab, the default): video mode records the app's tab
// in a headless Chrome instead of the screen.
import type { Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CaptureLog,
  type Box,
  type Capture,
  type FocusKind,
  type PointerKind,
  type ScenePlaceholder,
  type SourceSwitch,
  type SpanKind,
} from "./capture-log.ts";
import { sleep, type Point } from "./cursor.ts";

/** How often sizeWindow sets the window before giving up. */
const SIZE_TRIES = 10;
/** The start of the title marker Chrome picks the captured tab by. */
const MARKER = "RUNCAST-";
/** How long the capture may take to start before the one retry. */
const START_TIMEOUT_MS = 5_000;
/** Recording bit rate: high, so the renderer's zoom has detail to show. */
const BITS_PER_SECOND = 25_000_000;
/**
 * How much later the app's sound reaches the recording than the page plays
 * it (Chrome's audio output and capture), measured: 90-135 ms.
 */
const APP_AUDIO_DELAY_MS = 100;
/** How long the recorder may take to hand over its last chunk. */
const STOP_TIMEOUT_MS = 15_000;

/**
 * Chrome flags tab capture needs: getDisplayMedia picks the tab whose title
 * holds the marker, without a picker.
 */
export const TAB_CAPTURE_ARGS: ReadonlyArray<string> = [
  `--auto-select-tab-capture-source-by-title=${MARKER}`,
  // The app's sound plays without a click first (games, media).
  "--autoplay-policy=no-user-gesture-required",
];

/**
 * Keeps a kit page (the stage, a scene) off the network: every http(s) and
 * ws(s) request it makes fails. Local files still load.
 */
export async function blockNetwork(page: Page): Promise<void> {
  await page.route(/^(https?|wss?):/i, (route) => route.abort());
}

/**
 * The Playwright channel tab capture records with (REC_CHANNEL): Google
 * Chrome by default; "chromium" is Playwright's full Chromium in its new
 * headless mode. Never the headless shell Playwright picks for headless
 * Chromium without a channel: it has no tab capture.
 */
export function captureChannel(setting = process.env.REC_CHANNEL): string {
  return setting && setting !== "" ? setting : "chrome";
}

/**
 * Playwright flags tab capture leaves out: muted, a tab gives no sound to
 * capture. The capture keeps it off the speakers (suppressLocalAudioPlayback).
 */
export const TAB_CAPTURE_IGNORED_ARGS: ReadonlyArray<string> = ["--mute-audio"];

/**
 * Sizes the real browser window so the page inside it is exactly `size`
 * (CSS pixels). Tab capture records the window's surface, so there is no
 * viewport emulation (`viewport: null`); headless Chrome keeps some browser
 * UI around the page, which is measured and added. Fails naming both sizes
 * when the page never reaches it.
 */
export async function sizeWindow(
  page: Page,
  size: { width: number; height: number },
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "normal" },
    });
    let inner = { width: 0, height: 0 };
    for (let i = 0; i < SIZE_TRIES; i++) {
      const now = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
        frameWidth: window.outerWidth - window.innerWidth,
        frameHeight: window.outerHeight - window.innerHeight,
      }));
      inner = { width: now.width, height: now.height };
      if (now.width === size.width && now.height === size.height) return;
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: {
          width: size.width + now.frameWidth,
          height: size.height + now.frameHeight,
        },
      });
      await sleep(100);
    }
    throw new Error(
      `The browser window could not be sized: the page should be ${size.width}x${size.height} ` +
        `but is ${inner.width}x${inner.height}.`,
    );
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** What the recorder page's startCapture resolves with. */
interface Started {
  mime: string;
  startWall: number;
  audioTracks: number;
  audioSettings: Record<string, unknown> | null;
}

/**
 * Video mode, REC_CAPTURE=tab: a recorder tab (core/recorder.html) records
 * the app's tab with getDisplayMedia and MediaRecorder; the chunks come
 * back through an exposed function and are appended to
 * <dir>/screen.mp4 (or .webm). Nothing shows on screen, the real cursor is
 * never in it (the renderer draws its own), and the frames are the page at
 * `scale` (2880x1620 for a 1920x1080 page at 1.5).
 */
export class TabCapture implements Capture {
  private readonly log: CaptureLog;
  private recorder: Page | null = null;
  /**
   * The stage: a second recorded tab of the same size for what the app's tab
   * cannot show (a file manager, a drag source, a scene). Blank and still
   * between staged steps.
   */
  stage: Page | null = null;
  /** Wall-clock time of the stage file's first frame. */
  private stageWall = NaN;
  /** Wall-clock time of the file's first frame (until stop: the recorder's start). */
  private startWall = NaN;
  /** Files the chunks went to, by stream name. */
  private readonly files = new Map<string, string>();
  /** Last info from the recorder page (tests read the audio settings). */
  started: Started | null = null;

  private readonly page: Page;
  /** Output folder: .captures/<scenario>/capture of the recording folder. */
  readonly dir: string;
  private readonly options: { scale: number; audio?: boolean; stage?: boolean };

  constructor(
    page: Page,
    dir: string,
    scenario: string,
    /** `stage` (default true): also open and record the stage tab. */
    options: { scale: number; audio?: boolean; stage?: boolean },
  ) {
    this.page = page;
    this.dir = dir;
    this.options = options;
    this.log = new CaptureLog(scenario);
  }

  private get data() {
    return this.log.data;
  }

  async start(): Promise<{
    viewport: { width: number; height: number };
    startedAt: number;
  }> {
    mkdirSync(this.dir, { recursive: true });
    const viewport = await this.page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    const { scale } = this.options;
    this.data.viewport = viewport;
    this.data.scale = scale;
    this.data.video.width = Math.round(viewport.width * scale);
    this.data.video.height = Math.round(viewport.height * scale);

    if (this.options.stage !== false) {
      this.stage = await this.page.context().newPage();
      await blockNetwork(this.stage);
      await sizeWindow(this.stage, viewport);
      await this.stage.goto(
        pathToFileURL(path.join(import.meta.dirname, "stage", "blank.html")).href,
      );
    }

    let error: unknown;
    for (let attempt = 0; attempt < 2 && !this.started; attempt++) {
      try {
        this.started = await this.startOnce();
      } catch (caught) {
        error = caught;
        await this.recorder?.close().catch(() => {});
        this.recorder = null;
        // What that attempt recorded goes: the next one starts new files.
        for (const file of this.files.values()) rmSync(file, { force: true });
        this.files.clear();
      }
    }
    if (!this.started) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Chrome could not record the app's tab: ${reason}. Update Chrome, or record the screen instead (REC_CAPTURE=screen).`,
      );
    }
    this.startWall = this.started.startWall;
    const extension = this.started.mime.startsWith("video/mp4") ? "mp4" : "webm";
    this.data.video.file = `screen.${extension}`;
    this.log.attach(this.page);
    this.log.startedAt = Date.now();
    return { viewport, startedAt: this.log.startedAt };
  }

  /** Opens the recorder tab and starts recording the app's tab, then the stage's. */
  private async startOnce(): Promise<Started> {
    const recorder = await this.page.context().newPage();
    this.recorder = recorder;
    await recorder.exposeFunction(
      "__runcastChunk",
      (name: string, base64: string, extension: string) => {
        let file = this.files.get(name);
        if (!file) {
          file = path.join(this.dir, `${name}.${extension}`);
          rmSync(file, { force: true });
          this.files.set(name, file);
        }
        appendFileSync(file, Buffer.from(base64, "base64"));
      },
    );
    await recorder.goto(pathToFileURL(path.join(import.meta.dirname, "recorder.html")).href);
    const started = await this.captureTab(recorder, this.page, "screen", this.options.audio ?? false);
    if (this.stage) await this.captureTab(recorder, this.stage, "stage", false);
    return started;
  }

  /**
   * Starts recording one tab: the marker goes into its title (and only its),
   * the recorder comes to the front to ask for it, then the app's tab is
   * fronted again.
   */
  private async captureTab(
    recorder: Page,
    tab: Page,
    name: string,
    audio: boolean,
  ): Promise<Started> {
    const marker = `${MARKER}${randomBytes(6).toString("hex")}`;
    await tab.evaluate(markTitle, marker);
    try {
      // getDisplayMedia only works from the tab in front.
      await recorder.bringToFront();
      const target = {
        name,
        width: this.data.video.width,
        height: this.data.video.height,
        audio,
        bitsPerSecond: BITS_PER_SECOND,
      };
      return await withTimeout(
        recorder.evaluate(
          (t) =>
            (
              window as unknown as {
                startCapture(target: unknown): Promise<Started>;
              }
            ).startCapture(t),
          target,
        ),
        START_TIMEOUT_MS,
        `the ${name === "stage" ? "stage" : "app's"} tab did not start within 5 s`,
      );
    } finally {
      await tab.evaluate(unmarkTitle).catch(() => {});
      await this.page.bringToFront();
    }
  }

  /** The cursor carried a file (see CaptureLog.carry). */
  carry(from: number, to: number, label: string): void {
    this.log.carry(from, to, label);
  }

  /** From now on the video shows the app's tab or the stage, reached by `transition`. */
  source(
    source: SourceSwitch["source"],
    transition: SourceSwitch["transition"],
    cursor = true,
  ): void {
    this.log.source(source, transition, cursor);
  }

  now(): number {
    return this.log.now();
  }

  /** Off camera: the recorder keeps recording, the renderer cuts this time out. */
  pause(): void {
    this.log.pause();
  }

  resume(): void {
    this.log.resume();
  }

  span(kind: SpanKind, from: number, to: number, outMs: number): void {
    this.log.span(kind, from, to, outMs);
  }

  get stretchMs(): number {
    return this.log.stretchMs;
  }

  /**
   * Waits (at most `timeoutMs`) until the stage's recording has a frame
   * captured after `wall`: Chrome captures a background tab rarely (about
   * once a second), so what was just put on the stage may not be recorded
   * yet. Returns at once when frames cannot be watched.
   */
  async stageFrameAfter(wall: number, timeoutMs = 1_500): Promise<void> {
    const recorder = this.recorder;
    if (!recorder || !this.stage) return;
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const last = await recorder
        .evaluate(() =>
          (window as unknown as { lastFrameWall(name: string): number | null }).lastFrameWall("stage"),
        )
        .catch(() => null);
      if (last === null || last > wall) return;
      await new Promise((done) => setTimeout(done, 40));
    }
  }

  download(name: string, size: number): void {
    this.log.download(name, size);
  }

  scene(placeholder: Omit<ScenePlaceholder, "t">): void {
    this.log.scene(placeholder);
  }

  pointer(at: Point, kind: PointerKind): void {
    this.log.pointer(at, kind);
  }

  dialog(
    type: string,
    message: string,
    accepted: boolean,
    text?: string,
    origin?: string,
    at?: number,
  ): void {
    this.log.dialog(type, message, accepted, text, origin, at);
  }

  focus(
    kind: FocusKind,
    at: Point,
    box?: Box,
    from?: number,
    transition?: string,
  ): void {
    this.log.focus(kind, at, box, from, transition);
  }

  /** Stops the recorder (it hands over the last chunk), closes its tab, writes events.json. */
  async stop(): Promise<string> {
    this.log.finish();
    this.log.detach(this.page);
    const recorder = this.recorder;
    const problems: Array<string> = [];
    if (recorder) {
      const stopOne = (name: string) =>
        withTimeout(
          recorder.evaluate(
            (stream) =>
              (
                window as unknown as {
                  stopCapture(
                    name: string,
                  ): Promise<{ firstFrameWall: number; problems: Array<string> } | null>;
                }
              ).stopCapture(stream),
            name,
          ),
          STOP_TIMEOUT_MS,
          "the recorder did not finish",
        ).catch((error: unknown) => {
          console.warn(`Tab capture (${name}): ${String(error)}`);
          return null;
        });
      const app = await stopOne("screen");
      if (app && Number.isFinite(app.firstFrameWall)) this.startWall = app.firstFrameWall;
      for (const problem of app?.problems ?? []) problems.push(`the app's tab: ${problem}`);
      if (this.stage) {
        const stage = await stopOne("stage");
        this.stageWall = stage?.firstFrameWall ?? NaN;
        for (const problem of stage?.problems ?? []) problems.push(`the stage: ${problem}`);
      }
      await recorder.close().catch(() => {});
      this.recorder = null;
    }
    await this.stage?.close().catch(() => {});
    this.data.video.startMs = Math.round(this.startWall - this.log.startedAt);
    const stageFile = this.files.get("stage");
    if (stageFile && Number.isFinite(this.stageWall)) {
      this.data.stage = {
        file: path.basename(stageFile),
        startMs: Math.round(this.stageWall - this.log.startedAt),
      };
    }
    if (this.options.audio && (this.started?.audioTracks ?? 0) > 0) {
      // The sound is in the same file, on the video's clock, and reaches it
      // a little after the page plays it.
      this.data.audio = {
        file: this.data.video.file,
        startMs: this.data.video.startMs - APP_AUDIO_DELAY_MS,
      };
    }
    const file = this.log.write(this.dir);
    if (problems.length > 0) {
      throw new Error(
        `The recording stopped before the end: ${problems.join("; ")}. ` +
          `What was recorded is in ${this.dir}.`,
      );
    }
    return file;
  }
}

/**
 * Runs in the app's page: puts the marker into the title and keeps it there
 * while the capture starts, without fighting the app. The app's own title
 * writes (document.title) are kept aside and read back as the app wrote
 * them, so an app that checks or defends its title sees its own; a direct
 * change of the <title> element is undone a bounded number of times (the
 * start is retried if the marker is lost). unmarkTitle brings back the
 * app's latest title.
 */
function markTitle(marker: string): void {
  type State = { app: string; marker: string; observer: MutationObserver; fixes: number };
  const win = window as Window & { __runcastTitle?: State };
  const real = Object.getOwnPropertyDescriptor(Document.prototype, "title")!;
  const read = () => real.get!.call(document) as string;
  const write = (title: string) => real.set!.call(document, title);
  const state: State = {
    app: read(),
    marker,
    fixes: 0,
    observer: new MutationObserver(() => {
      const now = read();
      if (now === state.marker || state.fixes >= 50) return;
      state.fixes++;
      state.app = now;
      write(state.marker);
    }),
  };
  win.__runcastTitle = state;
  Object.defineProperty(document, "title", {
    configurable: true,
    get: () => state.app,
    set: (title: unknown) => {
      state.app = String(title);
    },
  });
  write(marker);
  state.observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
  });
}

function unmarkTitle(): void {
  const win = window as Window & {
    __runcastTitle?: { app: string; observer: MutationObserver };
  };
  const state = win.__runcastTitle;
  if (!state) return;
  state.observer.disconnect();
  delete win.__runcastTitle;
  // Back to the browser's own document.title, set to the app's latest.
  delete (document as unknown as { title?: string }).title;
  document.title = state.app;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
