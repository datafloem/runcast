// explore: a whole run against the made-up customers app.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { explore, parseExploreArgs, type ExploreOptions } from "../scripts/explore/run.ts";
import type { ProjectConfig } from "../core/project.ts";
import { writeSession } from "../core/session.ts";
import { startSite, type Site } from "./explore/server.ts";

let site: Site;
let dir: string;
let project: ProjectConfig;
before(async () => {
  site = await startSite({ open: true });
});
after(() => site.close());
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "runcast-explore-"));
  project = { dir, name: "Demo", baseURL: site.url };
  site.requests.length = 0;
});

const options = (o: Partial<ExploreOptions> = {}): ExploreOptions => ({
  ...parseExploreArgs([]),
  session: false,
  ...o,
});
const index = () =>
  JSON.parse(readFileSync(path.join(dir, ".explore", "index.json"), "utf-8")) as Record<string, unknown>;

test("arguments are parsed", () => {
  assert.deepEqual(parseExploreArgs(["/a", "--crawl", "--max", "5"]).crawl, 2);
  assert.equal(parseExploreArgs(["--crawl=3"]).crawl, 3);
  assert.equal(parseExploreArgs([]).crawl, null);
  assert.equal(parseExploreArgs([]).max, 30);
  assert.deepEqual(parseExploreArgs(["/a", "/b"]).paths, ["/a", "/b"]);
  assert.equal(parseExploreArgs(["--no-session"]).session, false);
  assert.deepEqual(parseExploreArgs(["--skip", "Archive", "--skip", "/billing"]).skip, ["archive", "/billing"]);
  assert.equal(parseExploreArgs(["--forget", "/a"]).forget, "/a");
  assert.equal(parseExploreArgs(["--mobile", "--diff"]).mobile, true);
});

test("depth 0 means only the given pages, and bad numbers are refused", () => {
  assert.equal(parseExploreArgs(["/a", "--crawl=0"]).crawl, null);
  for (const bad of [["--crawl=-1"], ["--crawl=two"], ["--max", "0"], ["--max", "many"], ["--max", "2.5"]])
    assert.throws(() => parseExploreArgs(bad), /whole number/, bad.join(" "));
});

test("--accept refuses options it would ignore", () => {
  assert.equal(parseExploreArgs(["--accept"]).accept, true);
  assert.equal(parseExploreArgs(["--accept", "--no-session"]).accept, true);
  for (const extra of [["--diff"], ["/a"], ["--crawl"], ["--mobile"], ["--headed"], ["--max", "5"], ["--skip", "x"], ["--forget", "/a"]])
    assert.throws(() => parseExploreArgs(["--accept", ...extra]), /--accept/, extra.join(" "));
});

test("run.json records the settings", async () => {
  const result = await explore(project, options({ paths: ["/help"], max: 5, skip: ["archive"] }));
  const info = JSON.parse(readFileSync(path.join(result.runDir, "run.json"), "utf-8")) as {
    settings: Record<string, unknown>;
  };
  assert.deepEqual(
    { ...info.settings, channel: undefined },
    {
      baseURL: site.url,
      crawl: null,
      max: 5,
      skip: ["archive"],
      session: false,
      headed: false,
      mobile: false,
      diff: false,
      channel: undefined,
    },
  );
});

test("pages whose names differ only in case or punctuation get their own folders", async () => {
  site.set("/About", "Upper", "<h1>Upper</h1>");
  site.set("/about", "Lower", "<h1>Lower</h1>");
  site.set("/a.b", "Dotted", "<h1>Dotted</h1>");
  site.set("/a/b", "Nested", "<h1>Nested</h1>");
  await explore(project, options({ paths: ["/About", "/about", "/a.b", "/a/b"] }));
  const entries = index() as Record<string, { slug: string }>;
  const slugs = ["/About", "/about", "/a.b", "/a/b"].map((k) => entries[k]!.slug.toLowerCase());
  assert.equal(new Set(slugs).size, 4, slugs.join(", "));
  const title = (key: string) =>
    (JSON.parse(readFileSync(path.join(dir, ".explore", "pages", entries[key]!.slug, "page.json"), "utf-8")) as {
      title: string;
    }).title;
  // The layout adds the app's name to every title.
  assert.deepEqual(
    ["/About", "/about", "/a.b", "/a/b"].map((k) => title(k).split(" – ")[0]),
    ["Upper", "Lower", "Dotted", "Nested"],
  );
});

test("the summary lists sessionStorage keys on their own", async () => {
  site.set("/wizard", "Wizard", "<h1>Wizard</h1><script>sessionStorage.setItem('wizard-step', '2')</script>");
  await explore(project, options({ paths: ["/wizard"] }));
  assert.match(readFileSync(path.join(dir, ".explore", "summary.md"), "utf-8"), /wizard-step/);
});

