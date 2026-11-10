// Turns a video-mode capture (screen recording + events.json) into an MP4: framed,
// with a camera that zooms to the action, a drawn cursor with click ripples,
// and the scenario's voice-over clips placed at their steps.
//
//   node <recording folder>/.kit/cli.ts render [<scenario or capture folder>] [--check | --draft] [--steps <a>-<b>]
//
// --check draws each step's last frame into .captures/<scenario>/check/ (one
// contact sheet: sheet.png) and prints the narration fit, without a video.
// --draft renders half size and quickly to videos/<name>.draft.mp4.
// --steps renders only steps a to b (1-based, recorded steps), to
// videos/<name>.steps-a-b.mp4 unless --draft.
// Without an argument it renders the newest capture. Runs with plain Node.
import {
  createCanvas,
  ImageData,
  loadImage,
  type Canvas,
  type Image,
  type SKRSContext2D,
} from "@napi-rs/canvas";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  actionsOutOfFrame,
  baseView,
  buildCameraTrack,
  cameraAtTime,
  captionAtTime,
  clampCamera,
  clicksAtTime,
  cursorAtTime,
  easeInOutCubic,
  sourceTransitionAt,
  transitionAtTime,
  type Camera,
  type Focus,
  type PointerSample,
  type Size,
} from "./timeline.ts";
import { resolveFormat, type VideoFormat } from "../../core/format.ts";
import {
  loadNarration,
  segmentLength,
  stepVoices,
} from "../../core/narration.ts";
import {
  audioPlan,
  fitNarration,
  naturalMap,
  retimeCapture,
  type AudioPiece,
  type Span,
  type StepFit,
} from "./timemap.ts";
import { appAudioFilter, shiftPlan } from "./audio.ts";
import { readFrameAt } from "./frames.ts";
import {
  findCaptures as findProjectCaptures,
  kitCommand,
  loadProject,
} from "../../core/project.ts";

const project = await loadProject();
const RECORDING_DIR = project.dir;
const KIT_CMD = kitCommand(RECORDING_DIR);
const VIDEOS_DIR = path.join(RECORDING_DIR, "videos");

const FPS = Number(process.env.REC_VIDEO_FPS ?? 30);
const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const BRAND = hexToRgb(project.brand?.color ?? "#f97316");
const FADE_IN_MS = 400;
const CROSSFADE_MS = 500;
/** Further ahead than this, the frame stream restarts at its target. */
const RESEEK_FRAMES = 2 * FPS;
/** Cross-fade where an off-camera step was cut out. */
const CUT_FADE_MS = 300;
/** The app's logo on the title cards (recording.config.ts > brand.logo). */
const LOGO_FILE = project.brand?.logo
  ? path.resolve(RECORDING_DIR, project.brand.logo)
  : null;

interface CaptureFile {
  scenario: string;
  viewport: { width: number; height: number };
  scale: number;
  durationMs: number;
  video: { file: string; startMs: number; width: number; height: number };
  pointer: Array<PointerSample>;
  focus: Array<Focus>;
  navigations?: Array<number>;
  /** What each stretch of the recording was (core/capture-log.ts); older captures have none. */
  spans?: Array<Span>;
  /** Older captures: off-camera time cut out of the screen recording. */
  cuts?: Array<{ at: number; ms: number }>;
  /** Tab capture: the app's sound (a file with an audio track) and when it starts. */
  audio?: { file: string; startMs: number };
  /** Browser dialogs the kit answered; each has a "dialog" span. */
  dialogs?: Array<CaptureDialog>;
  /** Tab capture: the stage tab's recording and when it starts. */
  stage?: { file: string; startMs: number };
  /** Switches between the app's tab and the stage. */
  sources?: Array<{
    t: number;
    source: SourceName;
    transition: SourceTransition;
    /** false: no cursor until the next switch (a scene). */
    cursor?: boolean;
  }>;
  /** Files the cursor carried (drag and drop). */
  carries?: Array<{ from: number; to: number; label: string }>;
}

type SourceName = "app" | "stage";
type SourceTransition = "fade" | "slide" | "cube" | "cut" | "lift";

interface CaptureDialog {
  t: number;
  type: string;
  message: string;
  accepted: boolean;
  text?: string;
  origin?: string;
}

/** The app's sound in the video: the recording's audio, where it plays, its levels. */
interface AppAudioMix {
  file: string;
  /** Pieces on the audio file's clock, placed on the video clock (intro included). */
  plan: Array<AudioPiece>;
  volume: number;
  duckTo: number;
}

interface Card {
  title: string;
  subtitle?: string;
  durationMs?: number;
}

interface StepsFile {
  scenario: string;
  captions?: boolean;
  /** Whether app waits may be shortened to fit narration (default true). */
  compressWaits?: boolean;
  /** The scenario's video format (core/format.ts). */
  format?: string;
  /** The app's sound in the video, when the scenario asked for it. */
  appAudio?: { volume: number; duckTo: number };
  intro?: Card;
  outro?: Card;
  steps: Array<{
    id?: string;
    seconds: number;
    title: string;
    note?: string;
    /** "cube": a cube turn over this step, from the frame before to the one after. */
    transition?: string;
  }>;
}

export function findCaptures(): Array<string> {
  return findProjectCaptures(RECORDING_DIR);
}

/** Where `drawAt` gets the recording's frames from (fills the source canvases). */
interface FrameSource {
  /** Puts tab `source`'s recording (default the app's) at file time `fileMs` into its canvas. */
  at(fileMs: number, source?: SourceName): Promise<void>;
  close(): Promise<void>;
}

/** Everything a capture renders from, and how to draw any frame of it. */
interface Prepared {
  scenario: string;
  /** The final video's path. */
  out: string;
  layout: Layout;
  introMs: number;
  sceneMs: number;
  totalMs: number;
  /** Recorded steps on the video clock (intro included). */
  steps: Array<{ id?: string; title: string; startMs: number }>;
  report: Array<StepFit>;
  /** Voice-over clips: file, start and length (ms, intro included). */
  clips: Array<{ file: string; at: number; ms: number }>;
  /** The app's sound, or null. */
  appAudio: AppAudioMix | null;
  canvas: Canvas;
  ctx: SKRSContext2D;
  /** Decodes the recording in order from file time `fromFileMs` (rendering). */
  streamFrames(fromFileMs?: number): FrameSource;
  /** Decodes single frames on demand (check). */
  seekFrames(): FrameSource;
  /**
   * Draws the video at time t (ms, intro included) into `canvas`.
   * `fadeCuts`: cross-fade after cuts (needs every frame drawn in order).
   */
  drawAt(
    t: number,
    frames: FrameSource,
    options?: { fadeCuts?: boolean },
  ): Promise<void>;
  /**
   * What the frame at t shows, as a key: two frames with the same key look
   * the same. Null while something animates (fades, transitions, ripples).
   */
  frameKey(t: number): string | null;
  /** Screen-file time shown at video time t (ms, intro included). */
  toRec(t: number): number;
}

