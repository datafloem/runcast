// explore: where a run's snapshots go. Each run in .explore/runs/<time>/;
// the merged view .explore/pages/ holds the newest snapshot of every page
// ever explored, so a one-page run does not hide the rest of the site.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { PageSnapshot } from "./types.ts";
import { slugFor } from "./urls.ts";

const KEEP_RUNS = 10;

export interface RunInfo {
  paths: Array<string>;
  crawl: number | null;
  kitVersion: string;
}

export interface Shots {
  screenshot: Buffer;
  mobile?: Buffer;
}

/** url: where the page was last seen (local only; keys with :id cannot be opened). */
type Index = Record<string, { slug: string; run: string; url?: string }>;

export const exploreDir = (dir: string) => path.join(dir, ".explore");
const indexFile = (dir: string) => path.join(exploreDir(dir), "index.json");

function readIndex(dir: string): Index {
  try {
    return JSON.parse(readFileSync(indexFile(dir), "utf-8")) as Index;
  } catch {
    return {};
  }
}

function writePage(folder: string, page: PageSnapshot, shots?: Shots): void {
  mkdirSync(folder, { recursive: true });
  const { aria, ...rest } = page;
  // Link URLs are for the crawl; record ids and queries stay out of the files.
  const stored = { ...rest, links: rest.links.map(({ url: _url, ...link }) => link) };
  // A record's page: its address may name the record (/customers/ada-lovelace).
  if (/:id|:v/.test(page.key)) {
    if (stored.finalUrl === stored.url) stored.finalUrl = "…";
    stored.url = "…";
  }
  writeFileSync(path.join(folder, "page.json"), `${JSON.stringify(stored, null, 2)}\n`);
  writeFileSync(path.join(folder, "aria.yml"), `${aria}\n`);
  if (shots) {
    writeFileSync(path.join(folder, "screenshot.png"), shots.screenshot);
    if (shots.mobile) writeFileSync(path.join(folder, "mobile.png"), shots.mobile);
  }
}

/** A page's snapshot from a page folder (page.json + aria.yml). */
export function readPage(folder: string): PageSnapshot {
  const page = JSON.parse(readFileSync(path.join(folder, "page.json"), "utf-8")) as Omit<
    PageSnapshot,
    "aria"
  >;
  const aria = readFileSync(path.join(folder, "aria.yml"), "utf-8").replace(/\n$/, "");
  return { ...page, aria };
}

/** Writes a run, updates the merged view and its summary, prunes old runs. */
export function writeRun(
  dir: string,
  info: RunInfo,
  pages: Array<PageSnapshot>,
  shots: Map<string, Shots>,
): string {
  const runs = path.join(exploreDir(dir), "runs");
  const stamp = new Date().toISOString().replace(/:/g, "-");
  let name = stamp;
  for (let n = 2; existsSync(path.join(runs, name)); n++) name = `${stamp}-${n}`;
  const runDir = path.join(runs, name);
  mkdirSync(path.join(runDir, "pages"), { recursive: true });
  writeFileSync(
    path.join(runDir, "run.json"),
    `${JSON.stringify({ ...info, at: new Date().toISOString(), pages: pages.map((p) => p.key) }, null, 2)}\n`,
  );
  for (const page of pages) writePage(path.join(runDir, "pages", slugFor(page.key)), page, shots.get(page.key));
  writeFileSync(path.join(runDir, "summary.md"), renderSummary(pages));

  const index = readIndex(dir);
  for (const page of pages) {
    const slug = slugFor(page.key);
    const merged = path.join(exploreDir(dir), "pages", slug);
    rmSync(merged, { recursive: true, force: true });
    cpSync(path.join(runDir, "pages", slug), merged, { recursive: true });
    index[page.key] = { slug, run: name, url: page.url };
  }
  writeMerged(dir, index);
  pruneRuns(runs);
  return runDir;
}

