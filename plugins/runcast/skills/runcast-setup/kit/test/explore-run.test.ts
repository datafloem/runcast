// explore: a whole run against the made-up customers app.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { explore, parseExploreArgs, type ExploreOptions } from "../scripts/explore/run.ts";
import type { ProjectConfig } from "../core/project.ts";
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
  assert.equal(String(parseExploreArgs(["--skip", "archive"]).skip), "/archive/i");
  assert.equal(parseExploreArgs(["--forget", "/a"]).forget, "/a");
  assert.equal(parseExploreArgs(["--mobile", "--diff"]).mobile, true);
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
