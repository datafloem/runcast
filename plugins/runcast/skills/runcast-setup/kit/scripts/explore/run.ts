// explore: looks at the app's pages in a headless Chrome with the project's
// settings and writes what it finds to <recording folder>/.explore/.
// Read-only: it only opens URLs, never clicks, types or submits.
//
//   node <dir>/.kit/cli.ts explore [paths...] [--crawl[=depth]] [--max n] [--skip text]...
//        [--no-session] [--headed] [--mobile] [--diff] [--accept] [--forget path]
import { chromium, type Browser, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { kitCommand, loadProject, type ProjectConfig } from "../../core/project.ts";
import {
  noSessionMessage,
  readSession,
  sessionExpired,
  restoreSessionStorage,
  storageStateFor,
  type SessionFile,
} from "../../core/session.ts";
import {
  acceptLatest,
  baselineFile,
  diffSite,
  readBaseline,
  renderDiff,
  structureOf,
  type SiteDiff,
} from "./baseline.ts";
import { exploreDir, forgetPage, lastUrls, writeRun, type Shots } from "./output.ts";
import { watchPages } from "./headed.ts";
import { checkMobile } from "./mobile.ts";
import { snapshotPage } from "./snapshot.ts";
import { trackRequests } from "./settle.ts";
import type { PageSnapshot } from "./types.ts";
import { pageKey, resolveBase, urlForKey, type Base } from "./urls.ts";

export interface ExploreOptions {
  paths: Array<string>;
  /** Crawl depth, or null for only the given pages. */
  crawl: number | null;
  max: number;
  /** Extra text that marks a link as an action (address or link text, case ignored). */
  skip?: Array<string>;
  /** Start from the saved session (default: when REC_SESSION=1). */
  session: boolean;
  headed: boolean;
  mobile: boolean;
  diff: boolean;
  accept: boolean;
  forget?: string;
}

export interface ExploreResult {
  runDir: string;
  pages: Array<PageSnapshot>;
  needsSession: Array<string>;
  unsettled: Array<string>;
  failed: Array<{ url: string; error: string }>;
  /** With --diff or --accept: the changes against the baseline. */
  diff?: SiteDiff;
}

const DEFAULT_DEPTH = 2;
const DEFAULT_MAX = 30;

/** A whole number of at least `min`, or an error naming the option. */
function wholeNumber(option: string, text: string, min: number): number {
  const n = Number(text);
  if (!/^\d+$/.test(text) || n < min)
    throw new Error(`${option} needs a whole number${min ? ` of at least ${min}` : ""} (got "${text}").`);
  return n;
}

/** Options --accept does not use: it only writes the newest run into the baseline. */
const NOT_WITH_ACCEPT = ["--crawl", "--max", "--skip", "--headed", "--mobile", "--diff", "--forget"];

export function parseExploreArgs(argv: Array<string>): ExploreOptions {
  const used: Array<string> = [];
  const options: ExploreOptions = {
    paths: [],
    crawl: null,
    max: DEFAULT_MAX,
    session: process.env.REC_SESSION === "1",
    headed: false,
    mobile: false,
    diff: false,
    accept: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value.`);
      return v;
    };
    used.push(arg.startsWith("--crawl=") ? "--crawl" : arg);
    if (arg === "--crawl") options.crawl = DEFAULT_DEPTH;
    // Depth 0 follows no links: only the given pages, as without --crawl.
    else if (arg.startsWith("--crawl=")) options.crawl = wholeNumber("--crawl", arg.slice(8), 0) || null;
    else if (arg === "--max") options.max = wholeNumber("--max", value(), 1);
    else if (arg === "--skip") options.skip = [...(options.skip ?? []), value().toLowerCase()];
    else if (arg === "--no-session") options.session = false;
    else if (arg === "--session") options.session = true;
    else if (arg === "--headed") options.headed = true;
    else if (arg === "--mobile") options.mobile = true;
    else if (arg === "--diff") options.diff = true;
    else if (arg === "--accept") options.accept = true;
    else if (arg === "--forget") options.forget = value();
    else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}.`);
    else options.paths.push(arg);
  }
  if (options.accept) {
    const extra = [...used.filter((a) => NOT_WITH_ACCEPT.includes(a)), ...options.paths];
    if (extra.length)
      throw new Error(
        `--accept takes no other options (got ${extra.join(", ")}): run explore or explore --diff, ` +
          "review what it found, then run explore --accept on its own.",
      );
  }
  return options;
}

/** A path relative to the base URL (or a full URL) as an absolute URL. */
export function urlFor(p: string, base: Base): string {
  if (/^https?:\/\//i.test(p)) {
    if (pageKey(p, base) === null)
      throw new Error(`${p} is outside the base URL (${base.origin}${base.basePath}).`);
    return p;
  }
  return `${base.origin}${base.basePath}${p.replace(/^\//, "")}`;
}

