// Tab capture: the window sizing and the recorder tab, in a real headless Chrome.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { sizeWindow, TabCapture, TAB_CAPTURE_ARGS } from "../core/tab-capture.ts";

const channel = process.env.REC_CHANNEL === "chromium" ? undefined : "chrome";

let browser: Browser;
let context: BrowserContext;
let page: Page;
before(async () => {
  browser = await chromium.launch({
    channel,
    headless: true,
    args: [...TAB_CAPTURE_ARGS, "--force-device-scale-factor=2"],
  });
  context = await browser.newContext({ viewport: null });
  page = await context.newPage();
});
/** Temporary folders the recordings went to. */
const dirs: Array<string> = [];
after(async () => {
  await browser.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("sizeWindow gives the exact page size", async () => {
  for (const size of [
    { width: 1440, height: 810 },
    { width: 540, height: 960 },
  ]) {
    await sizeWindow(page, size);
    const inner = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    assert.deepEqual(inner, size);
  }
});

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Width and height of every video frame in the file. */
function frameSizes(file: string): Array<string> {
  return execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v", "-show_entries", "frame=width,height", "-of", "csv=p=0", file],
    { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\n")
    .map((line) => line.trim().replace(/,$/, ""))
    .filter(Boolean);
}

/** The colour (r, g, b) of the frame at `seconds`, averaged over the whole frame. */
function colourAt(file: string, seconds: number): [number, number, number] {
  const out = execFileSync(
    "ffmpeg",
    ["-v", "error", "-ss", String(seconds), "-i", file, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { maxBuffer: 1024 },
  );
  return [out[0]!, out[1]!, out[2]!];
}

async function record(html: string, ms: number): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "runcast-tab-"));
  dirs.push(dir);
  await sizeWindow(page, { width: 1440, height: 810 });
  await page.setContent(html);
  const capture = new TabCapture(page, dir, "demo", { scale: 2 });
  await capture.start();
  await wait(ms);
  return capture.stop();
}

const ANIMATED = `<title>Animated</title>
<style>body{margin:0;background:#2050d0}
div{width:200px;height:200px;background:#fff;animation:spin 1s linear infinite}
@keyframes spin{to{transform:translateX(1000px) rotate(360deg)}}</style><div></div>`;

let animatedEvents = "";

test("a 2 s recording has constant 2880x1620 frames", async () => {
  animatedEvents = await record(ANIMATED, 2000);
  const events = JSON.parse(readFileSync(animatedEvents, "utf-8")) as { video: { file: string } };
  const sizes = frameSizes(path.join(path.dirname(animatedEvents), events.video.file));
  assert.ok(sizes.length >= 20, `${sizes.length} frames`);
  assert.deepEqual([...new Set(sizes)], ["2880,1620"]);
});

test("events.json holds video file, size and startMs", () => {
  const events = JSON.parse(readFileSync(animatedEvents, "utf-8")) as {
    viewport: { width: number; height: number };
    scale: number;
    durationMs: number;
    video: { file: string; startMs: number; width: number; height: number };
  };
  assert.match(events.video.file, /^screen\.(mp4|webm)$/);
  assert.deepEqual(events.viewport, { width: 1440, height: 810 });
  assert.equal(events.scale, 2);
  assert.equal(events.video.width, 2880);
  assert.equal(events.video.height, 1620);
  assert.ok(Number.isFinite(events.video.startMs), `startMs ${events.video.startMs}`);
  assert.ok(Math.abs(events.video.startMs) < 2000, `startMs ${events.video.startMs}`);
  assert.ok(events.durationMs >= 2000);
});

test("capture picks the marked tab when the title changes right after", async () => {
  const file = await record(
    `<title>Loading</title><style>body{margin:0;background:#e01010}</style>
     <script>setTimeout(() => { document.title = "Orders - Customers app"; }, 10);</script>`,
    1500,
  );
  const events = JSON.parse(readFileSync(file, "utf-8")) as { video: { file: string } };
  const [r, g, b] = colourAt(path.join(path.dirname(file), events.video.file), 0.8);
  assert.ok(r > 180 && g < 60 && b < 60, `colour ${r},${g},${b}`);
});

/** File time (s, from the first frame) and colour of each frame's pixel at (x, y) in video pixels. */
function pixelTrack(file: string, x: number, y: number): Array<{ t: number; rgb: [number, number, number] }> {
  const probe = (entries: string) =>
    execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", ...entries.split(" "), "-of", "csv=p=0", file], {
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
    });
  const start = Number(probe("-show_entries stream=start_time").trim());
  const times = probe("-show_entries frame=pts_time")
    .split("\n")
    .map((line) => line.trim().replace(/,$/, ""))
    .filter(Boolean)
    .map((t) => Number(t) - start);
  const pixels = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-vf", `crop=2:2:${x}:${y}`, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return times.map((t, i) => ({ t, rgb: [pixels[i * 12]!, pixels[i * 12 + 1]!, pixels[i * 12 + 2]!] }));
}

