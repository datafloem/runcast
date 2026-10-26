import type { Page } from "@playwright/test";
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Point } from "./cursor.ts";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PointerKind = "move" | "down" | "up";
export type FocusKind =
  | "click"
  | "double-click"
  | "right-click"
  | "hover"
  | "type"
  | "drag";

/** What scripts/video/ needs to build the video. Times are ms since recording start. */
export interface CaptureFile {
  scenario: string;
  /** Page size in CSS pixels. */
  viewport: { width: number; height: number };
  /** Video pixels per CSS pixel (2 on a Retina screen). */
  scale: number;
  durationMs: number;
  /** The raw screen recording of the page area. */
  video: {
    file: string;
    /** When its first frame was taken, in ms since recording start (usually < 0). */
    startMs: number;
    width: number;
    height: number;
  };
  /** Virtual cursor path, in page CSS pixels. */
  pointer: Array<{ t: number; x: number; y: number; kind: PointerKind }>;
  /** Where the action is: what the camera should look at, and when. */
  focus: Array<{
    t: number;
    until: number;
    kind: FocusKind;
    x: number;
    y: number;
    box?: Box;
  }>;
  /** Page changes (route changes included): the camera pulls back on these. */
  navigations: Array<number>;
}

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
export class VideoCapture {
  private ffmpeg: ChildProcessWithoutNullStreams | null = null;
  private readonly data: CaptureFile;
  /** Wall-clock time of the video's first frame, from ffmpeg's progress reports. */
  private videoStartWall = Infinity;

  constructor(
    private readonly page: Page,
    /** Output folder, e.g. .results/<test>/capture */
    readonly dir: string,
    private startedAt: number,
    scenario: string,
  ) {
    this.data = {
      scenario,
      viewport: { width: 0, height: 0 },
      scale: 1,
      durationMs: 0,
      video: { file: "screen.mkv", startMs: 0, width: 0, height: 0 },
      pointer: [],
      focus: [],
      navigations: [],
    };
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
    if (process.platform !== "darwin" && process.platform !== "linux") {
      throw new Error("Video mode records the screen on macOS and Linux only.");
    }
    mkdirSync(this.dir, { recursive: true });
    const area = await this.placeWindow();
    this.data.scale = area.scale;
    this.data.video.width = area.width;
    this.data.video.height = area.height;

    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        ...screenInput(area),
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
      const hint =
        process.platform === "darwin"
          ? "Give the terminal Screen Recording permission (System Settings > Privacy & Security > Screen Recording) and make sure ffmpeg is installed."
          : `Make sure ffmpeg is installed and DISPLAY (${process.env.DISPLAY ?? "not set"}) is reachable.`;
      throw new Error(`ffmpeg could not record the screen. ${hint}\n${stderr}`);
    }
    this.page.on("framenavigated", this.onNavigation);
    this.startedAt = Date.now();
    return { viewport: this.data.viewport, startedAt: this.startedAt };
  }

  /**
   * Fills the screen's usable area (menu bar and Dock excluded) with the
   * window; the page gets whatever size that leaves. Returns the page area on
   * screen, in screen pixels.
   */
  private async placeWindow(): Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
    scale: number;
  }> {
    const cdp = await this.page.context().newCDPSession(this.page);
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    const screenArea = await this.page.evaluate(() => {
      const s = window.screen as Screen & {
        availLeft?: number;
        availTop?: number;
      };
      return {
        left: s.availLeft ?? 0,
        top: s.availTop ?? 0,
        width: s.availWidth,
        height: s.availHeight,
      };
    });
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "normal" },
    });
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: screenArea });
    await cdp.detach();
    await this.page.bringToFront();

    // Wait for the resize to settle: the page size reads the same three times.
    let page = { width: 0, height: 0 };
    let same = 0;
    for (let i = 0; i < 50 && same < 3; i++) {
      await delay(100);
      const now = await this.page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));
      same =
        now.width === page.width && now.height === page.height ? same + 1 : 0;
      page = now;
    }
    const geometry = await this.page.evaluate(() => ({
      x: window.screenX + (window.outerWidth - window.innerWidth) / 2,
      y: window.screenY + (window.outerHeight - window.innerHeight),
      scale: window.devicePixelRatio,
    }));
    // ffmpeg wants even numbers. Round the start inward and the size down, so
    // the area never takes in the browser's own border (at 1x the page often
    // starts on an odd pixel), and describe the page by what is recorded.
    const scale = geometry.scale;
    const left = geometry.x * scale;
    const top = geometry.y * scale;
    const x = Math.ceil(left / 2) * 2;
    const y = Math.ceil(top / 2) * 2;
    const width = Math.floor((left + page.width * scale - x) / 2) * 2;
    const height = Math.floor((top + page.height * scale - y) / 2) * 2;
    this.data.viewport = { width: width / scale, height: height / scale };
    return { x, y, width, height, scale };
  }

  private readonly onNavigation = (frame: { parentFrame(): unknown }) => {
    if (!frame.parentFrame()) this.data.navigations.push(this.now());
  };

  now(): number {
    return Date.now() - this.startedAt;
  }

  pointer(at: Point, kind: PointerKind): void {
    this.data.pointer.push({
      t: this.now(),
      x: round(at.x),
      y: round(at.y),
      kind,
    });
  }

  focus(kind: FocusKind, at: Point, box?: Box, from?: number): void {
    const t = from ?? this.now();
    this.data.focus.push({
      t,
      until: this.now(),
      kind,
      x: round(at.x),
      y: round(at.y),
      box: box && {
        x: round(box.x),
        y: round(box.y),
        width: round(box.width),
        height: round(box.height),
      },
    });
  }

  /** Stops ffmpeg (it finishes the file) and writes events.json. */
  async stop(): Promise<string> {
    this.data.durationMs = this.now();
    this.page.off("framenavigated", this.onNavigation);
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
    this.data.video.startMs = Math.round(this.videoStartWall - this.startedAt);
    const file = path.join(this.dir, "events.json");
    writeFileSync(file, JSON.stringify(this.data));
    return file;
  }
}

/** ffmpeg's input options for the page area of the screen, per platform. */
function screenInput(area: Box): Array<string> {
  const common = ["-framerate", "30"];
  if (process.platform === "linux") {
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

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