function kitVersion(): string {
  const file = path.join(import.meta.dirname, "..", "..", "package.json");
  return (JSON.parse(readFileSync(file, "utf-8")) as { version: string }).version;
}

/** Opens the browser and page explore works in, with the project's settings. */
export async function openBrowser(
  project: ProjectConfig,
  launch: { headless?: boolean } = {},
  session: SessionFile | null = null,
): Promise<{ browser: Browser; page: Page }> {
  // After the project's .env.local is loaded (loadProject), like core/playwright.ts.
  const { pageSize } = await import("../../core/mode.ts");
  const channel = process.env.REC_CHANNEL ?? "chrome";
  const browser = await chromium.launch({
    channel: channel === "chromium" ? undefined : channel,
    headless: launch.headless ?? true,
  });
  const origin = new URL(project.baseURL).origin;
  const seed = project.localStorage ?? {};
  const context = await browser.newContext({
    baseURL: project.baseURL,
    locale: project.locale ?? "en-US",
    colorScheme: project.colorScheme,
    viewport: launch.headless === false ? null : pageSize,
    storageState: session
      ? storageStateFor(session, project.baseURL, seed)
      : {
          cookies: [],
          origins: [
            { origin, localStorage: Object.entries(seed).map(([name, value]) => ({ name, value })) },
          ],
        },
  });
  if (session) await restoreSessionStorage(context, session);
  const page = await context.newPage();
  trackRequests(page);
  return { browser, page };
}

