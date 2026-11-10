// Tab capture: the window sizing and the recorder tab, in a real headless Chrome.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  captureChannel,
  sizeWindow,
  TabCapture,
  TAB_CAPTURE_ARGS,
  TAB_CAPTURE_IGNORED_ARGS,
} from "../core/tab-capture.ts";

const channel = captureChannel();

test("REC_CHANNEL=chromium records with Playwright's full Chromium, not the headless shell", () => {
  // The headless shell has no tab capture (getDisplayMedia: NotSupportedError).
  assert.equal(captureChannel("chromium"), "chromium");
  assert.equal(captureChannel(undefined), "chrome");
  assert.equal(captureChannel("msedge"), "msedge");
});

let browser: Browser;
let context: BrowserContext;
let page: Page;
before(async () => {
  browser = await chromium.launch({
    channel,
    headless: true,
    args: [...TAB_CAPTURE_ARGS, "--force-device-scale-factor=1.5"],
    ignoreDefaultArgs: [...TAB_CAPTURE_IGNORED_ARGS],
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
    { width: 1920, height: 1080 },
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

async function record(
  html: string,
  ms: number,
  options: { audio?: boolean; onStart?: (capture: TabCapture) => void } = {},
): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "runcast-tab-"));
  dirs.push(dir);
  await sizeWindow(page, { width: 1920, height: 1080 });
  await page.setContent(html);
  const capture = new TabCapture(page, dir, "demo", { scale: 1.5, audio: options.audio });
  await capture.start();
  options.onStart?.(capture);
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
  assert.deepEqual(events.viewport, { width: 1920, height: 1080 });
  assert.equal(events.scale, 1.5);
  assert.equal(events.video.width, 2880);
  assert.equal(events.video.height, 1620);
  assert.ok(Number.isFinite(events.video.startMs), `startMs ${events.video.startMs}`);
  // Before time zero: the file starts when the app's tab is captured, time
  // zero once the stage is captured too (seconds on a busy machine).
  assert.ok(events.video.startMs <= 0 && events.video.startMs > -10_000, `startMs ${events.video.startMs}`);
  assert.ok(events.durationMs >= 2000);
});

test("capture picks the marked tab when the title changes right after", async () => {
  // An app that keeps setting its own title the whole time capture starts:
  // on a timer, every frame, and whenever anything touches the title.
  const file = await record(
    `<title>Loading</title><style>body{margin:0;background:#e01010}</style>
     <script>(() => {
       // In a function: setContent keeps the window, so top-level names would clash with later pages.
       let n = 0;
       const set = () => { const title = "Orders " + (n++ % 7) + " - Customers app"; if (document.title !== title) document.title = title; };
       const timer = setInterval(set, 1);
       let frames = true;
       const frame = () => { if (!frames) return; set(); requestAnimationFrame(frame); }; frame();
       const observer = new MutationObserver(() => { if (!document.title.startsWith("Orders")) set(); });
       observer.observe(document.head, { subtree: true, childList: true, characterData: true });
       window.stopTitles = () => { clearInterval(timer); frames = false; observer.disconnect(); };
     })();</script>`,
    1500,
  );
  const events = JSON.parse(readFileSync(file, "utf-8")) as { video: { file: string } };
  const [r, g, b] = colourAt(path.join(path.dirname(file), events.video.file), 0.8);
  assert.ok(r > 180 && g < 60 && b < 60, `colour ${r},${g},${b}`);
  await page.evaluate(() => (window as unknown as { stopTitles(): void }).stopTitles());
  // The app has its own title and the browser's document.title back.
  assert.deepEqual(
    await page.evaluate(() => [
      document.title.startsWith("Orders"),
      Object.getOwnPropertyDescriptor(document, "title") === undefined,
    ]),
    [true, true],
  );
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
  await sizeWindow(page, { width: 1920, height: 1080 });
  await page.setContent(
    `<style>html,body{margin:0;height:100%;background:#fff}</style>
     <script>const colours = ["#f00", "#0f0", "#00f"]; let n = 0;
       addEventListener("mousedown", () => { document.body.style.background = colours[n++ % 3]; });</script>`,
  );
  const capture = new TabCapture(page, dir, "demo", { scale: 1.5 });
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
  // The middle of the 2880x1620 frame.
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
  assert.equal(await first.evaluate(() => (window as unknown as { firstSize: string }).firstSize), "1920x1080");
  await fresh.close();
});

test("a beeping page gives a non-silent audio track", async () => {
  let settings: Record<string, unknown> | null = null;
  const file = await record(
    `<style>body{margin:0;background:#103020}</style><script>
       const ctx = new AudioContext(); const tone = ctx.createOscillator(); const gain = ctx.createGain();
       tone.frequency.value = 440; gain.gain.value = 0.5; tone.connect(gain).connect(ctx.destination); tone.start();
     </script>`,
    2000,
    { audio: true, onStart: (capture) => (settings = capture.started?.audioSettings ?? null) },
  );
  const events = JSON.parse(readFileSync(file, "utf-8")) as {
    video: { file: string };
    audio?: { file: string; startMs: number };
  };
  assert.ok(events.audio, "no audio in events.json");
  assert.equal(events.audio.file, events.video.file);
  const stderr = execFileSync(
    "sh",
    ["-c", `ffmpeg -hide_banner -i "$1" -map 0:a -af volumedetect -f null - 2>&1`, "sh", path.join(path.dirname(file), events.audio.file)],
    { encoding: "utf-8" },
  );
  const mean = Number(/mean_volume: (-?[\d.]+) dB/.exec(stderr)?.[1] ?? "-inf");
  assert.ok(mean > -40, `mean volume ${mean} dB`);
  assert.equal((settings as Record<string, unknown> | null)?.suppressLocalAudioPlayback, true);
});

