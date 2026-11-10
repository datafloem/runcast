// The Recorder in test mode (the default): never on camera, even after start().
import assert from "node:assert/strict";
import { test } from "node:test";

delete process.env.REC_MODE;
const { Recorder } = await import("../core/recorder.ts");

test("test mode is never on camera", async () => {
  const rec = new Recorder({} as never, { file: "/demo/scenarios/demo.spec.ts" } as never);
  assert.equal(rec.onCamera, false);
  await rec.start();
  assert.equal(rec.isLive, true);
  assert.equal(rec.onCamera, false);
});

// The on-screen check before every action, against a real browser.
const { chromium } = await import("@playwright/test");

async function withPage(html: string, fn: (page: import("@playwright/test").Page) => Promise<void>) {
  const browser = await chromium.launch({
    channel: process.env.REC_CHANNEL === "chromium" ? undefined : "chrome",
  });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent(html);
    await fn(page);
  } finally {
    await browser.close();
  }
}

test("a target under a sticky footer in a scroll box is scrolled clear", async () => {
  const rows = Array.from({ length: 30 }, (_, i) => `<div class="row" id="r${i}" style="height:40px">Order ${i}</div>`).join("");
  await withPage(
    `<div id="box" style="height:300px;overflow:auto;border:1px solid #888">${rows}
       <div style="position:sticky;bottom:0;height:70px;background:#eee">Save · Cancel</div></div>
     <script>document.querySelectorAll(".row").forEach((r) => r.onclick = () => r.dataset.clicked = "1");</script>`,
    async (page) => {
      const rec = new Recorder(page, { file: "/demo/scenarios/demo.spec.ts" } as never);
      await rec.start();
      // Row 6 (240-280 px) is in view but under the bar (230-300 px).
      await rec.click(page.locator("#r6"));
      assert.equal(await page.locator("#r6").getAttribute("data-clicked"), "1");
    },
  );
});

test("a target that keeps moving fails naming the move", async () => {
  await withPage(
    `<button id="go" style="position:absolute;left:0">Go</button><script>
       let x = 0; const b = document.getElementById("go");
       const step = () => { x = (x + 3) % 600; b.style.left = x + "px"; requestAnimationFrame(step); };
       step();</script>`,
    async (page) => {
      const rec = new Recorder(page, { file: "/demo/scenarios/demo.spec.ts" } as never);
      await rec.start();
      await assert.rejects(rec.click(page.locator("#go")), /still moving: .*moved \d+(\.\d+)? px/);
    },
  );
});