// Input and painting take longer when the machine is busy, so the best of
// three clicks is judged: a wrong clock would put all of them off.
test("click lands within 50 ms of its colour change", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "runcast-tab-"));
  dirs.push(dir);
  await sizeWindow(page, { width: 1440, height: 810 });
  await page.setContent(
    `<style>html,body{margin:0;height:100%;background:#fff}</style>
     <script>const colours = ["#f00", "#0f0", "#00f"]; let n = 0;
       addEventListener("mousedown", () => { document.body.style.background = colours[n++ % 3]; });</script>`,
  );
  const capture = new TabCapture(page, dir, "demo", { scale: 2 });
  await capture.start();
  await page.mouse.move(700, 400);
  for (let i = 0; i < 3; i++) {
    await wait(600);
    capture.pointer({ x: 700, y: 400 }, "down");
    await page.mouse.down();
    await wait(100);
    await page.mouse.up();
  }
  await wait(600);
  const file = await capture.stop();
  const events = JSON.parse(readFileSync(file, "utf-8")) as {
    video: { file: string; startMs: number };
    pointer: Array<{ t: number; kind: string }>;
  };
  const track = pixelTrack(path.join(dir, events.video.file), 1440, 810);
  const isColour = [
    (c: number[]) => c[0]! > 200 && c[1]! < 60 && c[2]! < 60,
    (c: number[]) => c[1]! > 200 && c[0]! < 60 && c[2]! < 60,
    (c: number[]) => c[2]! > 200 && c[0]! < 60 && c[1]! < 60,
  ];
  const offsets = events.pointer
    .filter((p) => p.kind === "down")
    .map((down, i) => {
      const frame = track.find((f) => isColour[i]!(f.rgb));
      assert.ok(frame, `no frame for click ${i + 1}`);
      return frame.t * 1000 - (down.t - events.video.startMs);
    });
  console.log(`click offsets ${offsets.map((o) => o.toFixed(1)).join(", ")} ms`);
  assert.equal(offsets.length, 3);
  assert.ok(offsets.every((o) => o >= -50), `a colour shows before its click: ${offsets}`);
  assert.ok(Math.min(...offsets) <= 50, `offsets ${offsets}`);
});

test("window is sized before the first load", async () => {
  process.env.REC_MODE = "video";
  const { Recorder } = await import("../core/recorder.ts");
  const fresh = await browser.newContext({ viewport: null });
  const first = await fresh.newPage();
  const rec = new Recorder(first, { file: "/demo/scenarios/demo.spec.ts" } as never);
  await rec.useFormat("landscape");
  await first.goto(
    `data:text/html,<script>window.firstSize = innerWidth + "x" + innerHeight;</script>`,
  );
  assert.equal(await first.evaluate(() => (window as unknown as { firstSize: string }).firstSize), "1440x810");
  await fresh.close();
});
