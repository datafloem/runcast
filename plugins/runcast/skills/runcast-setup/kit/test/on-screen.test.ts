// The on-screen check rec runs before every action, in a real browser.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";
import { screenProblem } from "../core/on-screen.ts";

let browser: Browser;
let page: Page;
before(async () => {
  browser = await chromium.launch({
    channel: process.env.REC_CHANNEL === "chromium" ? undefined : "chrome",
  });
  page = await browser.newPage({ viewport: { width: 800, height: 600 } });
});
after(async () => {
  await browser.close();
});

/** The problem the check reports for `selector` at its centre. */
async function problemOf(html: string, selector: string): Promise<string | null> {
  await page.setContent(html);
  const box = (await page.locator(selector).boundingBox())!;
  return page
    .locator(selector)
    .evaluate(screenProblem, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
}

test("a plain button has no problem", async () => {
  assert.equal(await problemOf(`<button id="save">Save</button>`, "#save"), null);
});

test("a button covered by a toast names the toast", async () => {
  const problem = await problemOf(
    `<button id="save">Save</button>
     <div class="toast" style="position:fixed;inset:0;background:#000">Saved</div>`,
    "#save",
  );
  assert.match(problem ?? "", /covered by div\.toast/);
});

test("a button below the fold is off screen", async () => {
  const problem = await problemOf(
    `<div style="height:2000px"></div><button id="save">Save</button>`,
    "#save",
  );
  assert.match(problem ?? "", /outside the visible page/);
});

test("a fading-in dialog is not ready", async () => {
  const problem = await problemOf(
    `<style>@keyframes in { from { opacity: 0 } to { opacity: 1 } }
       .dialog { animation: in 5s }</style>
     <div class="dialog"><button id="ok">OK</button></div>`,
    "#ok",
  );
  assert.match(problem ?? "", /still animating/);
});

test("a spinning spinner nearby does not block", async () => {
  const problem = await problemOf(
    `<style>@keyframes spin { to { transform: rotate(360deg) } }
       .spinner { animation: spin 1s linear infinite; width: 10px; height: 10px }</style>
     <div class="spinner"></div><button id="ok">OK</button>`,
    "#ok",
  );
  assert.equal(problem, null);
});

test("a styled checkbox whose label covers the input is fine", async () => {
  const problem = await problemOf(
    `<style>input { position: absolute; left: 0; top: 0; opacity: 0 }
       label { position: absolute; left: 0; top: 0; width: 40px; height: 20px; z-index: 1 }</style>
     <input type="checkbox" id="agree"><label for="agree"></label>`,
    "#agree",
  );
  assert.equal(problem, null);
});
