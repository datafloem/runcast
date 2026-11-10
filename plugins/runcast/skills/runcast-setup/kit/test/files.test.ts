// File uploads: rec.chooseFiles answers the file chooser, rec.dropFiles
// drops real files on a drop zone. Both before rec.start() (fast, as in test
// mode) and at a person's pace (rehearsal, through the stage tab).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";

process.env.REC_MODE = "rehearsal";
process.env.REC_AIM_MS = "20";
const { Recorder } = await import("../core/recorder.ts");

let browser: Browser;
let dir: string;
let files: Array<string>;
before(async () => {
  browser = await chromium.launch({
    channel: process.env.REC_CHANNEL === "chromium" ? undefined : "chrome",
  });
  dir = mkdtempSync(path.join(tmpdir(), "runcast-files-"));
  files = [
    path.join(dir, "orders.csv"),
    path.join(dir, "logo.png"),
  ];
  writeFileSync(files[0]!, "id,customer\n1,Ada\n");
  writeFileSync(files[1]!, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});
after(async () => {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
});

const UPLOAD = `
  <button id="pick" onclick="document.querySelector('#file').click()">Upload</button>
  <input id="file" type="file" multiple hidden>
  <div id="zone" style="margin:40px;width:400px;height:200px;border:2px dashed #888">Drop files here</div>
  <script>
    window.events = [];
    window.got = [];
    const zone = document.querySelector("#zone");
    let ready = false;
    // Like most upload widgets: a drop only counts after dragover allowed it.
    for (const type of ["dragenter", "dragover", "drop"]) {
      zone.addEventListener(type, (event) => {
        if (window.events.at(-1) !== type) window.events.push(type);
        if (type === "dragover") { event.preventDefault(); ready = true; }
        if (type === "drop") {
          event.preventDefault();
          if (ready) window.got = [...event.dataTransfer.files].map((f) => f.name + ":" + f.size + ":" + f.type);
        }
      });
    }
  </script>`;

async function freshPage(): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await context.newPage();
  await page.setContent(UPLOAD);
  return page;
}

const inputFiles = (page: Page) =>
  page.locator("#file").evaluate((input: HTMLInputElement) => [...(input.files ?? [])].map((f) => f.name));

test("chooseFiles answers the file chooser", async () => {
  // Before start: fast, as in test mode.
  const fast = await freshPage();
  const prep = new Recorder(fast, { file: path.join(dir, "scenarios", "demo.spec.ts") } as never);
  await prep.chooseFiles(fast.locator("#pick"), files);
  assert.deepEqual(await inputFiles(fast), ["orders.csv", "logo.png"]);
  await fast.context().close();

  // On camera: the file manager on the stage, then the chooser is answered.
  const paced = await freshPage();
  const rec = new Recorder(paced, { file: path.join(dir, "scenarios", "demo.spec.ts") } as never);
  await rec.start();
  await rec.chooseFiles(paced.locator("#pick"), files);
  assert.deepEqual(await inputFiles(paced), ["orders.csv", "logo.png"]);
  await paced.context().close();
});

test("dropFiles fires dragenter, dragover and drop in order with the files", async () => {
  const page = await freshPage();
  const rec = new Recorder(page, { file: path.join(dir, "scenarios", "demo.spec.ts") } as never);
  await rec.dropFiles(page.locator("#zone"), files);
  assert.deepEqual(await page.evaluate(() => (window as unknown as { events: string[] }).events), [
    "dragenter",
    "dragover",
    "drop",
  ]);
  assert.deepEqual(await page.evaluate(() => (window as unknown as { got: string[] }).got), [
    "orders.csv:18:text/csv",
    "logo.png:4:image/png",
  ]);
  await page.context().close();
});

test("drop zone that needs dragover preventDefault receives the files", async () => {
  // On camera: the cursor carries the files from the stage's file manager.
  const page = await freshPage();
  const rec = new Recorder(page, { file: path.join(dir, "scenarios", "demo.spec.ts") } as never);
  await rec.start();
  await rec.dropFiles(page.locator("#zone"), files);
  const events = await page.evaluate(() => (window as unknown as { events: string[] }).events);
  assert.deepEqual(events, ["dragenter", "dragover", "drop"]);
  assert.deepEqual(await page.evaluate(() => (window as unknown as { got: string[] }).got), [
    "orders.csv:18:text/csv",
    "logo.png:4:image/png",
  ]);
  await page.context().close();
});

test("a second upload shows its own files on the stage", async () => {
  const page = await freshPage();
  const rec = new Recorder(page, { file: path.join(dir, "scenarios", "demo.spec.ts") } as never);
  await rec.start();
  await rec.dropFiles(page.locator("#zone"), [files[0]!]);
  await rec.chooseFiles(page.locator("#pick"), files);
  assert.deepEqual(await inputFiles(page), ["orders.csv", "logo.png"]);
  await page.context().close();
});