test("control names with | or \\ keep the summary's table intact", async () => {
  site.set(
    "/odd",
    "Odd",
    `<h1>Odd</h1><form aria-label="Odd \\ form"><label>Path a\\|b <input name="p"></label></form>`,
  );
  await explore(project, options({ paths: ["/odd"] }));
  const row = readFileSync(path.join(dir, ".explore", "summary.md"), "utf-8")
    .split("\n")
    .find((l) => l.includes("`p`") || l.includes("| p |"));
  assert.ok(row, "no row for the control");
  // Five columns: six pipes that are not escaped by a backslash.
  const bare = row.replace(/\\\\/g, "").replace(/\\\|/g, "");
  assert.equal(bare.split("|").length - 1, 6, row);
  assert.match(row, /Path a\\\\\\\|b/);
  assert.match(row, /Odd \\\\ form/);
});

test("skipped links in data keep neither their address nor repeats", async () => {
  site.set(
    "/rows",
    "Rows",
    `<h1>Rows</h1><table><tr><th>Name</th><th></th></tr>
     <tr><td>Ada</td><td><a href="/customers/ada-lovelace/delete">Delete</a> <a href="https://ada-lovelace.example/">Site</a></td></tr>
     <tr><td>Alan</td><td><a href="/customers/alan-turing/delete">Delete</a> <a href="https://alan-turing.example/">Site</a></td></tr></table>`,
  );
  await explore(project, options({ paths: ["/rows"] }));
  const pageJson = readFileSync(path.join(dir, ".explore", "pages", "rows", "page.json"), "utf-8");
  const text = pageJson + readFileSync(path.join(dir, ".explore", "summary.md"), "utf-8");
  assert.doesNotMatch(text, /ada-lovelace|alan-turing/);
  // One entry per kind, not one per row (the layout's own skipped links aside).
  const skipped = (JSON.parse(pageJson) as { skipped: Array<{ href: string; reason: string }> }).skipped;
  assert.deepEqual(skipped.filter((s) => s.href === "…").map((s) => s.reason).sort(), ["other-origin", "pattern"]);
});

test("--headed knows the saved sign-in page", async () => {
  writeSession(dir, {
    version: 1,
    savedAt: new Date().toISOString(),
    signIn: { origin: new URL(site.url).origin, pathPattern: "/help" },
    storageState: { cookies: [], origins: [] },
    sessionStorage: [],
  });
  const result = await explore(project, options({ paths: ["/help"], headed: true, session: true }), {
    headless: true,
    stop: Promise.resolve(),
  });
  assert.equal(result.pages[0]?.key, "/help");
  assert.equal(result.pages[0]?.signIn, true);
});

test("explore writes a run and a merged view", async () => {
  const result = await explore(project, options({ paths: ["/app/customers/new"] }));
  const page = path.join(result.runDir, "pages", "app_customers_new");
  for (const file of ["page.json", "aria.yml", "screenshot.png"])
    assert.ok(existsSync(path.join(page, file)), file);
  assert.ok(!("aria" in JSON.parse(readFileSync(path.join(page, "page.json"), "utf-8"))));
  assert.ok(existsSync(path.join(dir, ".explore", "pages", "app_customers_new", "aria.yml")));
  assert.ok(existsSync(path.join(result.runDir, "run.json")));
  assert.match(readFileSync(path.join(dir, ".explore", "summary.md"), "utf-8"), /New customer/);
});

test("a single-page run keeps the rest of the merged view", async () => {
  await explore(project, options({ paths: ["/"], crawl: 1 }));
  await explore(project, options({ paths: ["/app/customers/new"] }));
  assert.ok("/app/customers" in index());
  assert.ok("/app/customers/new" in index());
  assert.match(readFileSync(path.join(dir, ".explore", "summary.md"), "utf-8"), /\/app\/customers\n/);
});

test("crawl follows same-origin links within depth and max", async () => {
  const one = await explore(project, options({ paths: ["/"], crawl: 1 }));
  const keys = one.pages.map((p) => p.key);
  assert.ok(keys.includes("/app/customers"));
  assert.ok(!keys.includes("/app/customers/:id"), "depth 1 stops before customer pages");
  const two = await explore(project, options({ paths: ["/"], crawl: 2 }));
  assert.equal(two.pages.filter((p) => p.key === "/app/customers/:id").length, 1);
  const capped = await explore(project, options({ paths: ["/"], crawl: 2, max: 2 }));
  assert.equal(capped.pages.length, 2);
});

test("explore never acts", async () => {
  await explore(project, options({ paths: ["/"], crawl: 3 }));
  const paths = site.requests.map((r) => r.path);
  for (const forbidden of ["/logout", "/app/customers/17/delete", "/export.csv", "/report"])
    assert.ok(!paths.includes(forbidden), `${forbidden} was requested`);
  assert.ok(site.requests.every((r) => r.method === "GET"));
});

test("a redirect to another origin is a sign-in page and is not crawled", async () => {
  const result = await explore(project, options({ paths: ["/sso"], crawl: 2 }));
  assert.deepEqual(result.needsSession, ["/sso"]);
  assert.equal(result.pages.length, 1);
});

