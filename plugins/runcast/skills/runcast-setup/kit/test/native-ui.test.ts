// The kit's stand-ins for browser-drawn controls (a select's list, a date
// picker), in a real browser: drawn in the page, clickable, gone afterwards.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";
import { removeStandIn, showMonth, showOptions } from "../core/native-ui.ts";
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

const FORM = `
  <label>Country <select id="country" name="country">
    <option value="">Choose...</option>
    <option value="fr">France</option>
    <option value="de">Germany</option>
    <option value="it">Italy</option>
  </select></label>
  <input id="due" type="date" value="2026-03-02">
  <input id="note" name="note">
  <script>
    window.changes = 0;
    document.querySelector("#country").addEventListener("change", () => window.changes++);
  </script>`;

const option = (label: string) => page.locator(`[data-runcast-ui] [data-label="${label}"]`);

test("on-screen check accepts a stand-in option", async () => {
  await page.setContent(FORM);
  await page.locator("#country").evaluate(showOptions);
  const box = (await option("Germany").boundingBox())!;
  const problem = await option("Germany").evaluate(screenProblem, {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  });
  assert.equal(problem, null);
  await page.evaluate(removeStandIn);
});

test("select stand-in lists the options and sets the value", async () => {
  await page.setContent(FORM);
  await page.locator("#country").evaluate(showOptions);
  const labels = await page.locator("[data-runcast-ui] [data-label]").allTextContents();
  assert.deepEqual(labels, ["Choose...", "France", "Germany", "Italy"]);
  // The stand-in sits under the select.
  const select = (await page.locator("#country").boundingBox())!;
  const first = (await option("Choose...").boundingBox())!;
  assert.ok(first.y >= select.y + select.height - 1, `list at ${first.y}, select ends ${select.y + select.height}`);
  await option("Germany").click();
  await page.locator("#country").selectOption({ label: "Germany" });
  await page.evaluate(removeStandIn);
  assert.equal(await page.locator("#country").inputValue(), "de");
  assert.equal(await page.evaluate(() => (window as unknown as { changes: number }).changes), 1);
  assert.equal(await page.locator("[data-runcast-ui]").count(), 0);
});

test("stand-in does not take focus", async () => {
  await page.setContent(FORM);
  await page.locator("#note").focus();
  await page.locator("#country").evaluate(showOptions);
  await option("Italy").click();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "note");
  await page.evaluate(removeStandIn);
});

test("date stand-in sets the value", async () => {
  await page.setContent(FORM);
  await page.locator("#due").evaluate(showMonth, "2026-03-14");
  const title = await page.locator("[data-runcast-ui] [data-month]").textContent();
  assert.match(title ?? "", /2026/);
  assert.equal(await page.locator("[data-runcast-ui] [data-day]").count(), 31);
  await page.locator('[data-runcast-ui] [data-day="14"]').click();
  await page.locator("#due").fill("2026-03-14");
  await page.evaluate(removeStandIn);
  assert.equal(await page.locator("#due").inputValue(), "2026-03-14");
  assert.equal(await page.locator("[data-runcast-ui]").count(), 0);
});

test("rec.select and rec.pickDate go through the stand-in at a person's pace", async () => {
  process.env.REC_MODE = "rehearsal";
  process.env.REC_AIM_MS = "50";
  const { Recorder } = await import("../core/recorder.ts");
  await page.setContent(
    FORM.replace("<option value=\"it\">Italy</option>", `<option value="it">Italy</option><option value="q">Say "hi"</option>`) +
      `<script>window.shown = []; new MutationObserver(() => {
         for (const host of document.querySelectorAll("[data-runcast-ui]")) window.shown.push(host.getAttribute("data-runcast-ui"));
       }).observe(document.documentElement, { childList: true });</script>`,
  );
  const rec = new Recorder(page, { file: "/demo/scenarios/demo.spec.ts" } as never);
  await rec.start();
  await rec.select(page.locator("#country"), 'Say "hi"');
  await rec.pickDate(page.locator("#due"), "2026-03-14");
  assert.equal(await page.locator("#country").inputValue(), "q");
  assert.equal(await page.locator("#due").inputValue(), "2026-03-14");
  assert.equal(await page.evaluate(() => (window as unknown as { changes: number }).changes), 1);
  assert.deepEqual(
    [...new Set(await page.evaluate(() => (window as unknown as { shown: string[] }).shown))],
    ["select", "date"],
  );
  assert.equal(await page.locator("[data-runcast-ui]").count(), 0);
});

