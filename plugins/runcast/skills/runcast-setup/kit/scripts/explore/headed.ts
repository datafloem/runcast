// explore --headed: a person browses in a visible window; every page they
// reach is handed to `onPage` once its URL changes. Explore never acts here
// either: it only watches.
import type { Page } from "@playwright/test";

const POLL_MS = 250;

/**
 * Calls onPage (one at a time, in order) for each new main-frame URL, from
 * navigations and from history-API changes. Ends when `stop` resolves, the
 * page closes or the browser goes away, after the last onPage has finished.
 */
export async function watchPages(
  page: Page,
  onPage: (url: string) => Promise<void>,
  stop: Promise<void>,
): Promise<void> {
  let last = "";
  let done = false;
  let busy: Promise<void> = Promise.resolve();
  const check = () => {
    if (done || page.isClosed()) return;
    const url = page.url();
    if (url === last || url === "about:blank") return;
    last = url;
    busy = busy.then(() => onPage(url)).catch(() => {});
  };
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) check();
  });
  const timer = setInterval(check, POLL_MS);
  const closed = new Promise<void>((resolve) => {
    page.once("close", () => resolve());
    page.context().browser()?.once("disconnected", () => resolve());
  });
  check();
  await Promise.race([stop, closed]);
  done = true;
  clearInterval(timer);
  await busy;
}
