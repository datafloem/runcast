import type { Page } from "@playwright/test";
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  CaptureLog,
  type Box,
  type Capture,
  type FocusKind,
  type PointerKind,
  type SpanKind,
} from "./capture-log.ts";
import type { Point } from "./cursor.ts";

/**
 * Video mode: records the page area of the (visible) Chrome window with
 * ffmpeg as one continuous video, and logs the pointer and focus events that
 * the renderer turns into zoom and cursor motion.
 *
 * macOS (ffmpeg's avfoundation; the terminal needs the Screen Recording
 * permission) and Linux (ffmpeg's x11grab on DISPLAY, an Xvfb display when
 * there is no screen: core/xvfb.ts). The real cursor is left out of the
 * video; the renderer draws its own.
 */
export class VideoCapture implements Capture {
  private ffmpeg: ChildProcessWithoutNullStreams | null = null;
  private readonly log: CaptureLog;
  /** Wall-clock time of the video's first frame, from ffmpeg's progress reports. */
  private videoStartWall = Infinity;

  private readonly page: Page;
  /** Output folder: .captures/<scenario>/capture of the recording folder. */
  readonly dir: string;
  /** Record a 9:16 page (format "vertical") instead of the whole screen. */
  private readonly vertical: boolean;

  constructor(page: Page, dir: string, scenario: string, vertical = false) {
    this.page = page;
    this.dir = dir;
    this.vertical = vertical;
    this.log = new CaptureLog(scenario);
    this.log.data.video.file = "screen.mkv";
  }

  private get data() {
    return this.log.data;
  }

  /**
   * Places the window, starts ffmpeg and waits for its first frame. Returns
   * the page size and the new time zero: the recording counts from when the
   * screen recording runs, not from when it was asked for.
   */
  async start(): Promise<{
    viewport: { width: number; height: number };
    startedAt: number;
  }> {
    if (!["darwin", "linux", "win32"].includes(process.platform)) {
      throw new Error(
        "Video mode records the screen on macOS, Linux and Windows only.",
      );
    }
    mkdirSync(this.dir, { recursive: true });
    const area = await this.placeWindow();
    this.data.scale = area.scale;
    this.data.video.width = area.width;
    this.data.video.height = area.height;

    // Windows: ddagrab (Desktop Duplication) first, gdigrab when it can't start.
    let stderr = "";
    for (const grabber of grabbers()) {
      stderr = await this.launch(screenInput(area, grabber));
      if (Number.isFinite(this.videoStartWall)) break;
      if (grabbers().length > 1) {
        console.warn(`ffmpeg ${grabber} could not record; trying the next one.`);
      }
    }
    if (!Number.isFinite(this.videoStartWall)) {
      const hint =
        process.platform === "darwin"
          ? "Give the terminal Screen Recording permission (System Settings > Privacy & Security > Screen Recording) and make sure ffmpeg is installed."
          : process.platform === "win32"
            ? "Make sure ffmpeg is installed (winget install Gyan.FFmpeg), the desktop is unlocked, and Chrome is on the main screen. REC_WIN_GRABBER=gdigrab or ddagrab picks one capture method."
            : `Make sure ffmpeg is installed and DISPLAY (${process.env.DISPLAY ?? "not set"}) is reachable.`;
      throw new Error(`ffmpeg could not record the screen. ${hint}\n${stderr}`);
    }
    this.log.attach(this.page);
    this.log.startedAt = Date.now();
    return { viewport: this.data.viewport, startedAt: this.log.startedAt };
  }

  /** Starts ffmpeg with one screen input and waits for its first frame; returns its error output. */
  private async launch(input: Array<string>): Promise<string> {
    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        ...input,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-tune",
        "zerolatency",
        "-crf",
        "14",
        "-pix_fmt",
        "yuv420p",
        "-progress",
        "pipe:1",
        "-stats_period",
        "0.1",
        "-y",
        "-f",
        "matroska",
        path.join(this.dir, this.data.video.file),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.ffmpeg = ffmpeg;
    let stderr = "";
    ffmpeg.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    ffmpeg.stdout.setEncoding("utf8");
    ffmpeg.stdout.on("data", (chunk: string) => {
      // "Now" minus "how far the video is" = when its first frame was taken.
      // The smallest estimate has the least reporting delay in it.
      for (const match of chunk.matchAll(/^out_time_us=(\d+)/gm)) {
        const videoMs = Number(match[1]) / 1000;
        if (videoMs > 0) {
          this.videoStartWall = Math.min(
            this.videoStartWall,
            Date.now() - videoMs,
          );
        }
      }
    });

    for (let i = 0; i < 200 && !Number.isFinite(this.videoStartWall); i++) {
      if (ffmpeg.exitCode !== null) break;
      await delay(50);
    }
    if (!Number.isFinite(this.videoStartWall)) {
      ffmpeg.kill("SIGKILL");
      this.ffmpeg = null;
    }
    return stderr;
  }