function writeMerged(dir: string, index: Index): void {
  mkdirSync(exploreDir(dir), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(index).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(indexFile(dir), `${JSON.stringify(sorted, null, 2)}\n`);
  const pages = Object.values(sorted)
    .map(({ slug }) => path.join(exploreDir(dir), "pages", slug))
    .filter((folder) => existsSync(path.join(folder, "page.json")))
    .map(readPage);
  writeFileSync(path.join(exploreDir(dir), "summary.md"), renderSummary(pages));
}

/** Where each explored page was last seen, by key. */
export function lastUrls(dir: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(readIndex(dir)).flatMap(([key, e]) => (e.url ? [[key, e.url]] : [])),
  );
}

/** Every page in the merged view. */
export function mergedPages(dir: string): Array<PageSnapshot> {
  return Object.values(readIndex(dir)).map(({ slug }) =>
    readPage(path.join(exploreDir(dir), "pages", slug)),
  );
}

function pruneRuns(runs: string): void {
  const names = readdirSync(runs).sort();
  for (const old of names.slice(0, Math.max(0, names.length - KEEP_RUNS)))
    rmSync(path.join(runs, old), { recursive: true, force: true });
}

/** Drops a page from the merged view. */
export function forgetPage(dir: string, key: string): boolean {
  const index = readIndex(dir);
  const entry = index[key];
  if (!entry) return false;
  rmSync(path.join(exploreDir(dir), "pages", entry.slug), { recursive: true, force: true });
  delete index[key];
  writeMerged(dir, index);
  return true;
}

const cell = (s: string) => s.replace(/\|/g, "\\|");

/** The overview the skills read first. */
export function renderSummary(pages: Array<PageSnapshot>): string {
  const out = [
    "# Explored pages",
    "",
    "Displayed data (table cells, data rows, repeated list items, record titles) is",
    "shown as …, and control values are left out. Screenshots are not redacted.",
    "",
  ];
  for (const p of [...pages].sort((a, b) => a.key.localeCompare(b.key))) {
    const flags = [
      p.signIn ? "sign-in page" : "",
      p.settled ? "" : "did not settle",
      p.status && p.status >= 400 ? `HTTP ${p.status}` : "",
    ].filter(Boolean);
    out.push(`## ${p.key}`, "");
    out.push(`- **Title:** ${p.title}${flags.length ? ` (${flags.join(", ")})` : ""}`);
    if (p.finalUrl !== p.url) out.push(`- **Landed on:** ${p.finalUrl}`);
    if (p.headings.length) out.push(`- **Headings:** ${p.headings.join(" · ")}`);
    const nav = p.links.filter((l) => l.landmark === "nav" || l.landmark === "header");
    if (nav.length) out.push(`- **Menu:** ${nav.map((l) => `${l.name} → ${l.key}`).join(", ")}`);
    const r = p.redacted;
    if (r.rows || r.cells || r.items)
      out.push(`- **Data hidden:** ${r.rows} rows, ${r.cells} cells, ${r.items} items`);
    if (p.hooks.length) out.push(`- **Test hooks:** ${p.hooks.join(", ")}`);
    if (p.storage.local.length || p.storage.cookies.length)
      out.push(
        `- **Storage keys:** ${[...p.storage.local, ...p.storage.session].join(", ") || "none"}; cookies: ${p.storage.cookies.join(", ") || "none"}`,
      );
    if (p.mobile)
      out.push(
        `- **Mobile:** viewport meta ${p.mobile.viewportMeta ? "yes" : "no"}, ${p.mobile.overflow ? "wider than 540 px" : "fits 540 px"}`,
      );
    if (p.controls.length) {
      out.push("", "| Role | Name | `name` | Required | Form |", "| --- | --- | --- | --- | --- |");
      for (const c of p.controls)
        out.push(
          `| ${c.role} | ${cell(c.name)} | ${c.nameAttr ?? ""} | ${c.required ? "yes" : ""} | ${cell(c.form ?? "")} |`,
        );
    }
    if (p.frames.length)
      out.push("", `- **Frames:** ${p.frames.map((f) => `${f.origin}${f.sameOrigin ? " (same origin)" : ""}`).join(", ")}`);
    if (p.skipped.length)
      out.push(`- **Not followed:** ${p.skipped.map((s) => `${s.name || s.href} (${s.reason})`).join(", ")}`);
    out.push("");
  }
  return `${out.join("\n")}\n`;
}
