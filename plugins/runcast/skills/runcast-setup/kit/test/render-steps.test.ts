// The renderer on a made-up capture (an ffmpeg clip and its events), so the
// timing is exact and no browser is needed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("a voice much shorter than its step is flagged", async () => {
  const audio = path.join(project, "narration", "quiet", "a.wav");
  mkdirSync(path.dirname(audio), { recursive: true });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", audio]);
  mkdirSync(path.join(project, "scenarios"), { recursive: true });
  const text = "Every order of the customer.";
  writeFileSync(
    path.join(project, "scenarios", "quiet.narration.json"),
    JSON.stringify({
      language: "en",
      wordsPerMinute: 150,
      gapMs: 400,
      segments: [{ step: "a", text, durationMs: 1000, audio: "narration/quiet/a.wav", audioTextHash: textHash(text) }],
    }),
  );
  const dir = makeCapture("quiet", Array(8).fill("red"), [{ id: "a", seconds: 0, startMs: 0, title: "Orders" }], {
    compressWaits: false,
  });
  const warnings: Array<string> = [];
  const warn = console.warn;
  console.warn = (message: string) => warnings.push(String(message));
  try {
    await render(dir, { draft: true });
  } finally {
    console.warn = warn;
  }
  assert.match(warnings.join("\n"), /Orders.*6\.6 s of silence/s);
});

// Scenes added at render time.

/** A scene folder and its own capture: a clip of one colour, the scene starting at 400 ms. */
async function makeScene(name: string, colour: string, duration: number, options: { hash?: string } = {}) {
  const { sceneHash } = await import("../core/scene-contract.ts");
  const folder = path.join(project, "scenes", name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "index.html"), `<!-- ${name} -->`);
  const root = path.join(project, ".captures", `scene-${name}`);
  mkdirSync(path.join(root, "capture"), { recursive: true });
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${colour}:s=960x540:d=${(duration + 800) / 1000}:r=30`,
    "-pix_fmt", "yuv420p", path.join(root, "capture", "screen.mp4"),
  ]);
  writeFileSync(
    path.join(root, "capture", "events.json"),
    JSON.stringify({
      scenario: `scene-${name}`, viewport: { width: 960, height: 540 }, scale: 1, durationMs: duration + 800,
      video: { file: "screen.mp4", startMs: 0, width: 960, height: 540 }, pointer: [], focus: [], navigations: [], spans: [],
    }),
  );
  writeFileSync(
    path.join(root, "scene.json"),
    JSON.stringify({
      hash: options.hash ?? sceneHash(folder), startMs: 400, duration, beats: [{ id: "a", at: 0 }],
      viewport: { width: 960, height: 540 }, scale: 1,
    }),
  );
}

/** A take of 6 s of app (red) with a placeholder of `name` (2 s when recorded) at 1 s. */
function takeWithScene(name: string): string {
  const dir = makeCapture(`take-${name}`, Array(6).fill("red"), [
    { id: "intro", seconds: 0, startMs: 0, title: "1. Intro" },
    { id: "s", seconds: 1, startMs: 995, title: "2. Scene" },
    { id: "s.a", seconds: 1, startMs: 1000, title: "Scene › a" },
    { id: "after", seconds: 3, startMs: 3000, title: "3. After" },
  ]);
  const file = path.join(dir, "events.json");
  const events = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  writeFileSync(
    file,
    JSON.stringify({
      ...events,
      durationMs: 8000,
      spans: [{ from: 1000, to: 3000, kind: "scene", outMs: 2000, scene: name, in: "cut", out: "cut" }],
      scenes: [{ t: 1000, name, duration: 2000, beats: [{ id: "a", at: 0 }], in: "cut", out: "cut", hash: "recorded", step: "s", title: "Scene" }],
    }),
  );
  return dir;
}

const lengthOf = (video: string) =>
  Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video], { encoding: "utf-8" }));

test("a scene added at render time shows its own frames at the right times", async () => {
  await makeScene("blue", "blue", 2000);
  const video = await render(takeWithScene("blue"), { draft: true });
  assert.ok(Math.abs(lengthOf(video) - 8) < 0.2, `length ${lengthOf(video)}`);
  const [r1, , b1] = centre(video, 0.5);
  const [r2, , b2] = centre(video, 2.0);
  const [r3, , b3] = centre(video, 5.0);
  assert.ok(r1 > 180 && b1 < 80, `0.5 s ${r1},${b1}`);
  assert.ok(b2 > 180 && r2 < 80, `2.0 s ${r2},${b2}`);
  assert.ok(r3 > 180 && b3 < 80, `5.0 s ${r3},${b3}`);
});

test("a scene of another length re-renders without a new take", async () => {
  await makeScene("longer", "blue", 3500);
  const dir = takeWithScene("longer");
  const video = await render(dir, { draft: true });
  assert.ok(Math.abs(lengthOf(video) - 9.5) < 0.2, `length ${lengthOf(video)}`);
  const [r, , b] = centre(video, 4.0);
  assert.ok(b > 180 && r < 80, `4.0 s ${r},${b}`);
  const report = JSON.parse(readFileSync(path.join(dir, "..", "render-report.json"), "utf-8")) as Array<{ step: string; videoStartMs: number }>;
  assert.equal(report.find((row) => row.step === "3. After")?.videoStartMs, 4500);
});

test("a changed scene folder is recorded again when rendering", async () => {
  const { cpSync } = await import("node:fs");
  const { sceneHash } = await import("../core/scene-contract.ts");
  const folder = path.join(project, "scenes", "flow");
  cpSync(path.resolve(import.meta.dirname, "..", "..", "..", "runcast-scene", "example"), folder, { recursive: true });
  await makeScene("flow", "green", 2000, { hash: "older" });
  // makeScene wrote a placeholder page over the example: put the example back.
  cpSync(path.resolve(import.meta.dirname, "..", "..", "..", "runcast-scene", "example", "index.html"), path.join(folder, "index.html"));
  const video = await render(takeWithScene("flow"), { draft: true });
  const info = JSON.parse(readFileSync(path.join(project, ".captures", "scene-flow", "scene.json"), "utf-8")) as { hash: string; duration: number };
  assert.equal(info.hash, sceneHash(folder));
  assert.equal(info.duration, 5600);
  assert.ok(Math.abs(lengthOf(video) - (6 + 5.6)) < 0.3, `length ${lengthOf(video)}`);
});

test("narration over a scene's beat holds the scene added at render time", async () => {
  await makeScene("voiced", "blue", 2000);
  const audio = path.join(project, "narration", "take-voiced", "a.wav");
  mkdirSync(path.dirname(audio), { recursive: true });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3.5", audio]);
  mkdirSync(path.join(project, "scenarios"), { recursive: true });
  const text = "Each order reaches the customer.";
  writeFileSync(
    path.join(project, "scenarios", "take-voiced.narration.json"),
    JSON.stringify({
      language: "en",
      wordsPerMinute: 150,
      gapMs: 400,
      segments: [{ step: "s.a", text, durationMs: 3500, audio: "narration/take-voiced/a.wav", audioTextHash: textHash(text) }],
    }),
  );
  const dir = takeWithScene("voiced");
  const video = await render(dir, { draft: true });
  // The 3.5 s voice holds the 2 s scene's last frame: still blue after 3 s.
  const [r, , b] = centre(video, 3.6);
  assert.ok(b > 180 && r < 80, `3.6 s ${r},${b}`);
  assert.ok(lengthOf(video) > 9.4, `length ${lengthOf(video)}`);
  const report = JSON.parse(readFileSync(path.join(dir, "..", "render-report.json"), "utf-8")) as Array<{ step: string; videoStartMs: number }>;
  assert.ok((report.find((row) => row.step === "3. After")?.videoStartMs ?? 0) >= 4500);
});

test("the check sheet shows a render-time scene's last frame for its beat", async () => {
  await makeScene("checked", "blue", 2000);
  const { check } = (await import("../scripts/video/render.ts")) as unknown as { check: (dir: string) => Promise<string> };
  const dir = takeWithScene("checked");
  await check(dir);
  const tile = path.join(dir, "..", "check", "03-s-a.png");
  const px = execFileSync("ffmpeg", [
    "-v", "error", "-i", tile, "-frames:v", "1",
    "-vf", "crop=2:2:iw/2:ih/2", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ]);
  assert.ok(px[2]! > 180 && px[0]! < 80, `tile ${px[0]},${px[1]},${px[2]}`);
});

/** Colour (r, g, b) of the video's frame at `seconds`, at (x, y) of the 1920x1080 picture. */
function pixel(video: string, seconds: number, x: number, y: number): [number, number, number] {
  const px = execFileSync("ffmpeg", [
    "-v", "error", "-ss", String(seconds), "-i", video, "-frames:v", "1",
    "-vf", `crop=2:2:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ]);
  return [px[0]!, px[1]!, px[2]!];
}