/** Reads a capture folder and builds its time map, camera and drawing. */
async function prepare(captureDir: string): Promise<Prepared> {
  const capture = JSON.parse(
    readFileSync(path.join(captureDir, "events.json"), "utf-8"),
  ) as CaptureFile;
  const videoFile = path.join(captureDir, capture.video.file);
  if (!existsSync(videoFile))
    throw new Error(`${captureDir}: no screen recording`);
  const stepsFile = path.join(captureDir, "..", "steps.json");
  const stepsData = existsSync(stepsFile)
    ? (JSON.parse(readFileSync(stepsFile, "utf-8")) as StepsFile)
    : null;
  /** Steps on the capture clock (steps.json). */
  const recSteps = stepsData?.steps ?? [];
  // The scenario decides (captions: true); REC_CAPTIONS=1/0 overrides it here.
  const showCaptions =
    process.env.REC_CAPTIONS !== undefined
      ? process.env.REC_CAPTIONS === "1"
      : (stepsData?.captions ?? false);

  // The scenario decides (format); REC_FORMAT overrides it here, e.g. a
  // vertical video from a landscape capture.
  const format = resolveFormat(stepsData?.format);
  const { viewport, scale } = capture;
  const layout = layoutFor(format, viewport);
  const { width: OUT_WIDTH, height: OUT_HEIGHT } = layout;

  mkdirSync(VIDEOS_DIR, { recursive: true });
  const suffix = format === "landscape" ? "" : "-vertical";
  const out = path.join(VIDEOS_DIR, `${capture.scenario}${suffix}.mp4`);

  // Title cards. A narration segment "intro" / "outro" is spoken over its
  // card, which then lasts at least as long as the audio.
  const cardAudio = narrationForCards(capture.scenario);
  const introMs = stepsData?.intro
    ? Math.max(
        stepsData.intro.durationMs ?? 3000,
        (cardAudio.intro?.ms ?? 0) + 800,
      )
    : 0;
  const outroMs = stepsData?.outro
    ? Math.max(
        stepsData.outro.durationMs ?? 4000,
        (cardAudio.outro?.ms ?? 0) + 800,
      )
    : 0;

  // The video's clock: the recording at a person's pace (spans), each step
  // then fitted to its narration, read now so new audio needs no new
  // recording. Everything logged moves onto this clock.
  const script =
    process.env.REC_NARRATION === "0"
      ? null
      : loadNarration(specFor(capture.scenario));
  const voices = script ? stepVoices(script) : new Map<string, never>();
  const compressWaits =
    process.env.REC_COMPRESS_WAITS !== undefined
      ? process.env.REC_COMPRESS_WAITS !== "0"
      : (stepsData?.compressWaits ?? true);
  // The app's sound: when the scenario asked for it (REC_APP_AUDIO=0/1
  // overrides) and the capture has it. Sound cannot be sped up, so long
  // waits are then cut instead.
  const appLevels =
    process.env.REC_APP_AUDIO === "0"
      ? null
      : (stepsData?.appAudio ??
        (process.env.REC_APP_AUDIO === "1" ? { volume: 1, duckTo: 0.3 } : null));
  const appSound =
    appLevels && capture.audio && existsSync(path.join(captureDir, capture.audio.file))
      ? { ...capture.audio, ...appLevels }
      : null;
  const { map, report } = fitNarration(
    naturalMap(capture.spans ?? [], capture.durationMs, capture.cuts, capture.sources),
    recSteps.map((step) => ({ id: step.id, startMs: step.seconds * 1000 })),
    new Map([...voices].map(([id, voice]) => [id, voice.ms])),
    { compressWaits, speedUpWaits: !appSound },
  );
  const events = retimeCapture(map, {
    pointer: capture.pointer,
    focus: capture.focus,
    navigations: capture.navigations ?? [],
  });
  const steps = recSteps.map((step) => ({
    ...step,
    seconds: map.toOut(step.seconds * 1000) / 1000,
  }));
  const sceneMs = map.outMs;

  const gapMs = script?.gapMs ?? 0;
  const clips = steps.flatMap((step) => {
    const voice = step.id ? voices.get(step.id) : undefined;
    return voice?.audio
      ? [
          {
            file: path.join(RECORDING_DIR, voice.audio),
            at: introMs + step.seconds * 1000,
            ms: Math.max(0, voice.ms - gapMs),
          },
        ]
      : [];
  });
  if (stepsData?.intro && cardAudio.intro)
    clips.push({ file: cardAudio.intro.file, at: 300, ms: cardAudio.intro.ms });
  if (stepsData?.outro && cardAudio.outro) {
    clips.push({
      file: cardAudio.outro.file,
      at: introMs + sceneMs + 300,
      ms: cardAudio.outro.ms,
    });
  }
  // The audio file's clock is the screen file's, shifted by the sound's delay.
  const audioShift = appSound ? capture.video.startMs - appSound.startMs : 0;
  const appAudio: AppAudioMix | null = appSound
    ? {
        file: path.join(captureDir, appSound.file),
        plan: audioPlan(map).map((piece) => ({
          ...piece,
          fileFrom: piece.fileFrom + audioShift,
          fileTo: piece.fileTo + audioShift,
          outFrom: piece.outFrom + introMs,
        })),
        volume: appSound.volume,
        duckTo: appSound.duckTo,
      }
    : null;
  if (appAudio) {
    console.log(
      `App audio: on (volume ${appAudio.volume}, ${appAudio.duckTo} under the voice-over).`,
    );
  }

  const { x: contentX, y: contentY, w: contentW, h: contentH } =
    layout.content;
  // What the camera shows at zoom 1: the whole page, or a slice of the
  // frame's shape (a desktop page in a vertical video).
  const view = layout.view;

  const canvas = createCanvas(OUT_WIDTH, OUT_HEIGHT);
  const ctx = canvas.getContext("2d");
  const background = drawBackground(layout);
  const logo = await loadLogo();
  const track = buildCameraTrack(
    events.focus,
    viewport,
    undefined,
    events.navigations,
    view,
    map.cutsOut,
  );
  writeReport(
    captureDir,
    recSteps,
    report,
    appAudio !== null,
    steps.map((step) => introMs + step.seconds * 1000),
    actionsOutOfFrame(events.focus, track, viewport, view).map((f) => ({
      kind: f.kind,
      atMs: introMs + f.until,
    })),
  );

  // Browser dialogs over their held frames (video ms), with where they start.
  const dialogs = map.segments.flatMap((segment) => {
    if (segment.kind !== "dialog") return [];
    const dialog = (capture.dialogs ?? []).find(
      (d) => Math.abs(d.t - segment.recFrom) <= 1,
    );
    return dialog ? [{ from: segment.outFrom, to: segment.outTo, dialog }] : [];
  });
  const dialogAt = (t: number) =>
    dialogs.find((d) => t >= d.from && t < d.to);

  // The frame shown just before a cut, faded out over the first frames after it.
  const beforeCut = createCanvas(OUT_WIDTH, OUT_HEIGHT);
  let cutFadeFrom = -Infinity;
  const { width: videoW, height: videoH } = capture.video;
  // Each recorded tab: its file, its start, and the canvas its frame goes to.
  const stageFile = capture.stage ? path.join(captureDir, capture.stage.file) : null;
  const tabs: Record<SourceName, { file: string; startMs: number } | null> = {
    app: { file: videoFile, startMs: capture.video.startMs },
    stage:
      capture.stage && stageFile && existsSync(stageFile)
        ? { file: stageFile, startMs: capture.stage.startMs }
        : null,
  };
  const canvases: Record<SourceName, Canvas> = {
    app: createCanvas(videoW, videoH),
    stage: createCanvas(videoW, videoH),
  };
  const hasFrame: Record<SourceName, boolean> = { app: false, stage: false };
  const putFrame = (frame: Buffer, which: SourceName) => {
    const pixels = new Uint8ClampedArray(
      frame.buffer,
      frame.byteOffset,
      frame.byteLength,
    );
    canvases[which]
      .getContext("2d")
      .putImageData(new ImageData(pixels, videoW, videoH), 0, 0);
    hasFrame[which] = true;
  };

  // A tab's recording, decoded by ffmpeg into raw frames at the output rate,
  // aligned so frame i shows the file at i / FPS seconds after the
  // recording's start (off-camera time included: the time map skips it).
  const streamTab = (which: SourceName, fromFileMs: number) => {
    const tab = tabs[which]!;
    const open = (index: number) =>
      readFrames(tab.file, tab.startMs, videoW, videoH, (index * 1000) / FPS);
    const first = Math.max(0, Math.floor((fromFileMs * FPS) / 1000));
    let frames = open(first);
    /** Index of the decoded frame in its canvas (first - 1: none yet). */
    let frameIndex = first - 1;
    return {
      // Forward only: a held or stretched frame is reused, skipped frames are
      // read past, and a long jump (an off-camera step, a cut wait) starts
      // the decoder again at the target instead of decoding what it skips.
      async at(fileMs: number) {
        const target = Math.max(0, Math.floor((fileMs * FPS) / 1000 + 1e-6));
        if (target - frameIndex > RESEEK_FRAMES) {
          await frames.return(undefined);
          frames = open(target);
          frameIndex = target - 1;
        }
        let latest: Buffer | undefined;
        while (frameIndex < target) {
          const next = await frames.next();
          if (next.done) break;
          latest = next.value;
          frameIndex++;
        }
        if (latest) putFrame(latest, which);
      },
      async close() {
        await frames.return(undefined); // stops the decoder
      },
    };
  };
  // One forward-only decoder per tab, the stage's opened when first shown.
  const streamFrames = (fromFileMs = 0): FrameSource => {
    const streams: Partial<Record<SourceName, ReturnType<typeof streamTab>>> = {
      app: streamTab("app", fromFileMs),
    };
    return {
      async at(fileMs, which = "app") {
        if (!tabs[which]) return;
        const stream = (streams[which] ??= streamTab(which, fileMs));
        await stream.at(fileMs);
      },
      async close() {
        for (const stream of Object.values(streams)) await stream.close();
      },
    };
  };
  const seekFrames = (): FrameSource => ({
    async at(fileMs, which = "app") {
      const tab = tabs[which];
      if (!tab) return;
      const frame = await readFrameAt(
        tab.file,
        Math.max(0, fileMs - tab.startMs),
        videoW,
        videoH,
      );
      if (frame) putFrame(frame, which);
    },
    async close() {},
  });
  // The stage is shown whole: the camera stays at its base view.
  const stageCamera = clampCamera(
    { zoom: 1, cx: viewport.width / 2, cy: viewport.height / 2 },
    viewport,
    view,
  );
  const cameraFor = (which: SourceName, t: number) =>
    which === "stage" ? stageCamera : cameraAtTime(track, t, viewport, view);
  // Files the cursor carries, on the video clock.
  const carries = (capture.carries ?? []).map((carry) => ({
    from: map.toOut(carry.from),
    to: map.toOut(carry.to),
    label: carry.label,
  }));
  const carryAt = (t: number) => carries.find((c) => t >= c.from && t < c.to);
  // Stretches without a cursor (scenes), on the video clock.
  const switches = capture.sources ?? [];
  const noCursor = switches.flatMap((s, i) =>
    s.cursor === false
      ? [{ from: map.toOut(s.t), to: i + 1 < switches.length ? map.toOut(switches[i + 1]!.t) : Infinity }]
      : [],
  );
  const cursorHidden = (t: number) => noCursor.some((r) => t >= r.from && t < r.to);

  /** Tab `which`'s recording at time t through `camera`, drawn over the background. */
  const drawView = (
    t: number,
    camera: Camera,
    captions: boolean,
    which: SourceName = "app",
  ) => {
    const visibleW = view.width / camera.zoom;
    const visibleH = view.height / camera.zoom;
    const x0 = camera.cx - visibleW / 2;
    const y0 = camera.cy - visibleH / 2;
    const toOut = (p: { x: number; y: number }) => ({
      x: contentX + ((p.x - x0) / visibleW) * contentW,
      y: contentY + ((p.y - y0) / visibleH) * contentH,
    });

    ctx.drawImage(background, 0, 0);

    // The recording: shadow, rounded frame, the camera's view of the page.
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
    ctx.shadowBlur = 60;
    ctx.shadowOffsetY = 24;
    roundedRect(ctx, contentX, contentY, contentW, contentH, layout.radius);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.restore();

    ctx.save();
    roundedRect(ctx, contentX, contentY, contentW, contentH, layout.radius);
    ctx.clip();
    if (hasFrame[which]) {
      ctx.drawImage(
        canvases[which],
        x0 * scale,
        y0 * scale,
        visibleW * scale,
        visibleH * scale,
        contentX,
        contentY,
        contentW,
        contentH,
      );
    }
    // Cursor size follows the zoom a little, so it stays readable.
    const cursorScale = 1.5 * (1 + (camera.zoom - 1) * 0.45);
    const cursor = cursorHidden(t) ? null : cursorAtTime(events.pointer, t);
    const open = dialogAt(t);
    if (open) {
      // A browser dialog: drawn over the held frame, the cursor answering it.
      drawDialog(
        ctx,
        open.dialog,
        (t - open.from) / Math.max(1, open.to - open.from),
        { x: contentX, y: contentY, w: contentW, h: contentH, unit: contentW / view.width },
        cursor ? toOut(cursor) : null,
        cursorScale,
      );
      ctx.restore();
      if (captions) drawCaptionAt(t);
      return;
    }
    for (const click of clicksAtTime(events.pointer, t)) {
      drawRipple(ctx, toOut(click), click.age, cursorScale);
    }
    if (cursor) {
      const pressed = events.pointer.some(
        (s) => s.kind === "down" && t >= s.t && t - s.t < 140,
      );
      drawCursor(ctx, toOut(cursor), cursorScale * (pressed ? 0.85 : 1));
      const carry = carryAt(t);
      if (carry) drawGhost(ctx, toOut(cursor), carry.label, cursorScale);
    }
    ctx.restore();

    if (captions) drawCaptionAt(t);
  };

  const drawCaptionAt = (t: number) => {
    if (!showCaptions) return;
    const caption = captionAtTime(steps, t, sceneMs);
    if (caption) drawCaption(ctx, caption, layout);
  };

  /**
   * The recording at time t, drawn over the background. While a show
   * transition runs, the view the camera leaves and the one it reaches are
   * both drawn from the current frame and joined as a slide, fade or cube.
   */
  const drawScene = (t: number, which: SourceName = "app") => {
    if (which === "stage") {
      drawView(t, stageCamera, true, "stage");
      return;
    }
    const turn = transitionAtTime(track, t);
    if (!turn) {
      drawView(t, cameraAtTime(track, t, viewport, view), true);
      return;
    }
    drawView(t, clampCamera(turn.from, viewport, view), false);
    grabContent(faceA);
    drawView(t, cameraAtTime(track, t, viewport, view), false);
    grabContent(faceB);
    composeTurn(turn.kind, turn.p);
    drawCaptionAt(t);
  };

  /**
   * A tab change (app ↔ stage) right after the switch: the last frame of the
   * tab left behind and the live frame of the tab reached, joined by the
   * switch's transition. Both tabs' frames must be in their canvases.
   */
  const drawSourceTurn = (
    t: number,
    turn: { at: number; from: SourceName; to: SourceName; kind: SourceTransition; p: number },
  ) => {
    drawView(t, cameraFor(turn.from, turn.at - 1), false, turn.from);
    grabContent(faceA);
    drawView(t, cameraFor(turn.to, t), false, turn.to);
    grabContent(faceB);
    composeTurn(turn.kind, turn.p);
    drawCaptionAt(t);
  };

  /**
   * Joins faceA (the view left) and faceB (the view reached), `p` (0-1)
   * through: a cube turn, a slide, a fade, or a lift (A shrinks and fades
   * back over B, like a window going behind).
   */
  const composeTurn = (kind: string, rawP: number) => {
    const p = easeInOutCubic(rawP);
    const box = { x: contentX, y: contentY, w: contentW, h: contentH };
    ctx.drawImage(background, 0, 0);
    if (kind === "cube") {
      drawCubeTurn(ctx, faceA, faceB, rawP, box);
    } else {
      ctx.save();
      ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
      ctx.shadowBlur = 60;
      ctx.shadowOffsetY = 24;
      roundedRect(ctx, contentX, contentY, contentW, contentH, layout.radius);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.restore();
      ctx.save();
      roundedRect(ctx, contentX, contentY, contentW, contentH, layout.radius);
      ctx.clip();
      if (kind === "slide") {
        const offset = p * contentW;
        ctx.drawImage(faceA, contentX - offset, contentY);
        ctx.drawImage(faceB, contentX + contentW - offset, contentY);
      } else if (kind === "lift") {
        ctx.drawImage(faceB, contentX, contentY);
        const scale = 1 - 0.08 * p;
        const w = contentW * scale;
        const h = contentH * scale;
        ctx.globalAlpha = 1 - p;
        ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
        ctx.shadowBlur = 40;
        ctx.drawImage(faceA, contentX + (contentW - w) / 2, contentY + (contentH - h) / 2, w, h);
      } else if (kind === "cut") {
        ctx.drawImage(faceB, contentX, contentY);
      } else {
        ctx.drawImage(faceA, contentX, contentY);
        ctx.globalAlpha = p;
        ctx.drawImage(faceB, contentX, contentY);
      }
      ctx.restore();
    }
  };

  /** Fetches the frames scene time t needs and draws it (tab changes included). */
  const drawSceneAt = async (sceneT: number, frames: FrameSource) => {
    const turn = sourceTransitionAt(map.switchesOut, sceneT);
    if (turn) {
      await frames.at(map.toRec(turn.at - 0.5), turn.from);
      await frames.at(map.toRec(sceneT), turn.to);
      drawSourceTurn(sceneT, turn);
      return;
    }
    const which = map.sourceAt(sceneT);
    await frames.at(map.toRec(sceneT), which);
    drawScene(sceneT, which);
  };

  // Steps marked with a transition: over their time (recording ms) the video
  // shows a cube turn from the frame where the step starts to the frame where
  // the next one starts, instead of what the page did meanwhile.
  const transitions = steps.flatMap((step, i) =>
    step.transition === "cube"
      ? [
          {
            from: step.seconds * 1000,
            to: (steps.at(i + 1)?.seconds ?? sceneMs / 1000) * 1000,
          },
        ]
      : [],
  );
  const faceA = createCanvas(contentW, contentH);
  const faceB = createCanvas(contentW, contentH);
  const grabContent = (face: typeof faceA) => {
    const faceCtx = face.getContext("2d");
    faceCtx.clearRect(0, 0, contentW, contentH);
    faceCtx.drawImage(
      canvas,
      contentX,
      contentY,
      contentW,
      contentH,
      0,
      0,
      contentW,
      contentH,
    );
  };

  const totalMs = introMs + sceneMs + outroMs;
  const frameMs = 1000 / FPS;
  const box = { x: contentX, y: contentY, w: contentW, h: contentH };
  // A cube step's two faces, made once when the turn starts.
  const cubeA = createCanvas(contentW, contentH);
  const cubeB = createCanvas(contentW, contentH);
  let cubeFor: { from: number; to: number } | null = null;
  const drawAt = async (
    t: number,
    frames: FrameSource,
    { fadeCuts = true }: { fadeCuts?: boolean } = {},
  ) => {
    const sceneT = t - introMs;

    // Steps marked "cube": a turn from the page as the step starts to the
    // page as the next one starts, instead of what the page did meanwhile.
    const turn =
      t >= introMs
        ? transitions.find((tr) => sceneT >= tr.from && sceneT < tr.to)
        : undefined;
    if (turn) {
      if (cubeFor !== turn) {
        await drawSceneAt(turn.from, frames);
        grabContent(cubeA);
        await drawSceneAt(turn.to, frames);
        grabContent(cubeB);
        cubeFor = turn;
      }
      ctx.drawImage(background, 0, 0);
      const p = (sceneT - turn.from) / Math.max(1, turn.to - turn.from);
      drawCubeTurn(ctx, cubeA, cubeB, p, box);
      return;
    }

    if (t < introMs && stepsData?.intro) {
      // Intro: the card fades in; in its last half second the recording's
      // first frame shows through it.
      const crossFrom = introMs - CROSSFADE_MS;
      if (t >= crossFrom) {
        await drawSceneAt(0, frames);
        drawCard(
          ctx,
          background,
          logo,
          stepsData.intro,
          1 - (t - crossFrom) / CROSSFADE_MS,
          layout,
        );
      } else {
        ctx.drawImage(background, 0, 0);
        drawCard(
          ctx,
          background,
          logo,
          stepsData.intro,
          Math.min(1, t / FADE_IN_MS),
          layout,
        );
      }
    } else if (t < introMs + sceneMs) {
      const prevT = sceneT - frameMs;
      if (!fadeCuts) cutFadeFrom = -Infinity;
      else if (map.cutsOut.some((at) => at > prevT && at <= sceneT)) {
        // The canvas still holds the last frame before the cut.
        beforeCut.getContext("2d").drawImage(canvas, 0, 0);
        cutFadeFrom = sceneT;
      }
      await drawSceneAt(sceneT, frames);
      const fade = (sceneT - cutFadeFrom) / CUT_FADE_MS;
      if (fade >= 0 && fade < 1) {
        ctx.save();
        ctx.globalAlpha = 1 - fade;
        ctx.drawImage(beforeCut, 0, 0);
        ctx.restore();
      }
    } else {
      // Outro: the card comes in over the last frame of the recording.
      await drawSceneAt(sceneMs, frames);
      if (stepsData?.outro) {
        const shown = t - introMs - sceneMs;
        drawCard(
          ctx,
          background,
          logo,
          stepsData.outro,
          Math.min(1, shown / CROSSFADE_MS),
          layout,
        );
      }
    }
  };

  // Exact enough that a moving camera or cursor always changes the key;
  // held frames repeat the very same values.
  const exact = (n: number) => n.toFixed(3);
  const frameKey = (t: number): string | null => {
    const sceneT = t - introMs;
    if (t < introMs) {
      // The intro card holds still between its fade-in and the cross-fade.
      return stepsData?.intro &&
        t >= FADE_IN_MS &&
        t < introMs - CROSSFADE_MS
        ? "intro"
        : null;
    }
    if (sceneT >= sceneMs) {
      if (!stepsData?.outro) return `end`;
      return sceneT - sceneMs >= CROSSFADE_MS ? "outro" : null;
    }
    if (transitions.some((tr) => sceneT >= tr.from && sceneT < tr.to))
      return null;
    if (transitionAtTime(track, sceneT)) return null;
    if (map.cutsOut.some((at) => sceneT >= at && sceneT < at + CUT_FADE_MS + frameMs))
      return null;
    if (clicksAtTime(events.pointer, sceneT).length > 0) return null;
    if (dialogAt(sceneT)) return null;
    if (sourceTransitionAt(map.switchesOut, sceneT)) return null;
    if (carryAt(sceneT)) return null;
    const which = map.sourceAt(sceneT);
    const source = `${which}:${Math.floor((map.toRec(sceneT) * FPS) / 1000 + 1e-6)}`;
    const camera = cameraFor(which, sceneT);
    const cursor = cursorHidden(sceneT) ? null : cursorAtTime(events.pointer, sceneT);
    const pressed = events.pointer.some(
      (p) => p.kind === "down" && sceneT >= p.t && sceneT - p.t < 140,
    );
    const caption = showCaptions ? captionAtTime(steps, sceneT, sceneMs) : null;
    return [
      source,
      exact(camera.zoom),
      exact(camera.cx),
      exact(camera.cy),
      cursor ? `${exact(cursor.x)},${exact(cursor.y)}` : "-",
      pressed,
      caption ? `${caption.text}@${exact(caption.alpha)}` : "-",
    ].join("|");
  };

  return {
    scenario: capture.scenario,
    out,
    layout,
    introMs,
    sceneMs,
    totalMs,
    steps: steps.map((step) => ({
      id: step.id,
      title: step.title,
      startMs: introMs + step.seconds * 1000,
    })),
    report,
    clips,
    appAudio,
    canvas,
    ctx,
    streamFrames,
    seekFrames,
    drawAt,
    frameKey,
    toRec: (t: number) => map.toRec(t - introMs),
  };
}

