// AI-designed scenes: the contract check, and the example scene in a browser.
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";
import { sceneProblems } from "../core/scene.ts";

const EXAMPLE = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "runcast-scene",
  "example",
  "index.html",
);

let browser: Browser;
let page: Page;
before(async () => {
  browser = await chromium.launch({
    channel: process.env.REC_CHANNEL === "chromium" ? undefined : "chrome",
  });
  page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
});
after(async () => {
  await browser.close();
});

const start = () => {};

test("sceneProblems accepts the example and names each defect", async () => {
  await page.goto(`${pathToFileURL(EXAMPLE).href}?record`);
  const declared = await page.evaluateHandle(
    () => (window as unknown as { runcastScene?: unknown }).runcastScene,
  );
  assert.deepEqual(await page.evaluate(sceneProblems, declared), []);

  assert.match(sceneProblems(undefined).join(" "), /runcastScene/);
  assert.match(
    sceneProblems({ duration: 3000, beats: [{ id: "a", at: 0 }] }).join(" "),
    /start\(\)/,
  );
  assert.match(
    sceneProblems({
      duration: 3000,
      start,
      beats: [
        { id: "b", at: 1000 },
        { id: "a", at: 500 },
      ],
    }).join(" "),
    /time order/,
  );
  assert.match(
    sceneProblems({ duration: 3000, start, beats: [{ id: "late", at: 4000 }] }).join(" "),
    /after the scene's end/,
  );
  assert.match(
    sceneProblems({
      duration: 3000,
      start,
      beats: [
        { id: "a", at: 0 },
        { id: "a", at: 100 },
      ],
    }).join(" "),
    /twice/,
  );
  assert.match(sceneProblems({ duration: 0, start, beats: [] }).join(" "), /duration/);
});

test("example scene plays its beats", async () => {
  await page.goto(`${pathToFileURL(EXAMPLE).href}?record`);
  const { beats, duration } = await page.evaluate(() => {
    const scene = (window as unknown as {
      runcastScene: { duration: number; beats: Array<{ id: string; at: number }> };
    }).runcastScene;
    return { beats: scene.beats, duration: scene.duration };
  });
  const opacity = (id: string) =>
    page.locator(`[data-beat="${id}"]`).evaluate((el) => Number(getComputedStyle(el).opacity));
  // Nothing plays before start() (?record: no autoplay).
  await page.waitForTimeout(300);
  for (const beat of beats) assert.ok((await opacity(beat.id)) < 0.05, `${beat.id} shows before start`);

  await page.evaluate(() => (window as unknown as { runcastScene: { start(): void } }).runcastScene.start());
  // Seek the scene's animations instead of waiting: no wall clock in the test.
  const seek = (ms: number) =>
    page.evaluate((t) => {
      for (const animation of document.getAnimations()) {
        animation.pause();
        animation.currentTime = t;
      }
    }, ms);
  for (const [i, beat] of beats.entries()) {
    const next = beats[i + 1]?.at ?? duration;
    // Settled just before the next beat starts.
    await seek(next - 100);
    assert.ok((await opacity(beat.id)) > 0.95, `${beat.id} not shown by ${next} ms`);
    if (beats[i + 1]) {
      assert.ok((await opacity(beats[i + 1]!.id)) < 0.05, `${beats[i + 1]!.id} shows early`);
    }
  }
});
