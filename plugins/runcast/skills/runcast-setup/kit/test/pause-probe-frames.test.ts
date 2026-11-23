// Recording fast, a pause asks whether the page still changes with two page
// screenshots. A screenshot scaled to CSS pixels at a device scale above 1
// makes Chrome re-render the tab's surface, and the tab capture records one
// blank grey frame of it (a white blink in a dark video). The probe must
// leave the recording untouched.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { chromium } from "@playwright/test";

process.env.REC_MODE = "video";
delete process.env.REC_RECORD_PACE;
const { Recorder } = await import("../core/recorder.ts");
const { VirtualMouse } = await import("../core/virtual-mouse.ts");
const { captureChannel, sizeWindow, TabCapture, TAB_CAPTURE_ARGS, TAB_CAPTURE_IGNORED_ARGS } =
  await import("../core/tab-capture.ts");

/** The device scale the blank frames showed at most (1.5 rarely shows them). */
const SCALE = 2;

const dirs: Array<string> = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Mean brightness (0-255) of every frame of the file, in order. */
function frameBrightness(file: string): Array<number> {
  const out = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-map", "0:v:0", "-vf", "scale=1:1:flags=area,format=gray", "-f", "rawvideo", "pipe:1"],
    { maxBuffer: 1024 * 1024 },
  );
  return Array.from(out);
}

test("pauses recorded fast leave no blank frame in a tab recording at device scale 2", async () => {
  const browser = await chromium.launch({
    channel: captureChannel(),
    headless: true,
    args: [...TAB_CAPTURE_ARGS, `--force-device-scale-factor=${SCALE}`],
    ignoreDefaultArgs: [...TAB_CAPTURE_IGNORED_ARGS],
  });
  try {
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    await sizeWindow(page, { width: 1280, height: 720 });
    await page.setContent(
      `<body style="margin:0;background:#202020;color:#ddd;font:20px sans-serif"><h1 style="margin:40px">Orders</h1></body>`,
    );
    const dir = mkdtempSync(path.join(tmpdir(), "runcast-probe-"));
    dirs.push(dir);
    const capture = new TabCapture(page, dir, "demo", { scale: SCALE, stage: false });
    await capture.start();
    const rec = new Recorder(page, { file: "/demo/scenarios/demo.spec.ts" } as never);
    const inner = rec as unknown as { live: boolean; capture: unknown; mouse: unknown };
    inner.live = true;
    inner.capture = capture;
    inner.mouse = new VirtualMouse(page, capture as never, { x: 10, y: 10 }, true);
    await rec.step("Orders board", undefined, { id: "orders" });
    // Each pause is longer than its recorded head, so it probes the page.
    for (let i = 0; i < 6; i++) await rec.pause(1000);
    await capture.stop();

    const luma = frameBrightness(path.join(dir, "screen.mp4"));
    assert.ok(luma.length >= 2, `${luma.length} frames`);
    const page0 = luma[0]!;
    const blank = luma.flatMap((value, i) => (Math.abs(value - page0) > 20 ? [`frame ${i}: ${value}`] : []));
    assert.deepEqual(blank, [], `the page is ${page0} bright; frames that are not`);
  } finally {
    await browser.close();
  }
});
