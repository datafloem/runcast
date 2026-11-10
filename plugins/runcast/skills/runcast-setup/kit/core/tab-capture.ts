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
 * `scale` (2880x1620 for a 1440x810 page at 2).
 */
export class TabCapture implements Capture {
  private readonly log: CaptureLog;
  private recorder: Page | null = null;
  /** Wall-clock time of the file's first frame (until stop: the recorder's start). */
  private startWall = NaN;
  /** Files the chunks went to, by stream name. */
  private readonly files = new Map<string, string>();
  /** Last info from the recorder page (tests read the audio settings). */
  started: Started | null = null;

  private readonly page: Page;
  /** Output folder: .captures/<scenario>/capture of the recording folder. */
  readonly dir: string;
  private readonly options: { scale: number; audio?: boolean };

  constructor(
    page: Page,
    dir: string,
    scenario: string,
    options: { scale: number; audio?: boolean },
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

    let error: unknown;
    for (let attempt = 0; attempt < 2 && !this.started; attempt++) {
      try {
        this.started = await this.startOnce();
      } catch (caught) {
        error = caught;
        await this.recorder?.close().catch(() => {});
        this.recorder = null;
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

  /** Opens the recorder tab and starts recording the marked app tab. */
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

    const marker = `${MARKER}${randomBytes(6).toString("hex")}`;
    await this.page.evaluate(markTitle, marker);
    try {
      // getDisplayMedia only works from the tab in front.
      await recorder.bringToFront();
      const target = {
        name: "screen",
        width: this.data.video.width,
        height: this.data.video.height,
        audio: this.options.audio ?? false,
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
        "it did not start within 5 s",
      );
    } finally {
      await this.page.evaluate(unmarkTitle).catch(() => {});
      await this.page.bringToFront();
    }
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

  pointer(at: Point, kind: PointerKind): void {
    this.log.pointer(at, kind);
  }

  dialog(
    type: string,
    message: string,
    accepted: boolean,
    text?: string,
    origin?: string,
  ): void {
    this.log.dialog(type, message, accepted, text, origin);
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
    if (recorder) {
      const stopped = await withTimeout(
        recorder.evaluate(() =>
          (
            window as unknown as {
              stopCapture(): Promise<{ firstFrameWall: number } | null>;
            }
          ).stopCapture(),
        ),
        STOP_TIMEOUT_MS,
        "the recorder did not finish",
      ).catch((error: unknown) => {
        console.warn(`Tab capture: ${String(error)}`);
        return null;
      });
      if (stopped && Number.isFinite(stopped.firstFrameWall)) {
        this.startWall = stopped.firstFrameWall;
      }
      await recorder.close().catch(() => {});
      this.recorder = null;
    }
    this.data.video.startMs = Math.round(this.startWall - this.log.startedAt);
    if (this.options.audio && (this.started?.audioTracks ?? 0) > 0) {
      // The sound is in the same file, on the video's clock, and reaches it
      // a little after the page plays it.
      this.data.audio = {
        file: this.data.video.file,
        startMs: this.data.video.startMs - APP_AUDIO_DELAY_MS,
      };
    }
    return this.log.write(this.dir);
  }
}

/**
 * Runs in the app's page: puts the marker into the title and keeps it there
 * while the capture starts, even when the app sets its own title meanwhile
 * (a route change); the app's latest title comes back with unmarkTitle.
 */
function markTitle(marker: string): void {
  const win = window as Window & {
    __runcastTitle?: { app: string; marker: string; observer: MutationObserver };
  };
  const state = { app: document.title, marker, observer: new MutationObserver(() => {
    if (document.title === state.marker) return;
    state.app = document.title;
    document.title = state.marker;
  }) };
  win.__runcastTitle = state;
  document.title = marker;
  state.observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
  });
}

function unmarkTitle(): void {
  const win = window as Window & {
    __runcastTitle?: { app: string; marker: string; observer: MutationObserver };
  };
  const state = win.__runcastTitle;
  if (!state) return;
  state.observer.disconnect();
  delete win.__runcastTitle;
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
