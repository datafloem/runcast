// Uploads with screen capture (no stage tab): still at a person's pace,
// through the page, without the file manager.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "@playwright/test";

process.env.REC_MODE = "video";
process.env.REC_CAPTURE = "screen";
process.env.REC_AIM_MS = "20";
const { Recorder } = await import("../core/recorder.ts");
const { VirtualMouse } = await import("../core/virtual-mouse.ts");

let browser: Browser;
let dir: string;
before(async () => {
  browser = await chromium.launch({
    channel: process.env.REC_CHANNEL === "chromium" ? undefined : "chrome",
  });
  dir = mkdtempSync(path.join(tmpdir(), "runcast-files-screen-"));
  writeFileSync(path.join(dir, "orders.csv"), "id,customer\n1,Ada\n");
});
after(async () => {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
});

test("screen capture uploads without the stage", async () => {
  const page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
  await page.setContent(`
    <button id="pick" onclick="document.querySelector('#file').click()">Upload</button>
    <input id="file" type="file" hidden>
    <div id="zone" style="margin:40px;width:400px;height:200px;border:2px dashed #888">Drop</div>
    <script>
      window.got = [];
      const zone = document.querySelector("#zone");
      zone.addEventListener("dragover", (e) => e.preventDefault());
      zone.addEventListener("drop", (e) => { e.preventDefault(); window.got = [...e.dataTransfer.files].map((f) => f.name); });
    </script>`);
  const rec = new Recorder(page, { file: path.join(dir, "scenarios", "demo.spec.ts") } as never);
  // On camera without starting ffmpeg: what a screen-capture take looks like to rec.
  const inner = rec as unknown as { live: boolean; mouse: unknown };
  inner.live = true;
  inner.mouse = new VirtualMouse(page, null, { x: 10, y: 10 }, false);

  await rec.chooseFiles(page.locator("#pick"), ["orders.csv"]);
  assert.deepEqual(
    await page.locator("#file").evaluate((input: HTMLInputElement) => [...(input.files ?? [])].map((f) => f.name)),
    ["orders.csv"],
  );
  await rec.dropFiles(page.locator("#zone"), ["orders.csv"]);
  assert.deepEqual(await page.evaluate(() => (window as unknown as { got: string[] }).got), ["orders.csv"]);
  await page.context().close();
});