test("explore marks a polling page unsettled within the caps", async () => {
  const start = Date.now();
  const result = await explore(project, options({ paths: ["/poll"] }));
  assert.deepEqual(result.unsettled, ["/poll"]);
  // The caps are 10 s (network) + 5 s (DOM); the rest is the browser starting,
  // which is slow when the whole suite runs at once. It must end, not hang.
  assert.ok(Date.now() - start < 45_000, `took ${Date.now() - start} ms`);
});

test("an address that does not load is reported", async () => {
  await assert.rejects(
    explore({ ...project, baseURL: "http://127.0.0.1:1" }, options()),
    /Could not open http:\/\/127\.0\.0\.1:1\//,
  );
});

test("only ten runs are kept", async () => {
  for (let i = 0; i < 11; i++) await explore(project, options({ paths: ["/help"] }));
  assert.equal(readdirSync(path.join(dir, ".explore", "runs")).length, 10);
});

test("forget drops a page from the merged view", async () => {
  await explore(project, options({ paths: ["/help", "/"] }));
  await explore(project, options({ paths: [], forget: "/help" }));
  assert.ok(!("/help" in index()));
  assert.ok(!existsSync(path.join(dir, ".explore", "pages", "help")));
  assert.ok("/" in index());
});

test("--mobile adds the narrow-screen check and a second screenshot", async () => {
  const result = await explore(project, options({ paths: ["/"], mobile: true }));
  assert.equal(result.pages[0]?.mobile?.overflow, false);
  assert.ok(existsSync(path.join(result.runDir, "pages", "_root", "mobile.png")));
  assert.match(readFileSync(path.join(dir, ".explore", "summary.md"), "utf-8"), /Mobile:/);
});

test("hash-routed and query-routed record links are crawled under their own keys", async () => {
  site.set(
    "/app/orders",
    "Orders",
    `<h1>Orders</h1><table><tbody>
      <tr><td><a href="/#/orders/17">Order for Ada</a></td></tr>
      <tr><td><a href="/#/orders/18">Order for Grace</a></td></tr>
      <tr><td><a href="/order?id=17">Ada's order</a></td></tr>
    </tbody></table>`,
  );
  const result = await explore(project, options({ paths: ["/app/orders"], crawl: 1 }));
  const keys = result.pages.map((p) => p.key);
  assert.ok(keys.includes("/#/orders/:id"), keys.join(", "));
  assert.ok(keys.includes("/order?id=:v"), keys.join(", "));
  const pageJson = readFileSync(path.join(result.runDir, "pages", "app_orders", "page.json"), "utf-8");
  assert.ok(!pageJson.includes("/orders/17") && !pageJson.includes("id=17"), "link URLs stay out of page.json");
});

test("records addressed by name collapse to one page", async () => {
  site.set(
    "/app/people",
    "People",
    `<h1>People</h1><table><tbody>
      <tr><td><a href="/app/people/ada-lovelace" data-testid="person-row-1">Ada</a></td></tr>
      <tr><td><a href="/app/people/grace-hopper" data-testid="person-row-2">Grace</a></td></tr>
    </tbody></table><a href="/app/people/new">New person</a>`,
  );
  site.set("/app/people/ada-lovelace", "Ada Lovelace", "<h1>Ada Lovelace</h1>");
  site.set("/app/people/grace-hopper", "Grace Hopper", "<h1>Grace Hopper</h1>");
  const result = await explore(project, options({ paths: ["/app/people"], crawl: 1 }));
  const keys = result.pages.map((p) => p.key);
  assert.deepEqual(keys.filter((k) => k.startsWith("/app/people/")).sort(), ["/app/people/:id", "/app/people/new"]);
  // What the assistant reads (index.json keeps the last URLs locally, for --diff).
  const all =
    readFileSync(path.join(dir, ".explore", "summary.md"), "utf-8") +
    readFileSync(path.join(dir, ".explore", "pages", "app_people_id", "page.json"), "utf-8") +
    readFileSync(path.join(dir, ".explore", "pages", "app_people", "page.json"), "utf-8");
  assert.ok(!/ada|grace|person-row/i.test(all), all);
});

test("a page whose load never finishes is still explored", async () => {
  site.set("/slow", "Slow", `<h1>Slow</h1><img src="/hang" alt="">`);
  const result = await explore(project, options({ paths: ["/slow"] }));
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.unsettled, ["/slow"]);
  assert.deepEqual(result.pages[0]?.headings, ["Slow"]);
});

test("addresses outside the base URL are refused before a browser starts", async () => {
  // A browser that cannot start: launching one would fail with another error
  // (and one left open would keep this file running).
  const channel = process.env.REC_CHANNEL;
  process.env.REC_CHANNEL = "no-such-channel";
  try {
    await assert.rejects(explore(project, options({ paths: ["https://other.example/"] })), /outside the base URL/);
  } finally {
    if (channel === undefined) delete process.env.REC_CHANNEL;
    else process.env.REC_CHANNEL = channel;
  }
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});
