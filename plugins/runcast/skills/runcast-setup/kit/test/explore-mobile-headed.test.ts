// explore: the narrow-screen check and following a person's browsing.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";
import { watchPages } from "../scripts/explore/headed.ts";
import { checkMobile } from "../scripts/explore/mobile.ts";
import { startSite, type Site } from "./explore/server.ts";

let browser: Browser;
let site: Site;
before(async () => {
  site = await startSite({ open: true });
  site.set("/wide", "Wide", `<div style="min-width: 1200px">Wide table</div>`);
  browser = await chromium.launch({
    channel: process.env.REC_CHANNEL === "chromium" ? undefined : "chrome",
  });
});
after(async () => {
  await browser.close();
  await site.close();
});

async function newPage(): Promise<Page> {
  return browser.newPage({ viewport: { width: 1280, height: 800 } });
}

test("mobile check reports overflow", async () => {
  const page = await newPage();
  await page.goto(`${site.url}/wide`);
  const wide = await checkMobile(page);
  assert.equal(wide.check.overflow, true);
  assert.ok(wide.screenshot.length > 0);
  assert.deepEqual(page.viewportSize(), { width: 1280, height: 800 });
  await page.goto(`${site.url}/`);
  const fits = await checkMobile(page);
  assert.equal(fits.check.overflow, false);
  assert.equal(fits.check.viewportMeta, "width=device-width, initial-scale=1");
  await page.close();
});

test("a page without a viewport tag says so", async () => {
  const page = await newPage();
  await page.goto(`${site.url}/login`);
  assert.equal((await checkMobile(page)).check.viewportMeta, null);
  await page.close();
});

test("watchPages sees navigations and history changes", async () => {
  const page = await newPage();
  const seen: Array<string> = [];
  const waitFor = async (n: number) => {
    for (let i = 0; i < 100 && seen.length < n; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(seen.length, n, `saw ${seen.join(", ")}`);
  };
  const watching = watchPages(
    page,
    async (url) => {
      seen.push(url);
    },
    new Promise(() => {}),
  );
  await page.goto(`${site.url}/`);
  await waitFor(1);
  await page.goto(`${site.url}/help`);
  await waitFor(2);
  await page.evaluate(() => history.pushState({}, "", "/#/orders"));
  await waitFor(3);
  await page.close();
  await watching;
  assert.deepEqual(seen, [`${site.url}/`, `${site.url}/help`, `${site.url}/#/orders`]);
});

test("watchPages ends when asked to stop", async () => {
  const page = await newPage();
  let stop!: () => void;
  const watching = watchPages(page, async () => {}, new Promise<void>((r) => (stop = r)));
  stop();
  await watching;
  await page.close();
});
