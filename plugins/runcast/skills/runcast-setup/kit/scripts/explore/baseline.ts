// explore: the site's structure (pages, headings, menus, controls, test
// hooks), kept in <recording folder>/explore/site.json and committed, so a
// refresh can tell what changed on any machine. No data, no values, no
// screenshots, no storage names.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { exploreDir, readPage } from "./output.ts";
import type { Control, PageSnapshot } from "./types.ts";
import { pageKey, type Base } from "./urls.ts";

const HIDDEN = "…";

export type StructureControl = Omit<Control, "placeholder">;

export interface PageStructure {
  key: string;
  /** HTTP status when it answered with an error (404, 500): the page is gone. */
  status?: number;
  /** Where the page landed when it redirected (a key, or another origin). */
  finalKey: string | null;
  title: string;
  headings: Array<string>;
  links: Array<{ name: string; key: string; landmark: string }>;
  controls: Array<StructureControl>;
  hooks: Array<string>;
  frames: Array<string>;
}

export interface Baseline {
  version: 1;
  /** Start keys of the crawl that last covered the whole site. */
  start: Array<string>;
  pages: Record<string, PageStructure>;
}

export const baselineFile = (dir: string) => path.join(dir, "explore", "site.json");

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function controlId(c: StructureControl): string {
  return c.nameAttr ?? c.id ?? `${c.role}:${c.name}`;
}

/** A control with its keys in a fixed order. */
function orderedControl(c: Control): StructureControl {
  const out: Record<string, unknown> = {};
  for (const k of ["role", "name", "label", "nameAttr", "id", "type", "required", "maxLength", "min", "max", "pattern", "options", "hooks", "form"] as const)
    if (c[k] !== undefined) out[k] = c[k];
  return out as unknown as StructureControl;
}

export function structureOf(p: PageSnapshot, base: Base): PageStructure {
  let finalKey: string | null = null;
  if (p.finalUrl !== p.url) {
    const key = pageKey(p.finalUrl, base);
    finalKey = key ?? new URL(p.finalUrl).origin;
    if (finalKey === p.key) finalKey = null;
  }
  const links = p.links
    .filter((l) => l.name !== HIDDEN && l.name !== "")
    .map((l) => ({ name: l.name, key: l.key, landmark: l.landmark }));
  const uniqueLinks = [...new Map(links.map((l) => [`${l.landmark}|${l.name}|${l.key}`, l])).values()];
  return {
    key: p.key,
    ...(p.status !== null && p.status >= 400 ? { status: p.status } : {}),
    finalKey,
    title: p.title === HIDDEN ? "" : p.title,
    headings: [...new Set(p.headings.filter((h) => h !== HIDDEN))].sort(byText),
    links: uniqueLinks.sort((a, b) =>
      byText(`${a.landmark}|${a.name}|${a.key}`, `${b.landmark}|${b.name}|${b.key}`),
    ),
    controls: p.controls
      .filter((c) => c.name !== HIDDEN)
      .map(orderedControl)
      .sort((a, b) => byText(controlId(a), controlId(b))),
    hooks: [...new Set(p.hooks)].sort(byText),
    frames: [...new Set(p.frames.map((f) => f.origin))].sort(byText),
  };
}

export function readBaseline(dir: string): Baseline | null {
  try {
    return JSON.parse(readFileSync(baselineFile(dir), "utf-8")) as Baseline;
  } catch {
    return null;
  }
}

export function writeBaseline(dir: string, b: Baseline): void {
  mkdirSync(path.dirname(baselineFile(dir)), { recursive: true });
  const pages = Object.fromEntries(
    Object.keys(b.pages)
      .sort(byText)
      .map((k) => [k, b.pages[k]!]),
  );
  const ordered: Baseline = { version: 1, start: [...b.start].sort(byText), pages };
  writeFileSync(baselineFile(dir), `${JSON.stringify(ordered, null, 2)}\n`);
}

export interface PageChange {
  key: string;
  controls: {
    added: Array<string>;
    removed: Array<string>;
    changed: Array<{ control: string; fields: Array<string> }>;
  };
  hooksRemoved: Array<string>;
  headings: { added: Array<string>; removed: Array<string> };
  navLinks: { added: Array<string>; removed: Array<string> };
}

export interface SiteDiff {
  added: Array<string>;
  removed: Array<string>;
  redirecting: Array<{ key: string; to: string }>;
  notChecked: Array<string>;
  changed: Array<PageChange>;
}

const minus = (a: Array<string>, b: Array<string>) => a.filter((x) => !b.includes(x));
const COMPARED = ["name", "label", "type", "required", "maxLength", "min", "max", "pattern", "options"] as const;

function comparePage(before: PageStructure, after: PageStructure): PageChange | null {
  const ids = (p: PageStructure) => new Map(p.controls.map((c) => [controlId(c), c]));
  const was = ids(before);
  const now = ids(after);
  const changed: PageChange["controls"]["changed"] = [];
  for (const [id, c] of now) {
    const old = was.get(id);
    if (!old) continue;
    const fields = COMPARED.filter((f) => JSON.stringify(old[f]) !== JSON.stringify(c[f]));
    if (fields.length) changed.push({ control: id, fields: [...fields] });
  }
  const nav = (p: PageStructure) =>
    [...new Set(p.links.filter((l) => l.landmark === "nav" || l.landmark === "header").map((l) => l.name))];
  const change: PageChange = {
    key: after.key,
    controls: {
      added: minus([...now.keys()], [...was.keys()]),
      removed: minus([...was.keys()], [...now.keys()]),
      changed,
    },
    hooksRemoved: minus(before.hooks, after.hooks),
    headings: { added: minus(after.headings, before.headings), removed: minus(before.headings, after.headings) },
    navLinks: { added: minus(nav(after), nav(before)), removed: minus(nav(before), nav(after)) },
  };
  const empty =
    !change.controls.added.length &&
    !change.controls.removed.length &&
    !changed.length &&
    !change.hooksRemoved.length &&
    !change.headings.added.length &&
    !change.headings.removed.length &&
    !change.navLinks.added.length &&
    !change.navLinks.removed.length;
  return empty ? null : change;
}

