// Turns a video-mode capture (screen recording + events.json) into an MP4: framed,
// with a camera that zooms to the action, a drawn cursor with click ripples,
// and the scenario's voice-over clips placed at their steps.
//
//   node <recording folder>/.kit/cli.ts render [<scenario or capture folder>]
//
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
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import {
  baseView,
  buildCameraTrack,
  cameraAtTime,
  captionAtTime,
  clampCamera,
  clicksAtTime,
  cursorAtTime,
  easeInOutCubic,
  transitionAtTime,
  type Camera,
  type Focus,
  type PointerSample,
  type Size,
} from "./timeline.ts";
import { resolveFormat, type VideoFormat } from "../../core/format.ts";
import { loadNarration, segmentLength } from "../../core/narration.ts";
import { kitCommand, loadProject } from "../../core/project.ts";

const project = await loadProject();
const RECORDING_DIR = project.dir;
const KIT_CMD = kitCommand(RECORDING_DIR);
const RESULTS_DIR = path.join(RECORDING_DIR, ".results");
const VIDEOS_DIR = path.join(RECORDING_DIR, "videos");

const FPS = Number(process.env.REC_VIDEO_FPS ?? 30);
const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const BRAND = hexToRgb(project.brand?.color ?? "#f97316");
const FADE_IN_MS = 400;
const CROSSFADE_MS = 500;
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
  /** Off-camera time cut out of the screen recording (core/video-capture.ts). */
  cuts?: Array<{ at: number; ms: number }>;
}

interface Card {
  title: string;
  subtitle?: string;
  durationMs?: number;
}

interface StepsFile {
  scenario: string;
  captions?: boolean;
  /** The scenario's video format (core/format.ts). */
  format?: string;
  intro?: Card;
  outro?: Card;
  steps: Array<{
    seconds: number;
    title: string;
    note?: string;
    narration?: { audio: string | null };
    /** "cube": a cube turn over this step, from the frame before to the one after. */
    transition?: string;
  }>;
}

