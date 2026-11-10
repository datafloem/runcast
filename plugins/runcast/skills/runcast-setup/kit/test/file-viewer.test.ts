// The stage's file viewer (rec.download with { open }): each kind of file.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";
import { showFile } from "../core/file-viewer.ts";

let browser: Browser;
let page: Page;
let dir: string;
before(async () => {
  browser = await chromium.launch({ channel: process.env.REC_CHANNEL === "chromium" ? undefined : "chrome" });
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  dir = mkdtempSync(path.join(tmpdir(), "runcast-viewer-"));
});
after(async () => {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
});

const file = (name: string, content: string | Buffer) => {
  const full = path.join(dir, name);
  writeFileSync(full, content);
  return full;
};

test("a CSV shows as a table with its header", async () => {
  await showFile(page, file("orders.csv", 'name,total\nAda,"1,200"\nGrace,80\n'));
  assert.deepEqual(await page.locator("th").allTextContents(), ["name", "total"]);
  assert.deepEqual(await page.locator("tbody tr:first-child td").allTextContents(), ["Ada", "1,200"]);
  assert.match((await page.locator("[data-file-name]").textContent()) ?? "", /orders\.csv/);
});

test("JSON is pretty-printed and text is shown as it is", async () => {
  await showFile(page, file("order.json", '{"id":7,"customer":"Ada"}'));
  assert.equal(await page.locator("pre").textContent(), '{\n  "id": 7,\n  "customer": "Ada"\n}');
  await showFile(page, file("notes.txt", "Call Ada about order 7."));
  assert.equal(await page.locator("pre").textContent(), "Call Ada about order 7.");
});

test("an image is shown as the picture", async () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="red"/></svg>`;
  await showFile(page, file("logo.svg", svg));
  const size = await page.locator("img").evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]);
  assert.deepEqual(size, [40, 20]);
});

test("another kind of file shows its icon, name and size", async () => {
  await showFile(page, file("orders.xlsx", Buffer.alloc(2048)));
  assert.match((await page.locator("[data-file-card]").textContent()) ?? "", /orders\.xlsx[\s\S]*2.0 KB/);
});

test("the viewer cannot reach the network", async () => {
  const requests: Array<string> = [];
  page.on("request", (r) => requests.push(r.url()));
  await showFile(page, file("page.txt", "<img src='https://example.com/x.png'>"));
  assert.equal(requests.filter((u) => u.startsWith("http")).length, 0);
});

test("a PDF shows its page in Chrome's viewer", async () => {
  const maker = await browser.newPage();
  await maker.setContent("<h1 style='font-size:120px;color:#d00000'>Invoice 7</h1>");
  const pdf = path.join(dir, "invoice.pdf");
  await maker.pdf({ path: pdf });
  await maker.close();
  await showFile(page, pdf);
  // The viewer draws the page a moment later: look for the red title.
  let red = 0;
  for (let i = 0; i < 20 && red < 500; i++) {
    await page.waitForTimeout(250);
    const shot = await page.screenshot({ type: "png" });
    red = await page.evaluate(async (data) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const canvas = new OffscreenCanvas(img.width, img.height);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, img.width, img.height).data;
      let n = 0;
      for (let p = 0; p < px.length; p += 4) if (px[p]! > 180 && px[p + 1]! < 60 && px[p + 2]! < 60) n++;
      return n;
    }, shot.toString("base64"));
  }
  assert.ok(red >= 500, `${red} red pixels`);
});