/**
 * What changed between the baseline and a run. A baseline page the run did
 * not reach is "removed" only when the run crawled from (at least) the
 * baseline's start pages; otherwise it is "not checked".
 */
export function diffSite(
  baseline: Baseline,
  run: Array<PageStructure>,
  opts: { crawl: boolean; startKeys: Array<string> },
): SiteDiff {
  const now = new Map(run.map((p) => [p.key, p]));
  const fullCrawl = opts.crawl && baseline.start.every((k) => opts.startKeys.includes(k));
  const diff: SiteDiff = { added: [], removed: [], redirecting: [], notChecked: [], changed: [] };
  for (const key of [...now.keys()].sort(byText)) if (!(key in baseline.pages)) diff.added.push(key);
  for (const key of Object.keys(baseline.pages).sort(byText)) {
    const before = baseline.pages[key]!;
    const after = now.get(key);
    if (!after) {
      (fullCrawl ? diff.removed : diff.notChecked).push(key);
      continue;
    }
    if (after.status && !before.status) {
      diff.removed.push(key);
      continue;
    }
    if (after.finalKey && after.finalKey !== before.finalKey)
      diff.redirecting.push({ key, to: after.finalKey });
    const change = comparePage(before, after);
    if (change) diff.changed.push(change);
  }
  return diff;
}

export function renderDiff(d: SiteDiff): string {
  const out = ["# Changes since the baseline (explore/site.json)", ""];
  const list = (title: string, items: Array<string>) => {
    if (items.length) out.push(`## ${title}`, "", ...items.map((i) => `- ${i}`), "");
  };
  list("New pages", d.added);
  list("Pages gone", d.removed);
  list("Now redirecting", d.redirecting.map((r) => `${r.key} → ${r.to}`));
  for (const c of d.changed) {
    out.push(`## ${c.key}`, "");
    if (c.controls.added.length) out.push(`- Controls added: ${c.controls.added.join(", ")}`);
    if (c.controls.removed.length) out.push(`- Controls removed: ${c.controls.removed.join(", ")}`);
    for (const ch of c.controls.changed) out.push(`- Control ${ch.control} changed: ${ch.fields.join(", ")}`);
    if (c.hooksRemoved.length) out.push(`- Test hooks removed: ${c.hooksRemoved.join(", ")}`);
    if (c.headings.added.length) out.push(`- Headings added: ${c.headings.added.join(" · ")}`);
    if (c.headings.removed.length) out.push(`- Headings removed: ${c.headings.removed.join(" · ")}`);
    if (c.navLinks.added.length) out.push(`- Menu links added: ${c.navLinks.added.join(", ")}`);
    if (c.navLinks.removed.length) out.push(`- Menu links removed: ${c.navLinks.removed.join(", ")}`);
    out.push("");
  }
  if (!d.added.length && !d.removed.length && !d.redirecting.length && !d.changed.length)
    out.push("No changes in the pages checked.", "");
  list("Not checked (not reached by this run)", d.notChecked);
  return `${out.join("\n")}\n`;
}

/** The newest run: its options and pages. */
function latestRun(dir: string): { paths: Array<string>; crawl: number | null; pages: Array<PageSnapshot> } | null {
  const runs = path.join(exploreDir(dir), "runs");
  if (!existsSync(runs)) return null;
  const name = readdirSync(runs).sort().at(-1);
  if (!name) return null;
  const runDir = path.join(runs, name);
  const info = JSON.parse(readFileSync(path.join(runDir, "run.json"), "utf-8")) as {
    paths: Array<string>;
    crawl: number | null;
  };
  const pagesDir = path.join(runDir, "pages");
  const pages = readdirSync(pagesDir).map((slug) => readPage(path.join(pagesDir, slug)));
  return { paths: info.paths, crawl: info.crawl, pages };
}

/** Writes the newest run's structure into the baseline. */
export function acceptLatest(
  dir: string,
  base: Base,
  startKeysOf: (paths: Array<string>) => Array<string>,
): { baseline: Baseline; diff: SiteDiff } {
  const run = latestRun(dir);
  if (!run) throw new Error("Nothing to accept: run explore first.");
  const structures = run.pages.map((p) => structureOf(p, base));
  const startKeys = startKeysOf(run.paths);
  const old = readBaseline(dir) ?? { version: 1 as const, start: [], pages: {} };
  const diff = diffSite(old, structures, { crawl: run.crawl !== null, startKeys });
  const pages = { ...old.pages };
  for (const s of structures) pages[s.key] = s;
  for (const key of diff.removed) delete pages[key];
  const baseline: Baseline = {
    version: 1,
    start: run.crawl !== null ? startKeys : old.start,
    pages,
  };
  writeBaseline(dir, baseline);
  return { baseline, diff };
}
