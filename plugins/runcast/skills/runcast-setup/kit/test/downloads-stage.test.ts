// rec.download({ open }) in rehearsal: the file is shown on the stage page.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "@playwright/test";

process.env.REC_MODE = "rehearsal";
const { Recorder } = await import("../core/recorder.ts");

let browser: Browser;
let project: string;
before(async () => {
  browser = await chromium.launch({ channel: process.env.REC_CHANNEL === "chromium" ? undefined : "chrome" });
  project = mkdtempSync(path.join(tmpdir(), "runcast-open-"));
});
after(async () => {
  await browser.close();
  rmSync(project, { recursive: true, force: true });
});

test("open shows the downloaded file on the stage", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.setContent(`<a id="export" download="orders.csv" href="data:text/csv,name%2Corders%0AAda%2C3%0A">Export</a>`);
  const rec = new Recorder(page, {
    file: path.join(project, "scenarios", "demo.spec.ts"),
    outputPath: (...parts: Array<string>) => path.join(project, ".results", ...parts),
  } as never);
  await rec.start();
  const started = Date.now();
  await rec.download(page.locator("#export"), { open: { ms: 600 } });
  assert.ok(Date.now() - started >= 600, "the file was not shown for its time");
  const stage = context.pages().find((p) => p !== page);
  assert.ok(stage, "no stage page");
  assert.deepEqual(await stage.locator("th").allTextContents(), ["name", "orders"]);
  await context.close();
});
