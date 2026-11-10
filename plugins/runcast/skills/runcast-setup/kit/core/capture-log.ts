// The event log of a video-mode recording and its clock, shared by both
// capture methods (screen: core/video-capture.ts, tab: core/tab-capture.ts).
// The renderer (scripts/video/) reads what it writes: events.json.
import type { Page } from "@playwright/test";
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

/**
 * A logged stretch of the recording and how long it lasts in the video
 * (scripts/video/timemap.ts reads these): a cursor move, the rest on a
 * target before clicking, a viewer pause, typing, an off-camera cut, or a
 * browser dialog the renderer draws over a held frame.
 */
export type SpanKind = "move" | "aim" | "hold" | "type" | "cut" | "dialog";
export interface CaptureSpan {
  from: number;
  to: number;
  kind: SpanKind;
  outMs: number;
  /** "cut" only: recording time left out. */
  skipMs?: number;
}
export type FocusKind =
  | "click"
  | "double-click"
  | "right-click"
  | "hover"
  | "type"
  | "drag"
  | "show";

/** A browser dialog (alert, confirm, prompt, beforeunload) the kit answered. */
export interface CaptureDialog {
  t: number;
  type: string;
  message: string;
  accepted: boolean;
  /** prompt: the text answered. */
  text?: string;
  /** The page's host, which the browser names in the dialog. */
  origin?: string;
}

/** How long the video holds the frame while it shows a dialog being answered. */
export const DIALOG_FREEZE_MS = 1500;

/** Which captured tab the video shows from `t` on, and how it gets there. */
export interface SourceSwitch {
  t: number;
  source: "app" | "stage";
  transition: "fade" | "slide" | "cube" | "cut" | "lift";
}

/** A file carried by the cursor (drag and drop): the renderer draws its icon at the cursor. */
export interface Carry {
  from: number;
  to: number;
  label: string;
}

/** What scripts/video/ needs to build the video. Times are ms since recording start. */
export interface CaptureFile {
  scenario: string;
  /** Page size in CSS pixels. */
  viewport: { width: number; height: number };
  /** Video pixels per CSS pixel (2 on a Retina screen). */
  scale: number;
  durationMs: number;
  /** The raw recording of the page area. */
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
    /** A "show": how the camera gets there (pan, slide, fade, cube, cut). */
    transition?: string;
  }>;
  /** Page changes (route changes included): the camera pulls back on these. */
  navigations: Array<number>;
  /**
   * What each stretch of the recording was and how long it lasts in the
   * video. Time no span covers is app time (loading, waiting), shown 1:1.
   * Off-camera steps are "cut" spans: at `from` (on the clock above, which
   * already leaves them out) the recording skips `skipMs`.
   */
  spans: Array<CaptureSpan>;
  /** Browser dialogs, drawn by the renderer during their "dialog" span. */
  dialogs?: Array<CaptureDialog>;
  /** Switches between the app tab and the stage tab (tab capture). */
  sources?: Array<SourceSwitch>;
  /** Files carried by the cursor. */
  carries?: Array<Carry>;
  /** The app's sound: a file with an audio track and when it starts. */
  audio?: { file: string; startMs: number };
  /** The stage tab's recording (tab capture). */
  stage?: { file: string; startMs: number };
}

/** What a recording does, whichever way it captures the page. */
export interface Capture {
  /** Starts recording; returns the page size and the new time zero. */
  start(): Promise<{
    viewport: { width: number; height: number };
    startedAt: number;
  }>;
  /** Stops recording and writes events.json; returns its path. */
  stop(): Promise<string>;
  /** ms since recording start, time off camera left out. */
  now(): number;
  pause(): void;
  resume(): void;
  pointer(at: Point, kind: PointerKind): void;
  focus(
    kind: FocusKind,
    at: Point,
    box?: Box,
    from?: number,
    transition?: string,
  ): void;
  span(kind: SpanKind, from: number, to: number, outMs: number): void;
  /** A browser dialog the kit answered (see CaptureLog.dialog). */
  dialog(
    type: string,
    message: string,
    accepted: boolean,
    text?: string,
    origin?: string,
  ): void;
}

