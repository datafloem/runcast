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
  buildCameraTrack,
  cameraAtTime,
  captionAtTime,
  clicksAtTime,
  cursorAtTime,
  type Focus,
  type PointerSample,
} from "./timeline.ts";
import { loadNarration, segmentLength } from "../../core/narration.ts";
import { kitCommand, loadProject } from "../../core/project.ts";

const project = await loadProject();
const RECORDING_DIR = project.dir;
const KIT_CMD = kitCommand(RECORDING_DIR);
const RESULTS_DIR = path.join(RECORDING_DIR, ".results");
const VIDEOS_DIR = path.join(RECORDING_DIR, "videos");

const OUT_WIDTH = 1920;
const OUT_HEIGHT = 1080;
const FPS = Number(process.env.REC_VIDEO_FPS ?? 30);
/** Space around the recording inside the output frame. */
const MARGIN_X = 72;
const MARGIN_Y = 40;
const RADIUS = 20;
const BRAND = hexToRgb(project.brand?.color ?? "#f97316");
const FADE_IN_MS = 400;
const CROSSFADE_MS = 500;
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
}

interface Card {
  title: string;
  subtitle?: string;
  durationMs?: number;
}

interface StepsFile {
  scenario: string;
  captions?: boolean;
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

  mkdirSync(VIDEOS_DIR, { recursive: true });
  const out = path.join(VIDEOS_DIR, `${capture.scenario}.mp4`);

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
  const ffmpeg = startEncoder(out, clips);

  const { viewport, scale } = capture;
  // The page, as large as fits inside the margins, whatever its shape.
  const fit = Math.min(
    (OUT_WIDTH - MARGIN_X * 2) / viewport.width,
    (OUT_HEIGHT - MARGIN_Y * 2) / viewport.height,
  );
  const contentW = Math.round(viewport.width * fit);
  const contentH = Math.round(viewport.height * fit);
  const contentX = Math.round((OUT_WIDTH - contentW) / 2);
  const contentY = Math.round((OUT_HEIGHT - contentH) / 2);

  const canvas = createCanvas(OUT_WIDTH, OUT_HEIGHT);
  const ctx = canvas.getContext("2d");
  const background = drawBackground();
  const logo = await loadLogo();
  const track = buildCameraTrack(
    capture.focus,
    viewport,
    undefined,
    capture.navigations ?? [],
  );

  // The recording, decoded by ffmpeg into raw frames at the output rate,
  // aligned so frame i shows the page at i / FPS seconds after the start.
  const { width: videoW, height: videoH } = capture.video;
  const frames = readFrames(videoFile, capture.video.startMs, videoW, videoH);
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
  const drawScene = (t: number) => {
    const camera = cameraAtTime(track, t, viewport);
    const visibleW = viewport.width / camera.zoom;
    const visibleH = viewport.height / camera.zoom;
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
    roundedRect(ctx, contentX, contentY, contentW, contentH, RADIUS);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.restore();

    ctx.save();
    roundedRect(ctx, contentX, contentY, contentW, contentH, RADIUS);
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

    if (showCaptions) {
      const caption = captionAtTime(steps, t, sceneMs);
      if (caption) {
        drawCaption(
          ctx,
          caption,
          contentX + contentW / 2,
          contentY + contentH - 56,
        );
      }
    }
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
        );
      } else {
        ctx.drawImage(background, 0, 0);
        drawCard(
          ctx,
          background,
          logo,
          stepsData.intro,
          Math.min(1, t / FADE_IN_MS),
        );
      }
    } else if (t < introMs + sceneMs) {
      if (firstFrameReady) firstFrameReady = false;
      else await nextFrame();
      drawScene(t - introMs);
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
        );
      }
    }

    await emit(i, t);
  }
  await frames.return(undefined);
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
) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.drawImage(background, 0, 0);
  const centreX = OUT_WIDTH / 2;
  // Logo, title and subtitle as one block, centred on the screen.
  const logoH = logo ? 96 + 44 : 0;
  const subtitleH = card.subtitle ? 32 + 36 : 0;
  let y = (OUT_HEIGHT - (logoH + 68 + subtitleH)) / 2;
  if (logo) {
    const width = (logo.width / logo.height) * 96;
    ctx.drawImage(logo, centreX - width / 2, y, width, 96);
    y += logoH;
  }
  y += 34; // middle of the title line
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = '700 68px "Helvetica Neue", Helvetica, Arial, sans-serif';
  ctx.fillText(card.title, centreX, y, OUT_WIDTH - 240);
  if (card.subtitle) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
    ctx.font = '400 36px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.fillText(card.subtitle, centreX, y + 34 + 32 + 18, OUT_WIDTH - 240);
  }
  ctx.restore();
}

/**
 * Raw RGBA frames of the recording at FPS, starting at recording time 0. The
 * screen recording usually starts a little before that (startMs < 0): skip
 * ahead. If it started later, repeat its first frame until then.
 */
async function* readFrames(
  file: string,
  startMs: number,
  width: number,
  height: number,
): AsyncGenerator<Buffer> {
  const args = ["-v", "error"];
  if (startMs < 0) args.push("-ss", (-startMs / 1000).toFixed(3));
  args.push("-i", file);
  if (startMs > 0) {
    args.push(
      "-vf",
      `tpad=start_duration=${(startMs / 1000).toFixed(3)}:start_mode=clone`,
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

/** ffmpeg reading raw RGBA frames from stdin, mixing in the voice-over clips. */
function startEncoder(out: string, clips: Array<{ file: string; at: number }>) {
  const args = [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-s",
    `${OUT_WIDTH}x${OUT_HEIGHT}`,
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
function drawBackground() {
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
    OUT_WIDTH * 0.6,
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
  centreX: number,
  baselineY: number,
) {
  ctx.save();
  ctx.globalAlpha = caption.alpha;
  ctx.font = '600 34px "Helvetica Neue", Helvetica, Arial, sans-serif';
  const width = ctx.measureText(caption.text).width;
  const padX = 30;
  const height = 64;
  const x = centreX - width / 2 - padX;
  const y = baselineY - height / 2 - 4;
  ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 6;
  roundedRect(ctx, x, y, width + padX * 2, height, height / 2);
  ctx.fillStyle = "rgba(15, 23, 42, 0.86)";
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(caption.text, centreX, y + height / 2 + 1);
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
  const out = await render(dir);
  console.log(`Video: ${path.relative(process.cwd(), out)}`);
}
