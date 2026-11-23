// explore --mobile: does the page fit a narrow screen (vertical videos)?
import type { Page } from "@playwright/test";
import { settle } from "./settle.ts";
import type { MobileCheck } from "./types.ts";

const MOBILE = { width: 540, height: 960 };

/**
 * Reloads the page at 540×960, notes whether it is wider than that and takes
 * a screenshot, then gives the page its previous size back (the next page
 * explore opens loads at that size).
 */
export async function checkMobile(page: Page): Promise<{ check: MobileCheck; screenshot: Buffer }> {
  const viewportMeta = await page.evaluate(
    () => document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? null,
  );
  const previous = page.viewportSize();
  await page.setViewportSize(MOBILE);
  await page.reload();
  await settle(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  const screenshot = await page.screenshot();
  if (previous) await page.setViewportSize(previous);
  return { check: { viewportMeta, overflow }, screenshot };
}