export function findCaptures(): Array<string> {
  if (!existsSync(RESULTS_DIR)) return [];
  return readdirSync(RESULTS_DIR)
    .map((dir) => path.join(RESULTS_DIR, dir, "capture"))
    .filter((dir) => existsSync(path.join(dir, "events.json")))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

/** Renders one capture folder; returns the MP4 path. */
export async function render(captureDir: string): Promise<string> {
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
  const steps = stepsData?.steps ?? [];
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
  const sceneMs = capture.durationMs;

  const clips = steps.flatMap((step) =>
    step.narration?.audio
      ? [
          {
            file: path.join(RECORDING_DIR, step.narration.audio),
            at: introMs + step.seconds * 1000,
          },
        ]
      : [],
  );
  if (stepsData?.intro && cardAudio.intro)
    clips.push({ file: cardAudio.intro.file, at: 300 });
  if (stepsData?.outro && cardAudio.outro) {
    clips.push({ file: cardAudio.outro.file, at: introMs + sceneMs + 300 });
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
    capture.focus,
    viewport,
    undefined,
    capture.navigations ?? [],
    view,
    (capture.cuts ?? []).map((cut) => cut.at),
  );

  // The recording, decoded by ffmpeg into raw frames at the output rate,
  // aligned so frame i shows the page at i / FPS seconds after the start.
  const { width: videoW, height: videoH } = capture.video;
  const cuts = capture.cuts ?? [];
  const frames = readFrames(
    videoFile,
    capture.video.startMs,
    videoW,
    videoH,
    cuts,
  );
  // The frame shown just before a cut, faded out over the first frames after it.
  const beforeCut = createCanvas(OUT_WIDTH, OUT_HEIGHT);
  let cutFadeFrom = -Infinity;
  const source = createCanvas(videoW, videoH);
  const sourceCtx = source.getContext("2d");
  let hasFrame = false;
  /** The first frame was read early, for the intro's cross-fade. */
  let firstFrameReady = false;
  const nextFrame = async () => {
    const next = await frames.next();
    if (next.done) return;
    const pixels = new Uint8ClampedArray(
      next.value.buffer,
      next.value.byteOffset,
      next.value.byteLength,
    );
    sourceCtx.putImageData(new ImageData(pixels, videoW, videoH), 0, 0);
    hasFrame = true;
  };

  /** The recording at time t (ms since it started), drawn over the background. */
  /** The recording at time t through `camera`, drawn over the background. */
  const drawView = (t: number, camera: Camera, captions: boolean) => {
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
    if (hasFrame) {
      ctx.drawImage(
        source,
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
    for (const click of clicksAtTime(capture.pointer, t)) {
      drawRipple(ctx, toOut(click), click.age, cursorScale);
    }
    const cursor = cursorAtTime(capture.pointer, t);
    if (cursor) {
      const pressed = capture.pointer.some(
        (s) => s.kind === "down" && t >= s.t && t - s.t < 140,
      );
      drawCursor(ctx, toOut(cursor), cursorScale * (pressed ? 0.85 : 1));
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
  const drawScene = (t: number) => {
    const turn = transitionAtTime(track, t);
    if (!turn) {
      drawView(t, cameraAtTime(track, t, viewport, view), true);
      return;
    }
    drawView(t, clampCamera(turn.from, viewport, view), false);
    grabContent(faceA);
    drawView(t, cameraAtTime(track, t, viewport, view), false);
    grabContent(faceB);
    const p = easeInOutCubic(turn.p);
    const box = { x: contentX, y: contentY, w: contentW, h: contentH };
    ctx.drawImage(background, 0, 0);
    if (turn.kind === "cube") {
      drawCubeTurn(ctx, faceA, faceB, turn.p, box);
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
      if (turn.kind === "slide") {
        const offset = p * contentW;
        ctx.drawImage(faceA, contentX - offset, contentY);
        ctx.drawImage(faceB, contentX + contentW - offset, contentY);
      } else {
        ctx.drawImage(faceA, contentX, contentY);
        ctx.globalAlpha = p;
        ctx.drawImage(faceB, contentX, contentY);
      }
      ctx.restore();
    }
    drawCaptionAt(t);
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
  const totalFrames = Math.ceil((totalMs / 1000) * FPS);
  const ffmpeg = startEncoder(out, clips, layout);
  const emit = async (i: number, t: number) => {
    const pixels = ctx.getImageData(0, 0, OUT_WIDTH, OUT_HEIGHT).data;
    await write(
      ffmpeg.stdin,
      Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength),
    );
    if (i % FPS === 0) {
      process.stdout.write(
        `\r${capture.scenario}: ${(t / 1000).toFixed(0)} / ${(totalMs / 1000).toFixed(0)} s`,
      );
    }
  };
  try {
    for (let i = 0; i < totalFrames; i++) {
      const t = (i * 1000) / FPS;

      const turn = transitions.find(
        (tr) => t - introMs >= tr.from && t - introMs < tr.to,
      );
      if (turn && t >= introMs) {
        // Face A: the page as the step starts; face B: as the next one starts,
        // read ahead through the frames the turn replaces.
        if (firstFrameReady) firstFrameReady = false;
        else await nextFrame();
        drawScene(t - introMs);
        grabContent(faceA);
        const end = Math.min(
          totalFrames,
          Math.ceil(((introMs + turn.to) / 1000) * FPS),
        );
        for (let j = i + 1; j < end; j++) await nextFrame();
        drawScene(turn.to);
        grabContent(faceB);
        for (let j = i; j < end; j++) {
          ctx.drawImage(background, 0, 0);
          drawCubeTurn(ctx, faceA, faceB, (j - i) / Math.max(1, end - i), {
            x: contentX,
            y: contentY,
            w: contentW,
            h: contentH,
          });
          await emit(j, (j * 1000) / FPS);
        }
        turn.to = -1; // done
        i = end - 1;
        continue;
      }

      if (t < introMs && stepsData?.intro) {
        // Intro: the card fades in; in its last half second the recording's
        // first frame shows through it.
        const crossFrom = introMs - CROSSFADE_MS;
        if (t >= crossFrom) {
          if (!firstFrameReady) {
            await nextFrame();
            firstFrameReady = true;
          }
          drawScene(0);
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
        const sceneT = t - introMs;
        const prevT = sceneT - 1000 / FPS;
        if (cuts.some((cut) => cut.at > prevT && cut.at <= sceneT && i > 0)) {
          // The canvas still holds the last frame before the cut.
          beforeCut.getContext("2d").drawImage(canvas, 0, 0);
          cutFadeFrom = sceneT;
        }
        if (firstFrameReady) firstFrameReady = false;
        else await nextFrame();
        drawScene(sceneT);
        const fade = (sceneT - cutFadeFrom) / CUT_FADE_MS;
        if (fade >= 0 && fade < 1) {
          ctx.save();
          ctx.globalAlpha = 1 - fade;
          ctx.drawImage(beforeCut, 0, 0);
          ctx.restore();
        }
      } else {
        // Outro: the card comes in over the last frame of the recording.
        drawScene(sceneMs);
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

      await emit(i, t);
    }
  } catch (error) {
    // Close the encoder's input: it ends the video at the frames so far and
    // exits. Left open, it waits for more frames (ignoring SIGTERM) and keeps
    // this process running.
    ffmpeg.stdin.end();
    throw error;
  } finally {
    await frames.return(undefined); // stops the decoder
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

/** Audio for the title cards: narration segments "intro" / "outro" with audio. */
function narrationForCards(scenario: string): {
  intro?: { file: string; ms: number };
  outro?: { file: string; ms: number };
} {
  const script = loadNarration(
    path.join(RECORDING_DIR, "scenarios", `${scenario}.spec.ts`),
  );
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
 * Raw RGBA frames of the recording at FPS, starting at recording time 0. The
 * screen recording usually starts a little before that (startMs < 0): skip
 * ahead. If it started later, repeat its first frame until then. Off-camera
 * time (`cuts`) is dropped, so the frames follow the recording's clock.
 */
async function* readFrames(
  file: string,
  startMs: number,
  width: number,
  height: number,
  cuts: Array<{ at: number; ms: number }> = [],
): AsyncGenerator<Buffer> {
  const args = ["-v", "error"];
  if (startMs < 0) args.push("-ss", (-startMs / 1000).toFixed(3));
  args.push("-i", file);
  const filters: Array<string> = [];
  if (cuts.length > 0) {
    // In the decoder's time (0 at recording time 0 after the seek above, or
    // at the video's own start when it began late), each cut sits after the
    // ones before it.
    const offset = startMs < 0 ? 0 : -startMs / 1000;
    let before = 0;
    const spans = cuts.map((cut) => {
      const from = (cut.at + before) / 1000 + offset;
      before += cut.ms;
      return { from, to: from + cut.ms / 1000, ms: cut.ms };
    });
    const inCut = spans
      .map((c) => `between(t,${c.from.toFixed(3)},${c.to.toFixed(3)})`)
      .join("+");
    const shift = spans
      .map((c) => `gte(T,${c.to.toFixed(3)})*${(c.ms / 1000).toFixed(3)}`)
      .join("+");
    filters.push(`select='not(${inCut})'`, `setpts='PTS-(${shift})/TB'`);
  }
  if (startMs > 0) {
    filters.push(
      `tpad=start_duration=${(startMs / 1000).toFixed(3)}:start_mode=clone`,
    );
  }
  if (filters.length > 0) args.push("-vf", filters.join(","));
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

/** ffmpeg reading raw RGBA frames from stdin, mixing in the voice-over clips. */
function startEncoder(
  out: string,
  clips: Array<{ file: string; at: number }>,
  size: { width: number; height: number },
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
  const existing = clips.filter((clip) => existsSync(clip.file));
  for (const clip of existing) args.push("-i", clip.file);
  if (existing.length > 0) {
    const delays = existing
      .map(
        (clip, i) => `[${i + 1}:a]adelay=${Math.round(clip.at)}:all=1[a${i}]`,
      )
      .join(";");
    const mix =
      existing.length === 1
        ? "[a0]anull[aout]"
        : `${existing.map((_, i) => `[a${i}]`).join("")}amix=inputs=${existing.length}:normalize=0[aout]`;
    args.push(
      "-filter_complex",
      `${delays};${mix}`,
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
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    out,
  );
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
  const [command, target] = process.argv.slice(2);
  if (command !== "render") {
    console.error(`Usage: ${KIT_CMD} render [<scenario or capture folder>]`);
    process.exit(1);
  }
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
    const out = await render(dir);
    console.log(`Video: ${path.relative(process.cwd(), out)}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
