// explore: waits until a page has stopped loading and drawing, within caps,
// so a page that polls or streams is still snapshotted.
import type { Page } from "@playwright/test";

const NETWORK_QUIET_MS = 500;
const NETWORK_CAP_MS = 10_000;
const DOM_QUIET_MS = 300;
const DOM_CAP_MS = 5_000;

interface Tracker {
  inflight: number;
  /** When a request last started or ended. */
  last: number;
}
const trackers = new WeakMap<Page, Tracker>();

/** Counts the page's requests from now on (idempotent). Call it when the page opens. */
export function trackRequests(page: Page): void {
  if (trackers.has(page)) return;
  const tracker: Tracker = { inflight: 0, last: Date.now() };
  trackers.set(page, tracker);
  const end = () => {
    tracker.inflight = Math.max(0, tracker.inflight - 1);
    tracker.last = Date.now();
  };
  page.on("request", () => {
    tracker.inflight++;
    tracker.last = Date.now();
  });
  page.on("requestfinished", end);
  page.on("requestfailed", end);
}

/** True when the network went quiet and the DOM stopped changing within their caps. */
export async function settle(page: Page): Promise<boolean> {
  trackRequests(page);
  const tracker = trackers.get(page)!;
  const start = Date.now();
  await page.waitForLoadState("load", { timeout: NETWORK_CAP_MS }).catch(() => {});
  let networkQuiet = false;
  while (Date.now() - start < NETWORK_CAP_MS) {
    if (tracker.inflight === 0 && Date.now() - tracker.last >= NETWORK_QUIET_MS) {
      networkQuiet = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const domQuiet = await page
    .evaluate(
      ({ quiet, cap }) =>
        new Promise<boolean>((resolve) => {
          let timer: ReturnType<typeof setTimeout>;
          const done = (ok: boolean) => {
            observer.disconnect();
            clearTimeout(timer);
            clearTimeout(capTimer);
            resolve(ok);
          };
          const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => done(true), quiet);
          });
          observer.observe(document, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          });
          timer = setTimeout(() => done(true), quiet);
          const capTimer = setTimeout(() => done(false), cap);
        }),
      { quiet: DOM_QUIET_MS, cap: DOM_CAP_MS },
    )
    .catch(() => false);
  return networkQuiet && domQuiet;
}
