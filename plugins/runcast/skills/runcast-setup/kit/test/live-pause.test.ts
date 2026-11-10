// Recording fast (video mode): a viewer pause is recorded short and its last
// frame held — unless the page is still changing, which must stay live.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";

process.env.REC_MODE = "video";
delete process.env.REC_RECORD_PACE;
const { Recorder } = await import("../core/recorder.ts");
const { CaptureLog } = await import("../core/capture-log.ts");
const { VirtualMouse } = await import("../core/virtual-mouse.ts");

let browser: Browser;
before(async () => {
  browser = await chromium.launch({
    channel: process.env.REC_CHANNEL === "chromium" ? undefined : "chrome",
  });
});
after(async () => {
  await browser.close();
});

/** A Recorder on camera in video mode, logging to a plain CaptureLog (no recording runs). */
async function onCamera(html: string): Promise<{
  page: Page;
  rec: InstanceType<typeof Recorder>;
  log: InstanceType<typeof CaptureLog>;
  warnings: Array<string>;
  restore: () => void;
}> {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(html);
  const rec = new Recorder(page, { file: "/demo/scenarios/demo.spec.ts" } as never);
  const log = new CaptureLog("demo");
  const inner = rec as unknown as { live: boolean; capture: unknown; mouse: unknown };
  inner.live = true;
  inner.capture = log;
  inner.mouse = new VirtualMouse(page, log as never, { x: 10, y: 10 }, true);
  await rec.step("Orders board", undefined, { id: "orders" });
  const warnings: Array<string> = [];
  const warn = console.warn;
  console.warn = (message: string) => warnings.push(String(message));
  return { page, rec, log, warnings, restore: () => (console.warn = warn) };
}

const timed = async (fn: () => Promise<void>) => {
  const started = Date.now();
  await fn();
  return Date.now() - started;
};

test("a pause over a still page is recorded short", async () => {
  const { page, rec, log, warnings, restore } = await onCamera(`<h1>Orders</h1>`);
  try {
    const ms = await timed(() => rec.pause(1500));
    assert.ok(ms < 1000, `took ${ms} ms`);
    const hold = log.data.spans.find((s) => s.kind === "hold")!;
    assert.equal(hold.outMs, 1500);
    assert.deepEqual(warnings, []);
  } finally {
    restore();
    await page.close();
  }
});

test("a pause over a running animation is recorded live, with a warning", async () => {
  const { page, rec, log, warnings, restore } = await onCamera(
    `<style>div{width:50px;height:50px;background:#36c;animation:m 3s linear}
     @keyframes m{to{transform:translateX(500px)}}</style><div></div>`,
  );
  try {
    const ms = await timed(() => rec.pause(1500));
    assert.ok(ms >= 1450, `took ${ms} ms`);
    const hold = log.data.spans.find((s) => s.kind === "hold")!;
    assert.ok(hold.to - hold.from >= 1450, `recorded ${hold.to - hold.from} ms`);
    assert.match(warnings.join("\n"), /Orders board.*still changing/s);
  } finally {
    restore();
    await page.close();
  }
});

test("a canvas redrawn every frame counts as changing", async () => {
  const { page, rec, warnings, restore } = await onCamera(
    `<canvas id="c" width="300" height="150"></canvas><script>
       const ctx = document.getElementById("c").getContext("2d"); let x = 0;
       const draw = () => { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 300, 150);
         ctx.fillStyle = "#c33"; ctx.fillRect(x++ % 300, 50, 20, 20); requestAnimationFrame(draw); };
       draw();
     </script>`,
  );
  try {
    const ms = await timed(() => rec.pause(1200));
    assert.ok(ms >= 1150, `took ${ms} ms`);
    assert.match(warnings.join("\n"), /still changing/);
  } finally {
    restore();
    await page.close();
  }
});

test("rec.watch always records in real time", async () => {
  const { page, rec, log, restore } = await onCamera(`<h1>Orders</h1>`);
  try {
    const ms = await timed(() => rec.watch(900));
    assert.ok(ms >= 880, `took ${ms} ms`);
    const hold = log.data.spans.find((s) => s.kind === "hold")!;
    assert.equal(hold.outMs, hold.to - hold.from);
    const live = await timed(() => rec.pause(700, { live: true }));
    assert.ok(live >= 680, `pause live took ${live} ms`);
  } finally {
    restore();
    await page.close();
  }
});