  /**
   * Sizes the window (fitWindow); returns the page area on screen, in screen
   * pixels.
   */
  private async placeWindow(): Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
    scale: number;
  }> {
    const page = await fitWindow(this.page, this.vertical);
    const geometry = await this.page.evaluate((windows) => {
      // The window's frame beside the page. On Windows the same width also
      // runs along the bottom (the invisible resize border), so the toolbar
      // height is the extra height minus that border.
      const side = (window.outerWidth - window.innerWidth) / 2;
      return {
        x: window.screenX + side,
        y:
          window.screenY +
          (window.outerHeight - window.innerHeight) -
          (windows ? side : 0),
        scale: window.devicePixelRatio,
      };
    }, process.platform === "win32");
    // REC_CAPTURE_OFFSET=x,y moves the recorded area, in screen pixels, when
    // a window frame puts the page somewhere the browser doesn't report.
    const [nudgeX = 0, nudgeY = 0] = (process.env.REC_CAPTURE_OFFSET ?? "")
      .split(",")
      .map((n) => Number(n.trim()) || 0);
    // ffmpeg wants even numbers. Round the start inward and the size down, so
    // the area never takes in the browser's own border (at 1x the page often
    // starts on an odd pixel), and describe the page by what is recorded.
    const scale = geometry.scale;
    const left = geometry.x * scale + nudgeX;
    const top = geometry.y * scale + nudgeY;
    const x = Math.ceil(left / 2) * 2;
    const y = Math.ceil(top / 2) * 2;
    const width = Math.floor((left + page.width * scale - x) / 2) * 2;
    const height = Math.floor((top + page.height * scale - y) / 2) * 2;
    this.data.viewport = { width: width / scale, height: height / scale };
    return { x, y, width, height, scale };
  }

  now(): number {
    return this.log.now();
  }

  /** Off camera: ffmpeg keeps recording, the renderer cuts this time out. */
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

  focus(
    kind: FocusKind,
    at: Point,
    box?: Box,
    from?: number,
    transition?: string,
  ): void {
    this.log.focus(kind, at, box, from, transition);
  }

  /** Stops ffmpeg (it finishes the file) and writes events.json. */
  async stop(): Promise<string> {
    this.log.finish();
    this.log.detach(this.page);
    const ffmpeg = this.ffmpeg;
    if (ffmpeg?.exitCode === null) {
      const closed = new Promise<void>((resolve) =>
        ffmpeg.once("close", () => resolve()),
      );
      ffmpeg.stdin.write("q");
      const finished = await Promise.race([
        closed.then(() => true),
        delay(10_000).then(() => false),
      ]);
      if (!finished) ffmpeg.kill("SIGKILL");
    }
    this.data.video.startMs = Math.round(
      this.videoStartWall - this.log.startedAt,
    );
    return this.log.write(this.dir);
  }
}

/**
 * Fills the screen's usable area (menu bar, Dock or taskbar excluded) with the
 * window, or, `vertical`, its full height with a window as wide as makes the
 * page 9:16. The page gets whatever size that leaves; returns it (CSS pixels)
 * once the resize has settled. Placing a window that is already there changes
 * nothing, so the page is not laid out again.
 */
