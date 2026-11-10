// rec.download: the file is saved where the take (or test) keeps its files,
// returned, and logged on camera for the renderer's download bubble.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";

process.env.REC_MODE = "video";
delete process.env.REC_RECORD_PACE;
const { Recorder } = await import("../core/recorder.ts");
const { CaptureLog } = await import("../core/capture-log.ts");
const { VirtualMouse } = await import("../core/virtual-mouse.ts");

const CSV = "name,orders\nAda,3\nGrace,5\n";
const PAGE = `<button id="export">Export orders</button>
<script>
  document.getElementById("export").onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([${JSON.stringify(CSV)}], { type: "text/csv" }));
    a.download = "orders.csv";
    a.click();
  };
</script>`;

let browser: Browser;
let project: string;
before(async () => {
  browser = await chromium.launch({ channel: process.env.REC_CHANNEL === "chromium" ? undefined : "chrome" });
  project = mkdtempSync(path.join(tmpdir(), "runcast-download-"));
});
after(async () => {
  await browser.close();
  rmSync(project, { recursive: true, force: true });
});

function recorderOn(page: Page) {
  const info = {
    file: path.join(project, "scenarios", "demo.spec.ts"),
    outputPath: (...parts: Array<string>) => path.join(project, ".results", ...parts),
  };
  return new Recorder(page, info as never);
}

test("on camera a download is saved with the take, returned and logged", async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(PAGE);
  const rec = recorderOn(page);
  const log = new CaptureLog("demo");
  const inner = rec as unknown as { live: boolean; capture: unknown; mouse: unknown };
  inner.live = true;
  inner.capture = log;
  inner.mouse = new VirtualMouse(page, log as never, { x: 10, y: 10 }, true);
  const file = await rec.download(page.locator("#export"));
  assert.equal(file, path.join(project, ".captures", "demo", "downloads", "orders.csv"));
  assert.equal(readFileSync(file, "utf-8"), CSV);
  const [logged] = log.data.downloads ?? [];
  assert.equal(logged?.name, "orders.csv");
  assert.equal(logged?.size, CSV.length);
  assert.ok(Number.isFinite(logged?.t));
  await page.close();
});

test("off camera a download is saved in the test's output and not logged", async () => {
  const page = await browser.newPage();
  await page.setContent(PAGE);
  const rec = recorderOn(page);
  const file = await rec.download(page.locator("#export"));
  assert.equal(file, path.join(project, ".results", "downloads", "orders.csv"));
  assert.equal(readFileSync(file, "utf-8"), CSV);
  await page.close();
});

test("a control that downloads nothing fails naming it", async () => {
  const page = await browser.newPage();
  await page.setContent(`<button id="noop">Export</button>`);
  const rec = recorderOn(page);
  await assert.rejects(rec.download(page.locator("#noop"), { timeoutMs: 1000 }), /#noop.*no download/s);
  assert.equal(existsSync(path.join(project, ".results", "downloads", "noop")), false);
  await page.close();
});