test("a download shows the browser's download bubble at the top right for a while", async () => {
  const dir = makeCapture("download", Array(8).fill("red"), [{ id: "a", seconds: 0, startMs: 0, title: "Export" }], {
    compressWaits: false,
  });
  const file = path.join(dir, "events.json");
  const events = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...events, downloads: [{ t: 1000, name: "orders.csv", size: 2048 }] }));
  const video = await render(dir, { draft: true });
  // Top right of the page area, inside where the bubble sits (a draft is half size).
  const at = (s: number) => pixel(video, s, 1640 / 2, 120 / 2);
  const [r0, g0] = at(0.5);
  const [r1, g1, b1] = at(2.0);
  const [r2, g2] = at(6.0);
  assert.ok(r0 > 180 && g0 < 80, `before ${r0},${g0}`);
  assert.ok(r1 > 230 && g1 > 230 && b1 > 230, `bubble ${r1},${g1},${b1}`);
  assert.ok(r2 > 180 && g2 < 80, `after ${r2},${g2}`);
});

test("a permission request holds the frame and draws Chrome's prompt at the top left", async () => {
  const dir = makeCapture("permission", Array(6).fill("red"), [{ id: "a", seconds: 0, startMs: 0, title: "Nearby" }], {
    compressWaits: false,
  });
  const file = path.join(dir, "events.json");
  const events = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  writeFileSync(
    file,
    JSON.stringify({
      ...events,
      spans: [{ from: 1000, to: 1000, kind: "dialog", outMs: 1500 }],
      dialogs: [{ t: 1000, type: "permission", message: "geolocation", accepted: true, origin: "localhost:4387" }],
    }),
  );
  const video = await render(dir, { draft: true });
  assert.ok(Math.abs(lengthOf(video) - 7.5) < 0.2, `length ${lengthOf(video)}`);
  // Top left of the page area, inside the prompt (a draft is half size).
  const at = (s: number) => pixel(video, s, 600 / 2, 70 / 2);
  const [r0, g0] = at(0.5);
  const [r1, g1, b1] = at(1.75);
  // The right half of the page stays the page: no dimming, unlike a dialog.
  const [r2, g2] = pixel(video, 1.75, 1500 / 2, 700 / 2);
  assert.ok(r0 > 180 && g0 < 80, `before ${r0},${g0}`);
  assert.ok(r1 > 230 && g1 > 230 && b1 > 230, `prompt ${r1},${g1},${b1}`);
  assert.ok(r2 > 200 && g2 < 60, `page ${r2},${g2}`);
});
