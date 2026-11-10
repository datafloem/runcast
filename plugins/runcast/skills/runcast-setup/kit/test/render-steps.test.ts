// The renderer on a made-up capture (an ffmpeg clip and its events), so the
// timing is exact and no browser is needed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { textHash } from "../core/narration.ts";

let project: string;
let render: (dir: string, options?: Record<string, unknown>) => Promise<string>;

/** A capture folder of `name`: a 960x540 clip of the given colours, one per second. */
function makeCapture(name: string, colours: Array<string>, steps: Array<Record<string, unknown>>, extra = {}): string {
  const root = path.join(project, ".captures", name);
  const dir = path.join(root, "capture");
  mkdirSync(dir, { recursive: true });
  const inputs = colours.flatMap((c) => ["-f", "lavfi", "-i", `color=c=${c}:s=960x540:d=1:r=30`]);
  execFileSync("ffmpeg", [
    "-v", "error", "-y", ...inputs,
    "-filter_complex", `${colours.map((_, i) => `[${i}]`).join("")}concat=n=${colours.length}:v=1:a=0`,
    "-pix_fmt", "yuv420p", path.join(dir, "screen.mp4"),
  ]);
  writeFileSync(
    path.join(dir, "events.json"),
    JSON.stringify({
      scenario: name,
      viewport: { width: 960, height: 540 },
      scale: 1,
      durationMs: colours.length * 1000,
      video: { file: "screen.mp4", startMs: 0, width: 960, height: 540 },
      pointer: [],
      focus: [],
      navigations: [],
      spans: [],
    }),
  );
  writeFileSync(path.join(root, "steps.json"), JSON.stringify({ scenario: name, steps, ...extra }));
  return dir;
}

/** Colour (r, g, b) at the centre of the video's frame at `seconds`. */
function centre(video: string, seconds: number): [number, number, number] {
  const px = execFileSync("ffmpeg", [
    "-v", "error", "-ss", String(seconds), "-i", video, "-frames:v", "1",
    "-vf", "crop=2:2:iw/2:ih/2", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ]);
  return [px[0]!, px[1]!, px[2]!];
}

before(async () => {
  project = mkdtempSync(path.join(tmpdir(), "runcast-render-"));
  writeFileSync(
    path.join(project, "recording.config.ts"),
    `export default { dir: import.meta.dirname, name: "Render", baseURL: "http://localhost" };\n`,
  );
  process.env.REC_PROJECT = project;
  ({ render } = (await import("../scripts/video/render.ts")) as unknown as { render: typeof render });
});
after(() => rmSync(project, { recursive: true, force: true }));

test("--steps starting on a cube step draws the page on the cube", async () => {
  // Step b (a cube) starts between two frames, at 510 ms, in the red second.
  const dir = makeCapture("cube", ["red", "green", "blue"], [
    { id: "a", seconds: 0, startMs: 0, title: "A" },
    { id: "b", seconds: 0.5, startMs: 510, title: "B", transition: "cube" },
    { id: "c", seconds: 1.5, startMs: 1500, title: "C" },
  ]);
  const video = await render(dir, { draft: true, steps: [2, 2] });
  // The turn starts from the page as b starts: red, not an empty face.
  const [r, g, b] = centre(video, 0);
  assert.ok(r > 180 && g < 80 && b < 80, `centre ${r},${g},${b}`);
});

test("REC_NARRATION=0 leaves the card's voice out too", async () => {
  const audio = path.join(project, "narration", "cards", "intro.wav");
  mkdirSync(path.dirname(audio), { recursive: true });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", audio]);
  mkdirSync(path.join(project, "scenarios"), { recursive: true });
  const text = "Welcome to the customers app.";
  writeFileSync(
    path.join(project, "scenarios", "cards.narration.json"),
    JSON.stringify({
      language: "en",
      wordsPerMinute: 150,
      gapMs: 400,
      segments: [
        { step: "intro", text, durationMs: 1000, audio: "narration/cards/intro.wav", audioTextHash: textHash(text) },
      ],
    }),
  );
  const dir = makeCapture("cards", ["red", "green"], [{ id: "a", seconds: 0, startMs: 0, title: "A" }], {
    intro: { title: "Customers", durationMs: 1500 },
  });
  process.env.REC_NARRATION = "0";
  try {
    const video = await render(dir, { draft: true });
    const streams = execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", video],
      { encoding: "utf-8" },
    );
    assert.doesNotMatch(streams, /audio/);
  } finally {
    delete process.env.REC_NARRATION;
  }
});

test("in vertical-crop the stage is shown whole, not its middle slice", async () => {
  const dir = makeCapture("crop", ["green", "green"], [{ id: "a", seconds: 0, startMs: 0, title: "A" }], {
    format: "vertical-crop",
  });
  // The stage: red with a blue band along its left edge, shown from the start.
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi",
    "-i", "color=c=red:s=960x540:d=2:r=30,drawbox=x=0:y=0:w=96:h=540:color=blue:t=fill",
    "-pix_fmt", "yuv420p", path.join(dir, "stage.mp4"),
  ]);
  const eventsFile = path.join(dir, "events.json");
  const events = JSON.parse((await import("node:fs")).readFileSync(eventsFile, "utf-8")) as Record<string, unknown>;
  writeFileSync(
    eventsFile,
    JSON.stringify({
      ...events,
      stage: { file: "stage.mp4", startMs: 0 },
      sources: [{ t: 0, source: "stage", transition: "cut", cursor: false }],
    }),
  );
  const video = await render(dir, { draft: true });
  // Near the left edge of the picture, halfway down: the stage's blue band.
  const px = execFileSync("ffmpeg", [
    "-v", "error", "-ss", "1", "-i", video, "-frames:v", "1",
    "-vf", "crop=2:2:iw*0.07:ih/2", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ]);
  assert.ok(px[2]! > 150 && px[0]! < 100, `left edge ${px[0]},${px[1]},${px[2]}`);
});
