// explore: the committed structure baseline and what --diff reports.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { diffSite, readBaseline } from "../scripts/explore/baseline.ts";
import { explore, parseExploreArgs, type ExploreOptions } from "../scripts/explore/run.ts";
import type { ProjectConfig } from "../core/project.ts";
import { startSite, type Site } from "./explore/server.ts";

let site: Site;
let dir: string;
let project: ProjectConfig;
beforeEach(async () => {
  site = await startSite({ open: true });
  dir = mkdtempSync(path.join(tmpdir(), "runcast-baseline-"));
  project = { dir, name: "Demo", baseURL: site.url };
});
afterEach(async () => {
  await site.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = (o: Partial<ExploreOptions>) =>
  explore(project, { ...parseExploreArgs([]), session: false, ...o });
const siteJson = () => path.join(dir, "explore", "site.json");

const FORM_WITHOUT_NOTE = `<h1>New customer</h1>
<form aria-label="New customer">
  <label for="name">Name</label><input id="name" name="name" required maxlength="80">
  <label>E-mail <input name="email" type="email" required></label>
  <label>Country <select name="country"><option>France</option><option>Germany</option></select></label>
  <button>Save</button>
</form>`;

test("structure ignores data", async () => {
  await run({ paths: ["/app/customers"] });
  await run({ accept: true });
  site.set(
    "/app/customers",
    "Customers",
    readFileSync(path.join(import.meta.dirname, "explore", "site", "customers.html"), "utf-8")
      .replace("Ada Lovelace", "Katherine Johnson")
      .replace("grace@example.com", "mary@example.com"),
  );
  const result = await run({ paths: ["/app/customers"], diff: true });
  assert.equal(result.diff?.changed.length, 0);
  assert.match(readFileSync(path.join(dir, ".explore", "diff.md"), "utf-8"), /No changes/);
});

test("a removed field and a renamed label are reported", async () => {
  await run({ paths: ["/app/customers/new"] });
  await run({ accept: true });
  site.set("/app/customers/new", "New customer", FORM_WITHOUT_NOTE);
  const result = await run({ paths: [], diff: true });
  const page = result.diff?.changed.find((c) => c.key === "/app/customers/new");
  assert.deepEqual(page?.controls.removed, ["note"]);
  assert.ok(page?.controls.changed.some((c) => c.control === "email" && c.fields.includes("name")));
  const md = readFileSync(path.join(dir, ".explore", "diff.md"), "utf-8");
  assert.match(md, /note/);
  assert.match(md, /email/);
});

test("pages not reached are not checked, not removed", async () => {
  await run({ paths: ["/"], crawl: 1 });
  await run({ accept: true });
  const result = await run({ paths: ["/app/customers/new"], diff: true });
  assert.deepEqual(result.diff?.removed, []);
  assert.ok(result.diff?.notChecked.includes("/app/customers"));
});

test("a crawl from the same start reports removed pages", async () => {
  await run({ paths: ["/"], crawl: 2 });
  await run({ accept: true });
  site.set("/app/customers", "Customers", "<h1>Customers</h1><p>None yet.</p>");
  const result = await run({ paths: ["/"], crawl: 2, diff: true });
  assert.ok(result.diff?.removed.includes("/app/customers?page=:v"), JSON.stringify(result.diff));
  await run({ accept: true });
  assert.ok(!("/app/customers?page=:v" in readBaseline(dir)!.pages));
});

test("site.json is stable and holds structure only", async () => {
  await run({ paths: ["/app/customers", "/app/customers/17", "/app/customers/new"] });
  await run({ accept: true });
  const first = readFileSync(siteJson(), "utf-8");
  await run({ paths: ["/app/customers", "/app/customers/17", "/app/customers/new"] });
  await run({ accept: true });
  assert.equal(readFileSync(siteJson(), "utf-8"), first);
  for (const absent of ["…", "screenshot", "theme", "draft", "Ada", "example.com"])
    assert.ok(!first.includes(absent), `${absent} in site.json`);
  assert.ok(first.endsWith("}\n"));
});

test("diff without a baseline explains what to do", async () => {
  await assert.rejects(run({ diff: true }), /No baseline yet: run explore, then explore --accept/);
  assert.ok(!existsSync(siteJson()));
});

test("diffSite compares only what both sides have", () => {
  const page = { key: "/a", finalKey: null, title: "A", headings: [], links: [], controls: [], hooks: ["t1"], frames: [] };
  const d = diffSite(
    { version: 1, start: ["/"], pages: { "/a": page, "/b": { ...page, key: "/b" } } },
    [{ ...page, hooks: [] }, { ...page, key: "/c" }],
    { crawl: false, startKeys: ["/a"] },
  );
  assert.deepEqual(d.added, ["/c"]);
  assert.deepEqual(d.notChecked, ["/b"]);
  assert.deepEqual(d.changed[0]?.hooksRemoved, ["t1"]);
});

test("a page that now answers 404 is gone", async () => {
  await run({ paths: ["/help", "/"] });
  await run({ accept: true });
  site.gone("/help");
  const result = await run({ paths: [], diff: true });
  assert.deepEqual(result.diff?.removed, ["/help"]);
});

test("sample URLs keep no search terms", async () => {
  site.set("/search", "Search", "<h1>Search</h1>");
  await run({ paths: ["/search?q=Ada%20Lovelace", "/app/customers?page=2"] });
  await run({ accept: true });
  const json = readFileSync(siteJson(), "utf-8");
  assert.ok(!json.includes("Ada"), json);
  assert.ok(!json.includes("page=2"), "no sample URLs in the committed baseline");
  assert.ok(json.includes('"/app/customers?page=:v"'));
});