/**
 * The log and its clock: pointer, focus, spans and navigations, with time
 * off camera left out (pause/resume). A capture owns one and fills in the
 * video fields.
 */
export class CaptureLog {
  readonly data: CaptureFile;
  /** Wall-clock time zero of the recording. */
  startedAt = Date.now();
  /** Off camera since this wall-clock time (0: on camera). */
  private pausedAt = 0;
  private pausedMs = 0;

  constructor(scenario: string) {
    this.data = {
      scenario,
      viewport: { width: 0, height: 0 },
      scale: 1,
      durationMs: 0,
      video: { file: "", startMs: 0, width: 0, height: 0 },
      pointer: [],
      focus: [],
      navigations: [],
      spans: [],
    };
  }

  /** True while off camera. */
  get paused(): boolean {
    return this.pausedAt !== 0;
  }

  /** ms since recording start, time off camera left out. */
  now(): number {
    const wall = this.pausedAt || Date.now();
    return wall - this.startedAt - this.pausedMs;
  }

  /** Off camera: the recording goes on, the renderer cuts this time out. */
  pause(): void {
    if (this.pausedAt) return;
    this.pausedAt = Date.now();
  }

  resume(): void {
    if (!this.pausedAt) return;
    const at = this.now();
    const ms = Date.now() - this.pausedAt;
    this.pausedMs += ms;
    this.pausedAt = 0;
    this.data.spans.push({ from: at, to: at, kind: "cut", outMs: 0, skipMs: ms });
  }

  /** Logs a stretch of the recording (see CaptureFile.spans). Dropped off camera. */
  span(kind: SpanKind, from: number, to: number, outMs: number): void {
    if (this.pausedAt) return;
    this.data.spans.push({
      from: Math.round(from),
      to: Math.round(to),
      kind,
      outMs: Math.round(outMs),
    });
  }

  /**
   * A browser dialog the kit answered: logged, with a held frame of
   * DIALOG_FREEZE_MS over which the renderer draws it. Dropped off camera.
   */
  dialog(
    type: string,
    message: string,
    accepted: boolean,
    text?: string,
    origin?: string,
  ): void {
    if (this.pausedAt) return;
    const t = this.now();
    (this.data.dialogs ??= []).push({
      t,
      type,
      message,
      accepted,
      ...(text !== undefined ? { text } : {}),
      ...(origin ? { origin } : {}),
    });
    this.data.spans.push({ from: t, to: t, kind: "dialog", outMs: DIALOG_FREEZE_MS });
  }

  /** The cursor carried a file from `from` to `to` (drag and drop): the renderer draws its icon. */
  carry(from: number, to: number, label: string): void {
    if (this.pausedAt) return;
    (this.data.carries ??= []).push({
      from: Math.round(from),
      to: Math.round(to),
      label,
    });
  }

  /** From now on the video shows `source` (tab capture), reached by `transition`. Dropped off camera. */
  source(source: SourceSwitch["source"], transition: SourceSwitch["transition"]): void {
    if (this.pausedAt) return;
    (this.data.sources ??= []).push({ t: this.now(), source, transition });
  }

  pointer(at: Point, kind: PointerKind): void {
    this.data.pointer.push({
      t: this.now(),
      x: round(at.x),
      y: round(at.y),
      kind,
    });
  }

  focus(
    kind: FocusKind,
    at: Point,
    box?: Box,
    from?: number,
    transition?: string,
  ): void {
    const t = from ?? this.now();
    this.data.focus.push({
      ...(transition ? { transition } : {}),
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

  private readonly onNavigation = (frame: { parentFrame(): unknown }) => {
    if (!frame.parentFrame()) this.data.navigations.push(this.now());
  };

  /** Logs the page's navigations from now on. */
  attach(page: Page): void {
    page.on("framenavigated", this.onNavigation);
  }

  detach(page: Page): void {
    page.off("framenavigated", this.onNavigation);
  }

  /** Back on camera and the length set: call once, when the recording stops. */
  finish(): void {
    this.resume();
    this.data.durationMs = this.now();
  }

  /** Writes events.json into `dir`; returns its path. */
  write(dir: string): string {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "events.json");
    writeFileSync(file, JSON.stringify(this.data));
    return file;
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