test("stage stream records its own file with the same size", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "runcast-tab-"));
  dirs.push(dir);
  await sizeWindow(page, { width: 1920, height: 1080 });
  await page.setContent(`<style>body{margin:0;background:#2050d0}</style>`);
  const capture = new TabCapture(page, dir, "demo", { scale: 1.5 });
  await capture.start();
  assert.ok(capture.stage, "no stage tab");
  assert.deepEqual(
    await capture.stage.evaluate(() => [window.innerWidth, window.innerHeight]),
    [1920, 1080],
  );
  capture.source("stage", "lift");
  await capture.stage.setContent(ANIMATED.replace("#2050d0", "#d05020"));
  await wait(1500);
  capture.source("app", "fade");
  await wait(300);
  const file = await capture.stop();
  const events = JSON.parse(readFileSync(file, "utf-8")) as {
    video: { file: string };
    stage?: { file: string; startMs: number };
    sources?: Array<{ t: number; source: string; transition: string }>;
  };
  assert.ok(events.stage, "no stage in events.json");
  assert.match(events.stage.file, /^stage\.(mp4|webm)$/);
  assert.ok(Number.isFinite(events.stage.startMs));
  assert.deepEqual(
    events.sources?.map((s) => [s.source, s.transition]),
    [
      ["stage", "lift"],
      ["app", "fade"],
    ],
  );
  for (const name of [events.video.file, events.stage.file]) {
    const sizes = frameSizes(path.join(dir, name));
    assert.ok(sizes.length >= 1, `${name}: no frames`);
    assert.deepEqual([...new Set(sizes)], ["2880,1620"], name);
  }
  // The stage recorded its animation.
  assert.ok(frameSizes(path.join(dir, events.stage.file)).length >= 15);
});

test("a retried start leaves no first-attempt chunks in the file", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "runcast-tab-"));
  dirs.push(dir);
  await sizeWindow(page, { width: 1920, height: 1080 });
  await page.setContent(ANIMATED);
  const capture = new TabCapture(page, dir, "demo", { scale: 1.5 });
  // The stage fails once, near the start timeout: the app's tab has been
  // recording for seconds and sent chunks.
  const inner = capture as unknown as {
    captureTab: (recorder: unknown, tab: unknown, name: string, audio: boolean) => Promise<unknown>;
  };
  const original = inner.captureTab.bind(capture);
  let failed = false;
  inner.captureTab = async (recorder, tab, name, audio) => {
    if (name === "stage" && !failed) {
      failed = true;
      await wait(4000);
      throw new Error("stage did not start");
    }
    return original(recorder, tab, name, audio);
  };
  await capture.start();
  assert.ok(failed);
  await wait(1000);
  const file = await capture.stop();
  const events = JSON.parse(readFileSync(file, "utf-8")) as { video: { file: string } };
  const bytes = readFileSync(path.join(dir, events.video.file));
  // One recording in the file: one header (ftyp / EBML), not one per attempt.
  const marker = events.video.file.endsWith(".mp4") ? "ftyp" : "\x1a\x45\xdf\xa3";
  let headers = 0;
  for (let i = bytes.indexOf(marker, 0, "latin1"); i >= 0; i = bytes.indexOf(marker, i + 1, "latin1")) headers++;
  assert.equal(headers, 1);
});

test("a recording that stops mid-way fails the take", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "runcast-tab-"));
  dirs.push(dir);
  await sizeWindow(page, { width: 1920, height: 1080 });
  await page.setContent(ANIMATED);
  const capture = new TabCapture(page, dir, "demo", { scale: 1.5 });
  await capture.start();
  await wait(800);
  // The stage tab goes away: its recording ends on its own.
  await capture.stage!.close();
  await wait(500);
  await assert.rejects(capture.stop(), /stopped before the end: the stage/);
  // What was recorded stays, with its events.
  assert.ok(readFileSync(path.join(dir, "events.json"), "utf-8").includes('"video"'));
});

test("the stage cannot reach the network", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_, response) => response.writeHead(200, { "access-control-allow-origin": "*" }).end("ok"));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const dir = mkdtempSync(path.join(tmpdir(), "runcast-tab-"));
  dirs.push(dir);
  await sizeWindow(page, { width: 1920, height: 1080 });
  await page.setContent(`<style>body{margin:0;background:#2050d0}</style>`);
  const capture = new TabCapture(page, dir, "demo", { scale: 1.5 });
  await capture.start();
  const reach = (p: Page) =>
    p.evaluate((u) => fetch(u).then((r) => r.text()).catch(() => "blocked"), url);
  try {
    assert.equal(await reach(page), "ok");
    assert.equal(await reach(capture.stage!), "blocked");
  } finally {
    await capture.stop();
    server.close();
  }
});
