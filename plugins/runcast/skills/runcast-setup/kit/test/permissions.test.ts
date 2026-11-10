// Permission prompts: decided up front (tests never wait), logged when the
// page asks so the video can draw Chrome's prompt.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";

process.env.REC_MODE = "video";
delete process.env.REC_RECORD_PACE;
const { Recorder } = await import("../core/recorder.ts");
const { CaptureLog } = await import("../core/capture-log.ts");
const { VirtualMouse } = await import("../core/virtual-mouse.ts");

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ channel: process.env.REC_CHANNEL === "chromium" ? undefined : "chrome" });
});
after(async () => {
  await browser.close();
});

/** A page of a made-up app at http://localhost:4387/ (a secure context: localhost), and a Recorder for it. */
async function app(permissions: Array<string> | Record<string, "allow" | "block">) {
  const context = await browser.newContext({ geolocation: { latitude: 52.37, longitude: 4.89 } });
  const page = await context.newPage();
  await page.route("http://localhost:4387/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>Orders</h1>" }),
  );
  const rec = new Recorder(page, { file: "/demo/scenarios/demo.spec.ts" } as never);
  await rec.usePermissions(permissions);
  await page.goto("http://localhost:4387/");
  return { context, page, rec };
}

function onCamera(rec: InstanceType<typeof Recorder>, page: Page) {
  const log = new CaptureLog("demo");
  const inner = rec as unknown as { live: boolean; capture: unknown; mouse: unknown };
  inner.live = true;
  inner.capture = log;
  inner.mouse = new VirtualMouse(page, log as never, { x: 10, y: 10 }, true);
  return log;
}

const locate = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<string>((done) =>
        navigator.geolocation.getCurrentPosition(
          (p) => done(`at ${p.coords.latitude}`),
          (e) => done(`error ${e.code}`),
        ),
      ),
  );

test("a location request is allowed and logged once as a permission prompt", async () => {
  const { context, page, rec } = await app(["geolocation"]);
  const log = onCamera(rec, page);
  assert.equal(await locate(page), "at 52.37");
  assert.equal(await locate(page), "at 52.37");
  await page.waitForTimeout(100);
  assert.deepEqual(
    (log.data.dialogs ?? []).map(({ t: _t, ...d }) => d),
    [{ type: "permission", message: "geolocation", accepted: true, origin: "localhost:4387" }],
  );
  assert.equal(log.data.spans.filter((s) => s.kind === "dialog").length, 1);
  await context.close();
});

test("a blocked permission fails the page's request as blocked and is logged as blocked", async () => {
  const { context, page, rec } = await app({ notifications: "block", geolocation: "block" });
  const log = onCamera(rec, page);
  assert.equal(await page.evaluate(() => Notification.requestPermission()), "denied");
  assert.equal(await page.evaluate(() => Notification.permission), "denied");
  assert.equal(await locate(page), "error 1");
  assert.equal(
    await page.evaluate(async () => (await navigator.permissions.query({ name: "geolocation" })).state),
    "denied",
  );
  await page.waitForTimeout(100);
  assert.deepEqual(
    (log.data.dialogs ?? []).map((d) => [d.message, d.accepted]),
    [
      ["notifications", false],
      ["geolocation", false],
    ],
  );
  await context.close();
});

test("a request off camera is not drawn, and the browser does not ask again later", async () => {
  const { context, page, rec } = await app({ geolocation: "allow" });
  assert.equal(await locate(page), "at 52.37");
  const log = onCamera(rec, page);
  assert.equal(await locate(page), "at 52.37");
  await page.waitForTimeout(100);
  assert.deepEqual(log.data.dialogs ?? [], []);
  await context.close();
});