test("confirm answered per scenario", async () => {
  process.env.REC_MODE = "rehearsal";
  const { Recorder } = await import("../core/recorder.ts");
  const fresh = await browser.newPage();
  await fresh.setContent(`<button id="ask" onclick="window.answers.push(confirm('Delete this order?'))">Delete</button>
    <button id="name" onclick="window.answers.push(prompt('Name?', 'Ada'))">Name</button>
    <script>window.answers = [];</script>`);
  const rec = new Recorder(fresh, { file: "/demo/scenarios/demo.spec.ts" } as never);
  rec.dialogs = "dismiss";
  rec.watchDialogs();
  await fresh.locator("#ask").click();
  rec.onDialog({ accept: true });
  await fresh.locator("#ask").click();
  await fresh.locator("#ask").click();
  rec.onDialog({ accept: true, text: "Grace" });
  await fresh.locator("#name").click();
  assert.deepEqual(await fresh.evaluate(() => (window as unknown as { answers: unknown[] }).answers), [
    false,
    true,
    false,
    "Grace",
  ]);
  await fresh.close();
});

test("a project's own dialog listener answers, and the video draws its answer", async () => {
  process.env.REC_MODE = "rehearsal";
  const { Recorder } = await import("../core/recorder.ts");
  const { CaptureLog } = await import("../core/capture-log.ts");
  const fresh = await browser.newPage();
  await fresh.setContent(`<button id="ask" onclick="window.answers.push(confirm('Delete this order?'))">Delete</button>
    <script>window.answers = [];</script>`);
  const rec = new Recorder(fresh, { file: "/demo/scenarios/demo.spec.ts" } as never);
  rec.dialogs = "accept";
  rec.watchDialogs();
  await rec.start();
  const log = new CaptureLog("demo");
  (rec as unknown as { capture: unknown }).capture = log;
  // The step cancels this one itself (e.g. a "cancel the delete" flow).
  const errors: Array<unknown> = [];
  fresh.once("dialog", (dialog) => dialog.dismiss().catch((error: unknown) => errors.push(error)));
  await fresh.locator("#ask").click();
  assert.deepEqual(errors, []);
  assert.deepEqual(await fresh.evaluate(() => (window as unknown as { answers: unknown[] }).answers), [false]);
  assert.equal(log.data.dialogs?.[0]?.accepted, false);
  await fresh.close();
});

test("rec.onDialog only answers a dialog of the next action", async () => {
  process.env.REC_MODE = "rehearsal";
  const { Recorder } = await import("../core/recorder.ts");
  const fresh = await browser.newPage();
  await fresh.setContent(`<button id="calm">Nothing</button>
    <button id="ask" onclick="window.answers.push(confirm('Delete this order?'))">Delete</button>
    <script>window.answers = [];</script>`);
  const rec = new Recorder(fresh, { file: "/demo/scenarios/demo.spec.ts" } as never);
  rec.watchDialogs();
  rec.onDialog({ accept: false });
  await rec.click(fresh.locator("#calm")); // opens no dialog: the answer lapses
  await rec.click(fresh.locator("#ask"));
  assert.deepEqual(await fresh.evaluate(() => (window as unknown as { answers: unknown[] }).answers), [true]);
  await fresh.close();
});

test("rec.pickDate handles date-and-time inputs and names inputs it cannot set", async () => {
  process.env.REC_MODE = "rehearsal";
  const { Recorder } = await import("../core/recorder.ts");
  const fresh = await browser.newPage();
  await fresh.setContent(`<input id="when" type="datetime-local"><input id="at" type="time"><input id="month" type="month">`);
  const rec = new Recorder(fresh, { file: "/demo/scenarios/demo.spec.ts" } as never);
  await rec.start();
  await rec.pickDate(fresh.locator("#when"), "2026-03-14T09:30");
  assert.equal(await fresh.locator("#when").inputValue(), "2026-03-14T09:30");
  await assert.rejects(rec.pickDate(fresh.locator("#at"), "2026-03-14"), /time input/);
  await assert.rejects(rec.pickDate(fresh.locator("#month"), "2026-03-14"), /month input/);
  await fresh.close();
});
