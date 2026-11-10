// End to end: a recorded tab whose page beeps and turns red on one click,
// rendered with the app's sound. The beep must land on the red frame.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "@playwright/test";
import {
  captureChannel,
  sizeWindow,
  TabCapture,
  TAB_CAPTURE_ARGS,
  TAB_CAPTURE_IGNORED_ARGS,
} from "../core/tab-capture.ts";

const channel = captureChannel();

let project: string;
let browser: Browser;
before(async () => {
  project = mkdtempSync(path.join(tmpdir(), "runcast-sync-"));
  writeFileSync(
    path.join(project, "recording.config.ts"),
    `export default { dir: import.meta.dirname, name: "Sync", baseURL: "http://localhost" };\n`,
  );
  process.env.REC_PROJECT = project;
  browser = await chromium.launch({
    channel,
    headless: true,
    args: [...TAB_CAPTURE_ARGS, "--force-device-scale-factor=1"],
    ignoreDefaultArgs: [...TAB_CAPTURE_IGNORED_ARGS],
  });
});
after(async () => {
  await browser.close();
  rmSync(project, { recursive: true, force: true });
});

/** ms of the output frames whose centre turns red, green and blue (first of each). */
function colourFramesMs(video: string): Array<number> {
  const probe = execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v", "-show_entries", "frame=pts_time", "-of", "csv=p=0", video],
    { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
  );
  const times = probe.split("\n").map((l) => Number(l.trim().replace(/,$/, ""))).filter((t) => !Number.isNaN(t));
  const pixels = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", video, "-vf", "crop=2:2:iw/2:ih/2", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const is = [
    (k: number) => pixels[k * 12]! > 200 && pixels[k * 12 + 1]! < 80 && pixels[k * 12 + 2]! < 80,
    (k: number) => pixels[k * 12 + 1]! > 200 && pixels[k * 12]! < 80 && pixels[k * 12 + 2]! < 80,
    (k: number) => pixels[k * 12 + 2]! > 200 && pixels[k * 12]! < 80 && pixels[k * 12 + 1]! < 80,
  ];
  return is.map((match, c) => {
    const i = times.findIndex((_, k) => match(k));
    assert.ok(i >= 0, `no frame of colour ${c + 1}`);
    return times[i]! * 1000;
  });
}

/** ms where each burst of the output's sound starts. */
function soundStartsMs(video: string): Array<number> {
  const pcm = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", video, "-map", "0:a", "-ac", "1", "-ar", "48000", "-f", "s16le", "pipe:1"],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const starts: Array<number> = [];
  let quietSince = 0;
  for (let i = 0; i < pcm.length / 2; i++) {
    const loud = Math.abs(pcm.readInt16LE(i * 2)) > 3000;
    if (loud && (starts.length === 0 || i - quietSince > 48 * 150)) starts.push(i / 48);
    if (loud) quietSince = i;
  }
  return starts;
}

// The best of three clicks is judged: a wrong offset moves all three, a busy
// machine only some.
test("the app's sound lands on its frame in the render", async () => {
  const page = await (await browser.newContext({ viewport: null })).newPage();
  await sizeWindow(page, { width: 960, height: 540 });
  // A small square keeps moving in a corner so the tab sends frames all along.
  await page.setContent(`<style>html,body{margin:0;height:100%;background:#fff}
    i{position:fixed;left:0;top:0;width:20px;height:20px;background:#333;animation:m 1s linear infinite}
    @keyframes m{to{transform:translateX(100px)}}</style><i></i><script>
    window.ctx = new AudioContext();
    const colours = ["#f00", "#0f0", "#00f"]; let n = 0;
    addEventListener("mousedown", () => {
      document.body.style.background = colours[n++ % 3];
      const tone = ctx.createOscillator(); const gain = ctx.createGain();
      gain.gain.value = 0.5; tone.connect(gain).connect(ctx.destination);
      tone.start(); tone.stop(ctx.currentTime + 0.25);
    });</script>`);
  const root = path.join(project, ".captures", "sync");
  const capture = new TabCapture(page, path.join(root, "capture"), "sync", {
    scale: 1,
    audio: true,
    stage: false,
  });
  await capture.start();
  await page.mouse.move(480, 270);
  for (let i = 0; i < 3; i++) {
    await new Promise((done) => setTimeout(done, 800));
    await page.mouse.down();
    await new Promise((done) => setTimeout(done, 100));
    await page.mouse.up();
  }
  await new Promise((done) => setTimeout(done, 800));
  await capture.stop();
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, "steps.json"),
    JSON.stringify({ scenario: "sync", steps: [], appAudio: { volume: 1, duckTo: 0.3 } }),
  );

  const { render } = await import("../scripts/video/render.ts");
  const video = await render(path.join(root, "capture"), { draft: true });
  const pictures = colourFramesMs(video);
  const sounds = soundStartsMs(video);
  assert.equal(sounds.length, 3, `sound bursts at ${sounds.map((s) => s.toFixed(0))}`);
  const offsets = sounds.map((sound, i) => sound - pictures[i]!);
  console.log(`sound minus frame: ${offsets.map((o) => o.toFixed(0)).join(", ")} ms`);
  assert.ok(Math.min(...offsets.map(Math.abs)) <= 50, `offsets ${offsets.map((o) => o.toFixed(0))}`);
  assert.ok(offsets.every((o) => Math.abs(o) <= 200), `offsets ${offsets.map((o) => o.toFixed(0))}`);
});

test("a bare render is the page alone, without the frame", async () => {
  const { render } = await import("../scripts/video/render.ts");
  const video = await render(path.join(project, ".captures", "sync", "capture"), { draft: true, bare: true });
  // The top-left corner shows the page (white before the click), not the dark background.
  const corner = execFileSync(
    "ffmpeg",
    ["-v", "error", "-ss", "0.3", "-i", video, "-frames:v", "1", "-vf", "crop=2:2:2:2", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
  );
  assert.ok(corner[0]! > 220 && corner[1]! > 220 && corner[2]! > 220, `corner ${corner[0]},${corner[1]},${corner[2]}`);
});
