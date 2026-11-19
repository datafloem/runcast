// explore: one page's snapshot, from the DOM and the aria tree, redacted.
import type { Page } from "@playwright/test";
import { looksLikeSignIn, type SignIn } from "../../core/session.ts";
import { extractDom } from "./dom.ts";
import { redactAria } from "./redact.ts";
import { settle } from "./settle.ts";
import type { Control, FrameInfo, Link, PageSnapshot, SkippedLink } from "./types.ts";
import { pageKey, skipReason, type Base } from "./urls.ts";

const HIDDEN = "…";

export interface SnapshotOptions {
  status: number | null;
  requestedUrl: string;
  baseURL: string;
  signIn?: SignIn | null;
  extraSkip?: RegExp;
  /** The page's key when the link that led here gave one (records addressed by name). */
  key?: string;
}

export async function snapshotPage(
  page: Page,
  base: Base,
  opts: SnapshotOptions,
): Promise<PageSnapshot> {
  const settled = await settle(page);
  const finalUrl = page.url();
  const key = opts.key ?? pageKey(opts.requestedUrl, base) ?? opts.requestedUrl;
  // A page showing one record: its title and main heading are the record's name.
  const recordPage = key.includes(":id");
  const signIn = await looksLikeSignIn(page, opts.baseURL, opts.signIn);
  const dom = await page.evaluate(extractDom);
  const aria = redactAria(await page.locator("body").ariaSnapshot(), { recordPage });

  const links: Array<Link> = [];
  const skipped: Array<SkippedLink> = [];
  for (const link of dom.links) {
    const name = link.data ? HIDDEN : link.name;
    const reason = skipReason(link.href, {
      download: link.download,
      base,
      extra: opts.extraSkip,
      name: link.name,
      method: link.method,
    });
    if (reason) {
      skipped.push({ name, href: link.data && reason === "scheme" ? HIDDEN : link.href, reason });
      continue;
    }
    // The URL is for the crawl only; page.json leaves it out (output.ts).
    links.push({ name, key: pageKey(link.href, base)!, url: link.href, landmark: link.landmark });
  }
  collapseNamedRecords(links, dom.links);

  const storage = await page
    .evaluate(() => ({
      local: Object.keys(localStorage).sort(),
      // Without the kit's own marker (core/session.ts).
      session: Object.keys(sessionStorage).filter((k) => k !== "__runcast_restored").sort(),
    }))
    .catch(() => ({ local: [], session: [] }));
  const cookies = [
    ...new Set((await page.context().cookies(finalUrl)).map((c) => c.name)),
  ].sort();

  return {
    key,
    url: opts.requestedUrl,
    finalUrl,
    title: recordPage ? HIDDEN : await page.title(),
    status: opts.status,
    settled,
    signIn,
    headings: dom.headings.map((h) => (recordPage && h.level === 1 ? HIDDEN : h.text)),
    aria: aria.text,
    controls: dom.controls,
    links,
    skipped,
    hooks: dom.hooks,
    storage: { ...storage, cookies },
    brand: dom.brand,
    frames: await framesOf(page, finalUrl),
    redacted: aria.counts,
  };
}

/**
 * Records addressed by name (/customers/ada-lovelace): two or more data links
 * that differ only in their last path segment get one key, with ":id".
 */
function collapseNamedRecords(links: Array<Link>, domLinks: Array<{ href: string; data: boolean }>): void {
  const dataUrls = new Set(domLinks.filter((l) => l.data).map((l) => l.href));
  const groups = new Map<string, Set<string>>();
  const parentOf = (key: string) => {
    const m = /^(\/[^?#]*)\/([^/?#:]+)$/.exec(key);
    return m ? { parent: m[1]!, last: m[2]! } : null;
  };
  for (const link of links) {
    if (!dataUrls.has(link.url)) continue;
    const p = parentOf(link.key);
    if (p) groups.set(p.parent, (groups.get(p.parent) ?? new Set()).add(p.last));
  }
  for (const link of links) {
    if (!dataUrls.has(link.url)) continue;
    const p = parentOf(link.key);
    if (p && (groups.get(p.parent)?.size ?? 0) >= 2) link.key = `${p.parent}/:id`;
  }
}

async function framesOf(page: Page, pageUrl: string): Promise<Array<FrameInfo>> {
  const origin = new URL(pageUrl).origin;
  const frames: Array<FrameInfo> = [];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    let frameOrigin: string;
    try {
      frameOrigin = new URL(frame.url()).origin;
    } catch {
      continue;
    }
    if (frameOrigin === "null") continue;
    const info: FrameInfo = { origin: frameOrigin, sameOrigin: frameOrigin === origin };
    if (info.sameOrigin) {
      try {
        info.aria = redactAria(await frame.locator("body").ariaSnapshot()).text;
        info.controls = (await frame.evaluate(extractDom)).controls as Array<Control>;
      } catch {
        // A frame that navigated away while being read.
      }
    }
    frames.push(info);
  }
  return frames;
}