export async function explore(
  project: ProjectConfig,
  options: ExploreOptions,
  /** stop ends --headed instead of the window closing (or Enter). */
  launch: { headless?: boolean; stop?: Promise<void> } = {},
): Promise<ExploreResult> {
  const base = resolveBase(project.baseURL);
  const nothing: ExploreResult = { runDir: "", pages: [], needsSession: [], unsettled: [], failed: [] };
  const startKeysOf = (paths: Array<string>) =>
    (paths.length ? paths : ["/"]).map((p) => pageKey(urlFor(p, base), base) ?? p);
  if (options.forget) {
    const key = pageKey(urlFor(options.forget, base), base) ?? options.forget;
    if (!forgetPage(project.dir, key)) console.log(`${key} is not in the explored pages.`);
    if (!options.paths.length && !options.diff) return nothing;
  }
  // parseExploreArgs makes sure --accept comes alone.
  if (options.accept) {
    const { diff } = acceptLatest(project.dir, base, startKeysOf);
    return { ...nothing, diff };
  }
  const baseline = options.diff ? readBaseline(project.dir) : null;
  if (options.diff && !baseline)
    throw new Error("No baseline yet: run explore, then explore --accept.");

  const session = options.session ? readSession(project.dir) : null;
  if (options.session && !session) throw new Error(noSessionMessage(project.dir));
  const expired = () =>
    new Error(`The saved session has expired; run \`${kitCommand(project.dir)} session\` again.`);
  const pages: Array<PageSnapshot> = [];
  const shots = new Map<string, Shots>();
  const failed: ExploreResult["failed"] = [];
  const seen = new Set<string>();
  let stoppedBy: Error | null = null;
  // --diff without paths re-checks every baseline page: keys without
  // placeholders by their URL, the others where this computer last saw them.
  const known = lastUrls(project.dir);
  const recheck =
    !options.paths.length && baseline
      ? Object.keys(baseline.pages).flatMap((key) => {
          const url = /:id|:v/.test(key) ? known[key] : urlForKey(key, base);
          return url ? [{ url, key }] : [];
        })
      : null;
  const start = recheck ? recheck.map((r) => r.url) : options.paths;
  const queue: Array<{ url: string; depth: number; key?: string }> = recheck
    ? recheck.map((r) => ({ url: r.url, depth: 0, key: r.key }))
    : (start.length ? start : ["/"]).map((p) => ({ url: urlFor(p, base), depth: 0 }));
  const max = recheck ? Number.POSITIVE_INFINITY : options.max;
  // Addresses are checked above, before a browser starts (an error there
  // would leave it open).
  const { browser, page } = await openBrowser(project, launch, session);
  try {
    if (options.headed) {
      const url = urlFor(start[0] ?? "/", base);
      await page.goto(url, { timeout: 30_000 }).catch((error: Error) => {
        throw new Error(`Could not open ${url}: ${error.message.split("\n")[0]}`);
      });
      console.log("Browse in the Chrome window; close it when you are done (or press Enter here).");
      const byKey = new Map<string, PageSnapshot>();
      await watchPages(
        page,
        async (current) => {
          const snapshot = await snapshotPage(page, base, {
            status: null,
            requestedUrl: current,
            baseURL: project.baseURL,
            extraSkip: options.skip,
            signIn: session?.signIn,
          });
          byKey.set(snapshot.key, snapshot);
          shots.set(snapshot.key, { screenshot: await page.screenshot() });
          console.log(`  ${snapshot.key}`);
        },
        launch.stop ?? enterPressed(),
      );
      pages.push(...byKey.values());
    }
    let first = true;
    while (!options.headed && queue.length && pages.length < max) {
      const { url, depth, key: given } = queue.shift()!;
      const key = given ?? pageKey(url, base) ?? url;
      if (seen.has(key)) continue;
      seen.add(key);
      let status: number | null = null;
      try {
        // Not "load": a stuck image or tracker must not fail the page; settle caps the wait.
        status = (await page.goto(url, { timeout: 30_000, waitUntil: "domcontentloaded" }))?.status() ?? null;
      } catch (error) {
        const reason = (error as Error).message.split("\n")[0]!;
        if (first) throw new Error(`Could not open ${url}: ${reason}`);
        failed.push({ url, error: reason });
        continue;
      }
      first = false;
      const snapshot = await snapshotPage(page, base, {
        status,
        requestedUrl: url,
        baseURL: project.baseURL,
        extraSkip: options.skip,
        signIn: session?.signIn,
        key: given,
      });
      if (session && (await sessionExpired(page, session.signIn))) {
        stoppedBy = expired();
        break;
      }
      pages.push(snapshot);
      const shot: Shots = { screenshot: await page.screenshot() };
      shots.set(snapshot.key, shot);
      if (options.mobile && !snapshot.signIn) {
        const mobile = await checkMobile(page);
        snapshot.mobile = mobile.check;
        shot.mobile = mobile.screenshot;
      }
      if (snapshot.signIn || options.crawl === null || depth >= options.crawl) continue;
      for (const link of snapshot.links)
        if (!seen.has(link.key)) queue.push({ url: link.url, depth: depth + 1, key: link.key });
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const runDir = writeRun(
    project.dir,
    {
      paths: options.paths,
      crawl: options.crawl,
      kitVersion: kitVersion(),
      settings: {
        baseURL: project.baseURL,
        crawl: options.crawl,
        max: options.max,
        skip: options.skip ?? null,
        session: options.session,
        headed: options.headed,
        mobile: options.mobile,
        diff: options.diff,
        channel: process.env.REC_CHANNEL ?? "chrome",
      },
    },
    pages,
    shots,
  );
  // The pages explored before the session expired are kept.
  if (stoppedBy) throw stoppedBy;
  let diff: SiteDiff | undefined;
  if (baseline) {
    diff = diffSite(
      baseline,
      pages.map((p) => structureOf(p, base)),
      { crawl: options.crawl !== null, startKeys: startKeysOf(start) },
    );
    writeFileSync(path.join(exploreDir(project.dir), "diff.md"), renderDiff(diff));
  }
  return {
    runDir,
    diff,
    pages,
    needsSession: pages.filter((p) => p.signIn).map((p) => p.key),
    unsettled: pages.filter((p) => !p.settled).map((p) => p.key),
    failed,
  };
}

/** Resolves when Enter is pressed in a terminal; never without one. */
function enterPressed(): Promise<void> {
  if (!process.stdin.isTTY) return new Promise(() => {});
  return new Promise((resolve) => {
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}

function report(project: ProjectConfig, result: ExploreResult): void {
  const rel = (p: string) => path.relative(process.cwd(), p) || ".";
  console.log(`Explored ${result.pages.length} page(s):`);
  for (const p of result.pages) console.log(`  ${p.key}  ${p.title}`);
  if (result.needsSession.length)
    console.log(
      `Needs a session (landed on a sign-in page): ${result.needsSession.join(", ")}\n` +
        `  Save one with \`${kitCommand(project.dir)} session\` (or \`session --manual\`).`,
    );
  if (result.unsettled.length)
    console.log(`Did not settle (snapshotted anyway): ${result.unsettled.join(", ")}`);
  for (const f of result.failed) console.log(`Could not open ${f.url}: ${f.error}`);
  console.log(`Summary: ${rel(path.join(project.dir, ".explore", "summary.md"))}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    const project = await loadProject();
    const options = parseExploreArgs(process.argv.slice(2));
    const result = await explore(project, options, { headless: !options.headed });
    if (result.runDir) report(project, result);
    if (result.diff) console.log(`\n${renderDiff(result.diff)}`);
    if (options.accept && !result.runDir)
      console.log(`Baseline written: ${path.relative(process.cwd(), baselineFile(project.dir))} (commit it).`);
    // A terminal's stdin, read for Enter (--headed), would keep node running.
    process.exit(0);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
