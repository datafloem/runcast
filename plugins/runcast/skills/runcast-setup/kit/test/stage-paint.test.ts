// The stage is a background tab that Chrome repaints rarely: what `prepare`
// puts on it must be in the stage's recording before the video turns to it.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";

process.env.REC_MODE = "video";
delete process.env.REC_RECORD_PACE;
const { Recorder } = await import("../core/recorder.ts");
const { VirtualMouse } = await import("../core/virtual-mouse.ts");
const { captureChannel, sizeWindow, TabCapture, TAB_CAPTURE_ARGS, TAB_CAPTURE_IGNORED_ARGS } = await import(
  "../core/tab-capture.ts"
);
const { readFrameAt } = await import("../scripts/video/frames.ts");

let browser: Browser;
let page: Page;
let dir: string;
before(async () => {
  browser = await chromium.launch({
    channel: captureChannel(),
    headless: true,
    args: [...TAB_CAPTURE_ARGS, "--force-device-scale-factor=1.5"],
    ignoreDefaultArgs: [...TAB_CAPTURE_IGNORED_ARGS],
  });
  const context = await browser.newContext({ viewport: null });
  page = await context.newPage();
  dir = mkdtempSync(path.join(tmpdir(), "runcast-stage-paint-"));
});
after(async () => {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

test("what prepare puts on the stage is recorded by the time the video turns to it", async () => {
  await sizeWindow(page, { width: 1920, height: 1080 });
  await page.setContent(`<style>body{margin:0;background:#2050d0}</style>`);
  const capture = new TabCapture(page, dir, "demo", { scale: 1.5 });
  await capture.start();
  const rec = new Recorder(page, { file: path.join(dir, "scenarios", "demo.spec.ts") } as never);
  const inner = rec as unknown as { live: boolean; capture: unknown; mouse: unknown };
  inner.live = true;
  inner.capture = capture;
  inner.mouse = new VirtualMouse(page, capture, { x: 10, y: 10 }, true);
  // Let the stage sit still for a while, as it does between uses.
  await wait(1500);
  let shownAt = 0;
  await rec.onStage(
    async () => {
      shownAt = capture.now();
      await wait(300);
    },
    "cut",
    "cut",
    {
      cursor: false,
      // As the file viewer does: a page loads, then the kit hands it its content.
      prepare: async (stage) => {
        await stage.goto(`data:text/html,<body style="margin:0;background:rgb(235,235,235)"></body>`);
        await stage.evaluate(() => {
          document.body.style.background = "rgb(220, 40, 40)";
        });
      },
    },
  );
  await wait(300);
  const events = JSON.parse(readFileSync(await capture.stop(), "utf-8")) as {
    viewport: { width: number; height: number };
    scale: number;
    stage: { file: string; startMs: number };
  };
  const w = Math.round(events.viewport.width * events.scale);
  const h = Math.round(events.viewport.height * events.scale);
  const frame = await readFrameAt(path.join(dir, events.stage.file), shownAt - events.stage.startMs, w, h);
  assert.ok(frame, "no stage frame");
  const centre = (Math.floor(h / 2) * w + Math.floor(w / 2)) * 4;
  const [r, g, b] = [frame[centre]!, frame[centre + 1]!, frame[centre + 2]!];
  assert.ok(r > 180 && g < 90 && b < 90, `stage at the switch: ${r},${g},${b}`);
});
