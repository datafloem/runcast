// explore: which page a URL is (its key), where its files go (its slug) and
// which links a crawl must not follow.
import { createHash } from "node:crypto";

export interface Base {
  origin: string;
  /** Starts and ends with "/". */
  basePath: string;
}

export function resolveBase(baseURL: string): Base {
  const url = new URL(baseURL);
  const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  return { origin: url.origin, basePath: path };
}

/** A path segment that names one record: replaced by ":id" in keys. */
function idLike(segment: string): boolean {
  if (/^\d+$/.test(segment)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment))
    return true;
  if (/^[0-9a-f]{8,}$/i.test(segment) && /\d/.test(segment)) return true;
  return /^[0-9a-z]{16,}$/i.test(segment) && /\d/.test(segment);
}

function pathKey(path: string): string {
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((s) => (idLike(decodeSegment(s)) ? ":id" : decodeSegment(s)));
  return `/${segments.join("/")}`;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The page a URL shows, relative to the base path: record ids become ":id",
 * query values ":v", a hash route (#/...) is part of the key. Null outside
 * the base URL's origin and path.
 */
export function pageKey(url: string, base: Base): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url, `${base.origin}${base.basePath}`);
  } catch {
    return null;
  }
  if (parsed.origin !== base.origin) return null;
  const root = base.basePath.slice(0, -1);
  const path = parsed.pathname;
  if (path !== root && !path.startsWith(base.basePath)) return null;
  let key = pathKey(path.slice(root.length));
  const query = [...new Set(parsed.searchParams.keys())].sort();
  if (query.length) key += `?${query.map((k) => `${k}=:v`).join("&")}`;
  if (parsed.hash.startsWith("#/")) {
    const hashPath = parsed.hash.slice(1).split("?")[0]!;
    key += `#${pathKey(hashPath)}`;
  }
  return key;
}

/** The URL of a key without placeholders. */
export function urlForKey(key: string, base: Base): string {
  return `${base.origin}${base.basePath}${key.replace(/^\//, "")}`;
}

/** A folder name for a key, safe on every file system. */
export function slugFor(key: string): string {
  if (key === "/") return "_root";
  const slug = key
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}-]/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  if (slug.length <= 80) return slug || "_root";
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 8);
  return `${slug.slice(0, 80)}-${hash}`;
}

/** Links whose name or address suggests an action: never followed. */
export const DEFAULT_SKIP =
  /logout|log-out|signout|sign-out|delete|remove|destroy|unsubscribe|archive|cancel|approve|reject|send|publish|disable|deactivate|revoke|reset|void|refund|duplicate|impersonate/i;

export type SkipReason =
  | "other-origin"
  | "outside-base"
  | "download"
  | "scheme"
  | "pattern";

const DOWNLOADS =
  /\.(pdf|zip|csv|xls|xlsx|doc|docx|ppt|pptx|png|jpg|jpeg|gif|svg|webp|mp4|mp3|wav)$/i;

/** Why a crawl must not follow a link, or null when it may. */
export function skipReason(
  href: string,
  opts: {
    download: boolean;
    base: Base;
    extra?: RegExp;
    /** The link's text: "Approve" acts even when its address does not say so. */
    name?: string;
    /** The link sends a request other than GET (data-method, data-turbo-method, data-confirm). */
    method?: boolean;
  },
): SkipReason | null {
  if (/^(mailto|tel|javascript|data):/i.test(href.trim())) return "scheme";
  let url: URL;
  try {
    url = new URL(href, `${opts.base.origin}${opts.base.basePath}`);
  } catch {
    return "scheme";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "scheme";
  if (url.origin !== opts.base.origin) return "other-origin";
  if (pageKey(url.href, opts.base) === null) return "outside-base";
  if (opts.download || DOWNLOADS.test(url.pathname)) return "download";
  const target = `${url.pathname}${url.search}${url.hash}`;
  if (opts.method) return "pattern";
  for (const text of [target, opts.name ?? ""])
    if (DEFAULT_SKIP.test(text) || opts.extra?.test(text)) return "pattern";
  return null;
}