export async function fitWindow(
  page: Page,
  vertical: boolean,
): Promise<{ width: number; height: number }> {
  const cdp = await page.context().newCDPSession(page);
  const { windowId } = await cdp.send("Browser.getWindowForTarget");
  const area = await page.evaluate(() => {
    const s = window.screen as Screen & {
      availLeft?: number;
      availTop?: number;
    };
    return {
      left: s.availLeft ?? 0,
      top: s.availTop ?? 0,
      width: s.availWidth,
      height: s.availHeight,
      // The window's frame and toolbar around the page.
      frameWidth: window.outerWidth - window.innerWidth,
      frameHeight: window.outerHeight - window.innerHeight,
    };
  });
  const width = vertical
    ? Math.round(((area.height - area.frameHeight) * 9) / 16) + area.frameWidth
    : area.width;
  await cdp.send("Browser.setWindowBounds", {
    windowId,
    bounds: { windowState: "normal" },
  });
  await cdp.send("Browser.setWindowBounds", {
    windowId,
    bounds: { left: area.left, top: area.top, width, height: area.height },
  });
  await cdp.detach();
  await page.bringToFront();

  // Wait for the resize to settle: the page size reads the same three times.
  let size = { width: 0, height: 0 };
  let same = 0;
  for (let i = 0; i < 50 && same < 3; i++) {
    await delay(100);
    const now = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    same =
      now.width === size.width && now.height === size.height ? same + 1 : 0;
    size = now;
  }
  return size;
}

type Grabber = "avfoundation" | "x11grab" | "ddagrab" | "gdigrab";

/** The screen grabbers to try, in order, on this platform. */
function grabbers(): Array<Grabber> {
  if (process.platform === "darwin") return ["avfoundation"];
  if (process.platform === "linux") return ["x11grab"];
  const pick = process.env.REC_WIN_GRABBER;
  if (pick === "ddagrab" || pick === "gdigrab") return [pick];
  return ["ddagrab", "gdigrab"];
}

/** ffmpeg's input options for the page area of the screen, per grabber. */
function screenInput(area: Box, grabber: Grabber): Array<string> {
  const common = ["-framerate", "30"];
  if (grabber === "ddagrab") {
    // Desktop Duplication: physical pixels of one screen, so display scaling
    // doesn't shift the area. Frames come out on the GPU; download them.
    const source = [
      `output_idx=${process.env.REC_SCREEN ?? "0"}`,
      "framerate=30",
      "draw_mouse=0",
      `offset_x=${area.x}`,
      `offset_y=${area.y}`,
      `video_size=${area.width}x${area.height}`,
    ].join(":");
    return [
      "-f",
      "lavfi",
      "-i",
      `ddagrab=${source}`,
      "-vf",
      "hwdownload,format=bgra",
    ];
  }
  if (grabber === "gdigrab") {
    // GDI: grabs just the area of the desktop; the pointer is left out.
    return [
      "-f",
      "gdigrab",
      "-draw_mouse",
      "0",
      ...common,
      "-offset_x",
      `${area.x}`,
      "-offset_y",
      `${area.y}`,
      "-video_size",
      `${area.width}x${area.height}`,
      "-i",
      "desktop",
    ];
  }
  if (grabber === "x11grab") {
    // x11grab grabs just the area; the pointer is left out.
    const display = process.env.DISPLAY ?? ":0";
    const screen = display.includes(".") ? display : `${display}.0`;
    return [
      "-f",
      "x11grab",
      "-draw_mouse",
      "0",
      ...common,
      "-video_size",
      `${area.width}x${area.height}`,
      "-i",
      `${screen}+${area.x},${area.y}`,
    ];
  }
  // avfoundation records the whole screen; crop to the page area.
  return [
    "-f",
    "avfoundation",
    "-pixel_format",
    "nv12",
    "-capture_cursor",
    "0",
    ...common,
    "-i",
    `${screenDeviceIndex()}:none`,
    "-vf",
    `crop=${area.width}:${area.height}:${area.x}:${area.y}`,
  ];
}

/** avfoundation's index of the main screen ("Capture screen 0"); REC_SCREEN overrides it. */
function screenDeviceIndex(): string {
  if (process.env.REC_SCREEN) return process.env.REC_SCREEN;
  let listing = "";
  try {
    execFileSync(
      "ffmpeg",
      ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    // ffmpeg lists the devices on stderr and exits with an error.
    listing = (error as { stderr?: string }).stderr ?? "";
  }
  const match = /\[(\d+)\] Capture screen 0/.exec(listing);
  if (!match?.[1])
    throw new Error(`ffmpeg found no screen to capture:\n${listing}`);
  return match[1];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