/**
 * Renders one capture folder; returns the MP4 path. `draft`: half size,
 * quick encode, to videos/<name>.draft.mp4. `steps` [a, b] (1-based, recorded
 * steps): only from step a's start to step b's end, no cards, to
 * videos/<name>.steps-a-b.mp4 (or the draft file).
 */
export async function render(
  captureDir: string,
  options: { draft?: boolean; steps?: [number, number] } = {},
): Promise<string> {
  const job = await prepare(captureDir);
  const { width, height } = job.layout;
  let fromMs = 0;
  let toMs = job.totalMs;
  let out = job.out;
  if (options.steps) {
    const [a, b] = options.steps;
    if (!(a >= 1 && b >= a && b <= job.steps.length)) {
      throw new Error(
        `--steps ${a}-${b}: the recording has steps 1-${job.steps.length}.`,
      );
    }
    fromMs = job.steps[a - 1]!.startMs;
    toMs = job.steps[b]?.startMs ?? job.introMs + job.sceneMs;
    out = out.replace(/\.mp4$/, `.steps-${a}-${b}.mp4`);
  }
  if (options.draft) out = out.replace(/(\.steps-\d+-\d+)?\.mp4$/, ".draft.mp4");
  const firstFrame = Math.ceil((fromMs / 1000) * FPS);
  const endFrame = Math.ceil((toMs / 1000) * FPS);
  const startMs = (firstFrame * 1000) / FPS;
  const clips = job.clips
    .map((clip) => ({ ...clip, at: clip.at - startMs }))
    .filter((clip) => clip.at < toMs - startMs);
  const appAudio = job.appAudio
    ? { ...job.appAudio, plan: shiftPlan(job.appAudio.plan, startMs) }
    : null;
  const frames = job.streamFrames(job.toRec(startMs));
  const ffmpeg = startEncoder(out, clips, job.layout, {
    draft: options.draft,
    durationMs: options.steps ? toMs - startMs : undefined,
    appAudio,
  });
  try {
    // A frame that looks like the previous one (held, stretched, a still
    // screen) is sent again without drawing it.
    let lastKey: string | null = null;
    let lastFrame: Buffer | null = null;
    for (let i = firstFrame; i < endFrame; i++) {
      const t = (i * 1000) / FPS;
      const key = job.frameKey(t);
      if (key === null || key !== lastKey || !lastFrame) {
        await job.drawAt(t, frames);
        const pixels = job.ctx.getImageData(0, 0, width, height).data;
        lastFrame = Buffer.from(
          pixels.buffer,
          pixels.byteOffset,
          pixels.byteLength,
        );
      }
      lastKey = key;
      await write(ffmpeg.stdin, lastFrame);
      if (i % FPS === 0) {
        process.stdout.write(
          `\r${job.scenario}: ${(t / 1000).toFixed(0)} / ${(job.totalMs / 1000).toFixed(0)} s`,
        );
      }
    }
  } catch (error) {
    // Close the encoder's input: it ends the video at the frames so far and
    // exits. Left open, it waits for more frames (ignoring SIGTERM) and keeps
    // this process running.
    ffmpeg.stdin.end();
    throw error;
  } finally {
    await frames.close();
  }
  ffmpeg.stdin.end();
  await new Promise<void>((resolve, reject) => {
    ffmpeg.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`)),
    );
  });
  process.stdout.write("\n");
  return out;
}

/** Width of each step's check frame. */
const CHECK_WIDTH = 960;
/** Contact sheet: columns and tile width. */
const SHEET_COLUMNS = 3;
const SHEET_TILE = 640;

/**
 * A quick look without a video: each recorded step's last frame (just
 * before the next step starts), drawn exactly as the video shows it, saved
 * to .captures/<scenario>/check/NN-<id>.png and joined into check/sheet.png.
 * Prints the narration fit. Returns the sheet's path.
 */
export async function check(captureDir: string): Promise<string> {
  const job = await prepare(captureDir);
  const dir = path.join(captureDir, "..", "check");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const { width, height } = job.layout;
  const frames = job.seekFrames();
  const tiles: Array<{ label: string; image: Canvas }> = [];
  const lastFrame = (ms: number) =>
    Math.max(0, (Math.ceil((ms / 1000) * FPS) - 1) * (1000 / FPS));
  for (const [i, step] of job.steps.entries()) {
    const end = job.steps[i + 1]?.startMs ?? job.introMs + job.sceneMs;
    await job.drawAt(lastFrame(end), frames, { fadeCuts: false });
    const scaled = createCanvas(CHECK_WIDTH, Math.round((height * CHECK_WIDTH) / width));
    scaled.getContext("2d").drawImage(job.canvas, 0, 0, scaled.width, scaled.height);
    const label = `${String(i + 1).padStart(2, "0")} ${step.id ?? step.title}`;
    const name = `${label.replace(/[^\w-]+/g, "-")}.png`;
    writeFileSync(path.join(dir, name), await scaled.encode("png"));
    tiles.push({ label, image: scaled });
  }
  await frames.close();

  const tileH = Math.round((height * SHEET_TILE) / width);
  const columns = Math.min(SHEET_COLUMNS, Math.max(1, tiles.length));
  const rows = Math.max(1, Math.ceil(tiles.length / columns));
  const sheet = createCanvas(columns * SHEET_TILE, rows * tileH);
  const sheetCtx = sheet.getContext("2d");
  sheetCtx.fillStyle = "#000000";
  sheetCtx.fillRect(0, 0, sheet.width, sheet.height);
  tiles.forEach(({ label, image }, i) => {
    const x = (i % columns) * SHEET_TILE;
    const y = Math.floor(i / columns) * tileH;
    sheetCtx.drawImage(image, x, y, SHEET_TILE, tileH);
    sheetCtx.fillStyle = "rgba(0, 0, 0, 0.7)";
    sheetCtx.fillRect(x, y, SHEET_TILE, 30);
    sheetCtx.fillStyle = "#ffffff";
    sheetCtx.font = `bold 18px ${FONT}`;
    sheetCtx.textBaseline = "middle";
    sheetCtx.fillText(label, x + 10, y + 15);
  });
  const file = path.join(dir, "sheet.png");
  writeFileSync(file, await sheet.encode("png"));
  return file;
}

/** scenarios/<name>.spec.ts of a capture's scenario (its narration file sits next to it). */
function specFor(scenario: string): string {
  return path.join(RECORDING_DIR, "scenarios", `${scenario}.spec.ts`);
}

/**
 * How each step was fitted to its narration, and where it starts in the
 * video (chapters): printed when the scenario has narration, and written to
 * render-report.json next to steps.json.
 */
function writeReport(
  captureDir: string,
  steps: Array<{ id?: string; title: string }>,
  report: Array<StepFit>,
  /** Whether the app's own sound is mixed in (noted on every row). */
  appAudio: boolean,
  /** Where each step starts in the video (ms, opening card included). */
  videoStartMs: Array<number>,
  /** Actions the camera does not show (video ms, opening card included). */
  outOfFrame: Array<{ kind: string; atMs: number }>,
): void {
  const stepAt = (ms: number) =>
    Math.max(0, videoStartMs.findLastIndex((start) => start <= ms));
  const rows = report.map((fit) => ({
    step: steps[fit.index]?.title ?? String(fit.index + 1),
    videoStartMs: Math.round(videoStartMs[fit.index] ?? 0),
    ...fit,
    appAudio,
    outOfFrame: outOfFrame
      .filter((action) => stepAt(action.atMs) === fit.index)
      .map((action) => ({ kind: action.kind, atMs: Math.round(action.atMs) })),
  }));
  writeFileSync(
    path.join(captureDir, "..", "render-report.json"),
    `${JSON.stringify(rows, null, 2)}\n`,
  );
  for (const row of rows) {
    for (const action of row.outOfFrame) {
      console.warn(
        `Out of frame: ${row.step}, ${action.kind} at ${(action.atMs / 1000).toFixed(1)} s. ` +
          "The camera cannot show it (e.g. a vertical crop too narrow for the scene): " +
          "split the scene, show the area first, or use another format.",
      );
    }
  }
  if (!report.some((fit) => fit.voiceMs !== null)) return;
  const s = (ms: number | null) =>
    ms === null ? "—" : ms === 0 ? "" : `${(ms / 1000).toFixed(1)} s`;
  console.log("Narration fit (render-report.json):");
  console.table(
    rows.map((row) => ({
      Step: row.step,
      Natural: s(row.naturalMs),
      Voice: s(row.voiceMs),
      Freeze: s(row.freezeMs),
      Shortened: s(row.shortenedMs),
      Silence: s(row.silenceMs),
    })),
  );
}

/** Audio for the title cards: narration segments "intro" / "outro" with audio. */
function narrationForCards(scenario: string): {
  intro?: { file: string; ms: number };
  outro?: { file: string; ms: number };
} {
  const script = loadNarration(specFor(scenario));
  if (!script) return {};
  const find = (id: string) => {
    const segment = script.segments.find((s) => s.step === id);
    if (!segment?.audio) return undefined;
    const { ms, measured } = segmentLength(segment, script);
    return measured
      ? { file: path.join(RECORDING_DIR, segment.audio), ms }
      : undefined;
  };
  return { intro: find("intro"), outro: find("outro") };
}

async function loadLogo(): Promise<Image | null> {
  if (!LOGO_FILE) return null;
  try {
    return await loadImage(LOGO_FILE);
  } catch {
    return null;
  }
}

/** A title card over the brand background: logo, title, subtitle. */
function drawCard(
  ctx: SKRSContext2D,
  background: Canvas,
  logo: Image | null,
  card: Card,
  alpha: number,
  layout: Layout,
) {
  if (alpha <= 0) return;
  const { title: titleSize, subtitle: subtitleSize, logo: logoSize } =
    layout.card;
  ctx.save();
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.drawImage(background, 0, 0);
  const centreX = layout.width / 2;
  const maxWidth = layout.card.maxWidth;
  // Long titles wrap (a vertical frame is narrow).
  ctx.font = `700 ${titleSize}px ${FONT}`;
  const titleLines = wrapText(ctx, card.title, maxWidth);
  ctx.font = `400 ${subtitleSize}px ${FONT}`;
  const subtitleLines = card.subtitle
    ? wrapText(ctx, card.subtitle, maxWidth)
    : [];
  const titleLine = titleSize * 1.15;
  const subtitleLine = subtitleSize * 1.3;
  // Logo, title and subtitle as one block, centred on the screen.
  const logoH = logo ? logoSize + logoSize * 0.45 : 0;
  const titleH = titleLines.length * titleLine;
  const subtitleH = subtitleLines.length
    ? subtitleSize * 0.9 + subtitleLines.length * subtitleLine
    : 0;
  let y = (layout.height - (logoH + titleH + subtitleH)) / 2;
  if (logo) {
    const width = (logo.width / logo.height) * logoSize;
    ctx.drawImage(logo, centreX - width / 2, y, width, logoSize);
    y += logoH;
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 ${titleSize}px ${FONT}`;
  for (const line of titleLines) {
    ctx.fillText(line, centreX, y + titleLine / 2, maxWidth);
    y += titleLine;
  }
  if (subtitleLines.length) {
    y += subtitleSize * 0.9;
    ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
    ctx.font = `400 ${subtitleSize}px ${FONT}`;
    for (const line of subtitleLines) {
      ctx.fillText(line, centreX, y + subtitleLine / 2, maxWidth);
      y += subtitleLine;
    }
  }
  ctx.restore();
}

/** Splits text into lines no wider than maxWidth (at the context's font). */
function wrapText(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
): Array<string> {
  const lines: Array<string> = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The file a cursor carries (drag and drop): a page icon with its name,
 * just below and right of the cursor tip, slightly see-through.
 */
function drawGhost(
  ctx: SKRSContext2D,
  at: { x: number; y: number },
  label: string,
  scale: number,
) {
  const s = scale;
  const x = at.x + 14 * s;
  const y = at.y + 16 * s;
  const w = 22 * s;
  const h = 28 * s;
  const fold = 7 * s;
  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
  ctx.shadowBlur = 10 * s;
  ctx.shadowOffsetY = 3 * s;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w - fold, y);
  ctx.lineTo(x + w, y + fold);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "rgba(0, 0, 0, 0.25)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = `rgb(${BRAND.r}, ${BRAND.g}, ${BRAND.b})`;
  ctx.fillRect(x + 4 * s, y + h - 9 * s, w - 8 * s, 4 * s);
  ctx.font = `600 ${8 * s}px ${FONT}`;
  const textW = ctx.measureText(label).width;
  const pillX = x + w + 6 * s;
  const pillY = y + h / 2 - 8 * s;
  roundedRect(ctx, pillX, pillY, textW + 12 * s, 16 * s, 8 * s);
  ctx.fillStyle = "rgba(20, 24, 33, 0.85)";
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.fillText(label, pillX + 6 * s, pillY + 8 * s);
  ctx.restore();
}

/**
 * A browser dialog (alert, confirm, prompt, beforeunload) over the content
 * area, `p` (0-1) through its held frame: it fades in, the cursor moves to
 * the chosen button and clicks it, the dialog fades out. Sizes are CSS
 * pixels times `area.unit`, independent of the camera.
 */
function drawDialog(
  ctx: SKRSContext2D,
  dialog: CaptureDialog,
  p: number,
  area: { x: number; y: number; w: number; h: number; unit: number },
  cursorFrom: { x: number; y: number } | null,
  cursorScale: number,
) {
  const u = area.unit;
  const alpha = p < 0.12 ? p / 0.12 : p > 0.85 ? Math.max(0, (1 - p) / 0.15) : 1;
  const width = Math.min(448 * u, area.w * 0.92);
  const pad = 24 * u;
  const leave = dialog.type === "beforeunload";
  const title = leave ? "Leave site?" : dialog.origin ? `${dialog.origin} says` : "";
  const message = leave
    ? "Changes that you made may not be saved."
    : dialog.message;
  ctx.save();
  ctx.font = `${15 * u}px ${FONT}`;
  const lines = wrapText(ctx, message, width - 2 * pad).slice(0, 8);
  const lineH = 21 * u;
  const titleH = title ? 30 * u : 0;
  const inputH = dialog.type === "prompt" ? 44 * u : 0;
  const buttonH = 32 * u;
  const height = pad + titleH + lines.length * lineH + inputH + 20 * u + buttonH + pad;
  const x = area.x + (area.w - width) / 2;
  const y = area.y + Math.min(area.h * 0.12, 64 * u);

  // The page dims a little behind it.
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "rgba(0, 0, 0, 0.18)";
  ctx.fillRect(area.x, area.y, area.w, area.h);
  ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
  ctx.shadowBlur = 30 * u;
  ctx.shadowOffsetY = 8 * u;
  roundedRect(ctx, x, y, width, height, 12 * u);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.shadowColor = "transparent";

  let cy = y + pad;
  ctx.textBaseline = "top";
  if (title) {
    ctx.font = `600 ${16 * u}px ${FONT}`;
    ctx.fillStyle = "#1f2328";
    ctx.fillText(title, x + pad, cy);
    cy += titleH;
  }
  ctx.font = `${15 * u}px ${FONT}`;
  ctx.fillStyle = "#3d4248";
  for (const line of lines) {
    ctx.fillText(line, x + pad, cy);
    cy += lineH;
  }
  if (inputH) {
    cy += 8 * u;
    roundedRect(ctx, x + pad, cy, width - 2 * pad, 30 * u, 6 * u);
    ctx.strokeStyle = "#2f6feb";
    ctx.lineWidth = 2 * u;
    ctx.stroke();
    ctx.fillStyle = "#1f2328";
    ctx.textBaseline = "middle";
    ctx.fillText(dialog.text ?? "", x + pad + 10 * u, cy + 15 * u);
    ctx.textBaseline = "top";
    cy += inputH - 8 * u;
  }

  // Buttons, right-aligned: [Cancel] [OK] (an alert has OK only).
  const labels =
    dialog.type === "alert" ? ["OK"] : leave ? ["Cancel", "Leave"] : ["Cancel", "OK"];
  const buttonW = 84 * u;
  const gap = 8 * u;
  const by = y + height - pad - buttonH;
  const pressed = p >= 0.6 && p < 0.72;
  const chosen = dialog.accepted ? labels.length - 1 : 0;
  const centres: Array<{ x: number; y: number }> = [];
  labels.forEach((label, i) => {
    const bx = x + width - pad - (labels.length - i) * buttonW - (labels.length - 1 - i) * gap;
    const primary = i === labels.length - 1;
    roundedRect(ctx, bx, by, buttonW, buttonH, 8 * u);
    ctx.fillStyle = primary
      ? pressed && i === chosen ? "#1f56c4" : "#2f6feb"
      : pressed && i === chosen ? "#d9dde3" : "#eef1f4";
    ctx.fill();
    ctx.fillStyle = primary ? "#ffffff" : "#1f2328";
    ctx.font = `500 ${14 * u}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, bx + buttonW / 2, by + buttonH / 2);
    ctx.textAlign = "left";
    centres.push({ x: bx + buttonW / 2, y: by + buttonH / 2 });
  });
  ctx.restore();

  // The cursor: from where it was to the chosen button, a click, then it stays.
  const target = centres[chosen]!;
  const from = cursorFrom ?? { x: target.x, y: target.y + 80 * u };
  const move = easeInOutCubic(Math.min(1, Math.max(0, (p - 0.12) / 0.43)));
  const at = {
    x: from.x + (target.x - from.x) * move,
    y: from.y + (target.y - from.y) * move,
  };
  if (p >= 0.6 && p < 0.6 + 500 / 1500) {
    drawRipple(ctx, at, ((p - 0.6) * 1500) % 500, cursorScale);
  }
  drawCursor(ctx, at, cursorScale * (pressed ? 0.85 : 1));
}

/** Where everything goes in the output frame, per video format. */
interface Layout {
  width: number;
  height: number;
  /** Where the recording sits in the frame. */
  content: { x: number; y: number; w: number; h: number };
  radius: number;
  /** What the camera shows of the page at zoom 1 (CSS pixels). */
  view: Size;
  /** Caption: centre of its pill, font size, widest line. */
  caption: { y: number; size: number; maxWidth: number };
  card: { title: number; subtitle: number; logo: number; maxWidth: number };
}

function layoutFor(format: VideoFormat, viewport: Size): Layout {
  if (format === "landscape") {
    // The page, as large as fits inside the margins, whatever its shape.
    const content = fitBox(viewport, 1920, 1080, 72, 40);
    return {
      width: 1920,
      height: 1080,
      content,
      radius: 20,
      view: viewport,
      caption: {
        y: content.y + content.h - 60,
        size: 34,
        maxWidth: content.w - 160,
      },
      card: { title: 68, subtitle: 36, logo: 96, maxWidth: 1680 },
    };
  }
  // Vertical (1080x1920). Shorts and Reels draw their own title and buttons
  // over the bottom fifth: captions sit above it.
  const width = 1080;
  const height = 1920;
  const card = { title: 76, subtitle: 40, logo: 120, maxWidth: 920 };
  if (format === "vertical-fit") {
    // The whole page across the middle; the caption just below it.
    const content = fitBox(viewport, width, height, 36, 64);
    return {
      width,
      height,
      content,
      radius: 24,
      view: viewport,
      caption: {
        y: Math.min(content.y + content.h + 110, height * 0.7),
        size: 44,
        maxWidth: 900,
      },
      card,
    };
  }
  // "vertical" and "vertical-crop": a 9:16 frame filled by the page. A page
  // of another shape (a desktop page, or a window Chrome would not make
  // narrow enough) is shown as a slice the camera moves over.
  const content = { x: 36, y: 64, w: width - 72, h: height - 128 };
  return {
    width,
    height,
    content,
    radius: 28,
    view: baseView(viewport, content.w / content.h),
    caption: { y: height * 0.7, size: 44, maxWidth: 900 },
    card,
  };
}

/** A page of any shape, as large as fits in the frame inside the margins, centred. */
function fitBox(
  page: Size,
  width: number,
  height: number,
  marginX: number,
  marginY: number,
): { x: number; y: number; w: number; h: number } {
  const fit = Math.min(
    (width - marginX * 2) / page.width,
    (height - marginY * 2) / page.height,
  );
  const w = Math.round(page.width * fit);
  const h = Math.round(page.height * fit);
  return {
    x: Math.round((width - w) / 2),
    y: Math.round((height - h) / 2),
    w,
    h,
  };
}

/**
 * Raw RGBA frames of the recording at FPS, starting at recording time
 * `fromMs` (default 0). The
 * screen recording usually starts a little before that (startMs < 0): skip
 * ahead. If it started later, repeat its first frame until then. Off-camera
 * time stays in: the time map (timemap.ts) decides which frame shows when.
 */
async function* readFrames(
  file: string,
  startMs: number,
  width: number,
  height: number,
  /** Recording time of the first frame wanted (a --steps range). */
  fromMs = 0,
): AsyncGenerator<Buffer> {
  // Recording time r is at r - startMs in the file.
  const offset = fromMs - startMs;
  const args = ["-v", "error"];
  if (offset > 0) args.push("-ss", (offset / 1000).toFixed(3));
  args.push("-i", file);
  if (offset < 0) {
    args.push(
      "-vf",
      `tpad=start_duration=${(-offset / 1000).toFixed(3)}:start_mode=clone`,
    );
  }
  args.push("-r", String(FPS), "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1");
  const decoder = spawn("ffmpeg", args, {
    stdio: ["ignore", "pipe", "ignore"],
  });

  const frameSize = width * height * 4;
  // Collect pieces and join them once per frame: joining on every piece
  // copies the growing buffer again and again.
  const pieces: Array<Buffer> = [];
  let size = 0;
  try {
    for await (const chunk of decoder.stdout as AsyncIterable<Buffer>) {
      pieces.push(chunk);
      size += chunk.length;
      while (size >= frameSize) {
        const joined = Buffer.concat(pieces, size);
        yield joined.subarray(0, frameSize);
        const rest = joined.subarray(frameSize);
        pieces.length = 0;
        if (rest.length > 0) pieces.push(rest);
        size = rest.length;
      }
    }
  } finally {
    // The video may be longer than needed: stop the decoder quietly.
    decoder.stdout.destroy();
    decoder.kill();
  }
}

/**
 * ffmpeg reading raw RGBA frames from stdin, mixing in the app's sound
 * (ducked under the voice) and the voice-over clips.
 */
function startEncoder(
  out: string,
  clips: Array<{ file: string; at: number; ms: number }>,
  size: { width: number; height: number },
  options: {
    draft?: boolean;
    durationMs?: number;
    appAudio?: AppAudioMix | null;
  } = {},
) {
  const args = [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-s",
    `${size.width}x${size.height}`,
    "-r",
    String(FPS),
    "-i",
    "pipe:0",
  ];
  // The app's sound is input 1 (before the clips), when mixed.
  const app = options.appAudio ?? null;
  if (app) args.push("-i", app.file);
  const first = app ? 2 : 1;
  const existing = clips.filter((clip) => existsSync(clip.file));
  for (const clip of existing) args.push("-i", clip.file);
  // A clip that started before the video (a --steps range) is trimmed instead.
  const place = (clip: { at: number }, i: number) =>
    clip.at >= 0
      ? `[${i + first}:a]adelay=${Math.round(clip.at)}:all=1[a${i}]`
      : `[${i + first}:a]atrim=start=${(-clip.at / 1000).toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`;
  const sources = [
    ...(app ? ["[app]"] : []),
    ...existing.map((_, i) => `[a${i}]`),
  ];
  if (sources.length > 0) {
    const graph = [
      ...(app
        ? [
            appAudioFilter(app.plan, existing, {
              volume: app.volume,
              duckTo: app.duckTo,
              inputIndex: 1,
              outLabel: "app",
            }),
          ]
        : []),
      ...existing.map(place),
      sources.length === 1
        ? `${sources[0]}anull[aout]`
        : `${sources.join("")}amix=inputs=${sources.length}:normalize=0[aout]`,
    ];
    args.push(
      "-filter_complex",
      graph.join(";"),
      "-map",
      "0:v",
      "-map",
      "[aout]",
    );
    args.push("-c:a", "aac", "-b:a", "192k");
  }
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    options.draft ? "ultrafast" : "medium",
    "-crf",
    options.draft ? "30" : "18",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
  );
  // Draft: half the size (drawing stays full size), quick to encode.
  if (options.draft) args.push("-vf", "scale=iw/2:-2");
  if (options.durationMs !== undefined)
    args.push("-t", (options.durationMs / 1000).toFixed(3));
  args.push(out);
  return spawn("ffmpeg", args, { stdio: ["pipe", "inherit", "inherit"] });
}

function write(stream: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  return new Promise((resolve) => {
    if (stream.write(chunk)) resolve();
    else stream.once("drain", () => resolve());
  });
}

/** Dark gradient with a soft brand glow, drawn once. */
function drawBackground({ width: OUT_WIDTH, height: OUT_HEIGHT }: Size) {
  const bg = createCanvas(OUT_WIDTH, OUT_HEIGHT);
  const ctx = bg.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, OUT_WIDTH, OUT_HEIGHT);
  gradient.addColorStop(0, "#0f172a");
  gradient.addColorStop(1, "#1e1b2e");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, OUT_WIDTH, OUT_HEIGHT);
  const glow = ctx.createRadialGradient(
    OUT_WIDTH * 0.85,
    OUT_HEIGHT * 0.1,
    0,
    OUT_WIDTH * 0.85,
    OUT_HEIGHT * 0.1,
    Math.max(OUT_WIDTH, OUT_HEIGHT) * 0.6,
  );
  glow.addColorStop(0, `rgba(${BRAND.r}, ${BRAND.g}, ${BRAND.b}, 0.22)`);
  glow.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, OUT_WIDTH, OUT_HEIGHT);
  return bg;
}

function roundedRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** macOS-style arrow: black with a white outline, tip at `at`. */
function drawCursor(
  ctx: SKRSContext2D,
  at: { x: number; y: number },
  scale: number,
) {
  const points: Array<[number, number]> = [
    [0, 0],
    [0, 17],
    [4.2, 13.2],
    [7, 19.6],
    [9.6, 18.5],
    [6.9, 12.2],
    [12.3, 12.2],
  ];
  ctx.save();
  ctx.translate(at.x, at.y);
  ctx.scale(scale, scale);
  ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1.5;
  ctx.beginPath();
  points.forEach(([x, y], i) =>
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y),
  );
  ctx.closePath();
  ctx.fillStyle = "#111111";
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = 1.4;
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  ctx.restore();
}

/**
 * One frame of a cube turn: face A (the page before) turns away to the left
 * while face B (the page after) comes in from the right as the cube's next
 * side, in perspective, with the turning faces shaded. `p` runs 0 → 1; `box`
 * is where the recording sits in the frame (face A fills it at p = 0, face B
 * at p = 1).
 */
function drawCubeTurn(
  ctx: SKRSContext2D,
  faceA: Parameters<SKRSContext2D["drawImage"]>[0],
  faceB: Parameters<SKRSContext2D["drawImage"]>[0],
  p: number,
  box: { x: number; y: number; w: number; h: number },
) {
  const eased = p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
  const angle = (eased * Math.PI) / 2;
  const half = box.w / 2; // the cube's half width; its centre is this deep
  const camera = half + box.w * 1.6; // distance from the viewer to the front plane's centre
  const centreX = box.x + half;
  const centreY = box.y + box.h / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Mid-turn the shared edge comes closer than the front plane and would grow
  // past the frame: pull the cube back so that edge stays inside, a little
  // further at the middle of the turn.
  const nearest = (camera - half) / (camera - half * (sin + cos));
  const pull = (1 - 0.08 * Math.sin(2 * angle)) / Math.max(1, nearest);
  // A point of the cube (u across, w in depth, around its centre) on screen.
  const project = (u: number, w: number) => {
    const x = u * cos + w * sin;
    const z = -u * sin + w * cos; // -half = front plane
    const scale = ((camera - half) / (camera + z)) * pull;
    return { x: centreX + x * scale, scale, z };
  };
  // Face A: u from -half to half at w = -half; face B: w from -half to half at u = half.
  const faces = [
    {
      image: faceA,
      at: (k: number) => project(-half + k * box.w, -half),
      light: cos,
    },
    {
      image: faceB,
      at: (k: number) => project(half, -half + k * box.w),
      light: sin,
    },
  ].sort((a, b) => b.at(0.5).z - a.at(0.5).z); // far face first

  const STRIPS = 160;
  for (const face of faces) {
    if (face.light <= 0.001) continue;
    // The face in vertical strips, each scaled for its depth (a perspective
    // warp); strips overlap a little so no gaps show between them.
    const edge: Array<{ x: number; half: number }> = [];
    for (let s = 0; s <= STRIPS; s++) {
      const point = face.at(s / STRIPS);
      edge.push({ x: point.x, half: (box.h * point.scale) / 2 });
    }
    for (let s = 0; s < STRIPS; s++) {
      const left = edge[s]!;
      const right = edge[s + 1]!;
      const width = right.x - left.x;
      if (width <= 0) continue;
      const height = left.half + right.half;
      ctx.drawImage(
        face.image,
        (s / STRIPS) * box.w,
        0,
        box.w / STRIPS,
        box.h,
        left.x,
        centreY - height / 2,
        width + 0.75,
        height,
      );
    }
    // The turning face darkens, drawn once over its outline (per-strip
    // shading would double up where strips overlap and show as lines).
    const shade = 0.55 * (1 - face.light);
    if (shade > 0.01) {
      ctx.beginPath();
      edge.forEach((p, k) =>
        k === 0
          ? ctx.moveTo(p.x, centreY - p.half)
          : ctx.lineTo(p.x, centreY - p.half),
      );
      for (const p of [...edge].reverse()) ctx.lineTo(p.x, centreY + p.half);
      ctx.closePath();
      ctx.fillStyle = `rgba(0, 0, 0, ${shade.toFixed(3)})`;
      ctx.fill();
    }
  }
}

/** A step note at the bottom of the frame: white text on a dark pill. */
function drawCaption(
  ctx: SKRSContext2D,
  caption: { text: string; alpha: number },
  layout: Layout,
) {
  const { y: centreY, size, maxWidth } = layout.caption;
  const centreX = layout.width / 2;
  ctx.save();
  ctx.globalAlpha = caption.alpha;
  ctx.font = `600 ${size}px ${FONT}`;
  const lines = wrapText(ctx, caption.text, maxWidth);
  const width = Math.max(...lines.map((line) => ctx.measureText(line).width));
  const lineH = size * 1.3;
  const padX = size * 0.9;
  const padY = (size * 1.9 - lineH) / 2;
  const height = lines.length * lineH + padY * 2;
  const x = centreX - width / 2 - padX;
  const y = centreY - height / 2;
  ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 6;
  roundedRect(
    ctx,
    x,
    y,
    width + padX * 2,
    height,
    Math.min(height / 2, size * 0.95),
  );
  ctx.fillStyle = "rgba(15, 23, 42, 0.86)";
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  lines.forEach((line, i) => {
    ctx.fillText(line, centreX, y + padY + lineH * (i + 0.5) + 1);
  });
  ctx.restore();
}

/** Expanding ring where a click happened. */
function drawRipple(
  ctx: SKRSContext2D,
  at: { x: number; y: number },
  ageMs: number,
  scale: number,
) {
  const p = ageMs / 500;
  const radius = (6 + 22 * (1 - (1 - p) ** 3)) * scale;
  ctx.save();
  ctx.beginPath();
  ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${BRAND.r}, ${BRAND.g}, ${BRAND.b}, ${0.25 * (1 - p)})`;
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = `rgba(${BRAND.r}, ${BRAND.g}, ${BRAND.b}, ${0.85 * (1 - p)})`;
  ctx.stroke();
  ctx.restore();
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.replace(/./g, "$&$&") : value;
  const n = Number.parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// --- CLI ---------------------------------------------------------------------

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const flags = new Set<string>();
  let target: string | undefined;
  let stepsArg: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--steps") stepsArg = rest[++i];
    else if (arg.startsWith("--steps=")) stepsArg = arg.slice("--steps=".length);
    else if (arg.startsWith("--")) flags.add(arg);
    else target ??= arg;
  }
  const range = stepsArg?.match(/^(\d+)(?:-(\d+))?$/);
  if (command !== "render" || (stepsArg !== undefined && !range)) {
    console.error(
      `Usage: ${KIT_CMD} render [<scenario or capture folder>] [--check | --draft] [--steps <a>-<b>]`,
    );
    process.exit(1);
  }
  const steps: [number, number] | undefined = range
    ? [Number(range[1]), Number(range[2] ?? range[1])]
    : undefined;
  const captures = findCaptures();
  const dir = !target
    ? captures[0]
    : existsSync(path.join(target, "events.json"))
      ? target
      : captures.find((c) => {
          const data = JSON.parse(
            readFileSync(path.join(c, "events.json"), "utf-8"),
          ) as {
            scenario: string;
          };
          return data.scenario.startsWith(target);
        });
  if (!dir) {
    console.error(
      `No video capture found. Record one first: ${KIT_CMD} video <scenario>`,
    );
    process.exit(1);
  }
  // Errors set the exit code instead of escaping: see the end of run.ts.
  try {
    if (flags.has("--check")) {
      const sheet = await check(dir);
      console.log(`Check: ${path.relative(process.cwd(), sheet)}`);
    } else {
      const out = await render(dir, { draft: flags.has("--draft"), steps });
      console.log(`Video: ${path.relative(process.cwd(), out)}`);
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
