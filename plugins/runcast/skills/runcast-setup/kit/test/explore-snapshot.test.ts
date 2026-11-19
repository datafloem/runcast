// explore: what a page snapshot holds, and what it never holds.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { snapshotPage } from "../scripts/explore/snapshot.ts";
import { resolveBase } from "../scripts/explore/urls.ts";
import { startSite, type Site } from "./explore/server.ts";

let browser: Browser;
let context: BrowserContext;
let page: Page;
let site: Site;
before(async () => {
  site = await startSite();
  browser = await chromium.launch({
    channel: process.env.REC_CHANNEL === "chromium" ? undefined : "chrome",
  });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies([{ name: "session", value: "ok", url: site.url }]);
  page = await context.newPage();
});
after(async () => {
  await browser.close();
  await site.close();
});

async function snap(path: string) {
  const url = `${site.url}${path}`;
  const response = await page.goto(url);
  return snapshotPage(page, resolveBase(site.url), {
    status: response?.status() ?? null,
    requestedUrl: url,
    baseURL: site.url,
  });
}

test("controls are read without values", async () => {
  const s = await snap("/app/customers/17/edit");
  const name = s.controls.find((c) => c.nameAttr === "name");
  assert.deepEqual(
    { role: name?.role, name: name?.name, required: name?.required, maxLength: name?.maxLength },
    { role: "textbox", name: "Name", required: true, maxLength: 80 },
  );
  assert.deepEqual(name?.hooks, { "data-testid": "customer-name" });
  assert.equal(name?.form, "New customer");
  const email = s.controls.find((c) => c.nameAttr === "email");
  assert.equal(email?.type, "email");
  assert.equal(email?.placeholder, "name@company.com");
  assert.deepEqual(s.controls.find((c) => c.nameAttr === "country")?.options, ["France", "Germany"]);
  assert.equal(s.controls.find((c) => c.nameAttr === "note")?.name, "Note");
  assert.ok(s.controls.some((c) => c.role === "button" && c.name === "Save"));
  assert.ok(!s.controls.some((c) => c.nameAttr === "csrf"), "hidden inputs are left out");
  const json = JSON.stringify(s);
  for (const secret of ["Ada Lovelace", "ada@example.com", "Prefers email", "token-123"])
    assert.ok(!json.includes(secret), `${secret} leaked`);
  assert.ok(s.redacted.values >= 2);
});

test("links are grouped, data links hidden, skipped links listed", async () => {
  const s = await snap("/app/customers");
  const nav = s.links.filter((l) => l.landmark === "nav").map((l) => l.name);
  assert.deepEqual(nav, ["Customers", "Orders"]);
  assert.ok(s.links.some((l) => l.key === "/#/orders"));
  const data = s.links.filter((l) => l.key === "/app/customers/:id");
  assert.ok(data.length >= 1);
  assert.ok(data.every((l) => l.name === "…"));
  assert.ok(s.links.some((l) => l.key === "/app/customers?page=:v" && l.name === "Next page"));
  const skipped = s.skipped.map((l) => [l.href, l.reason]);
  assert.ok(skipped.some(([h, r]) => String(h).endsWith("/logout") && r === "pattern"));
  assert.ok(skipped.some(([h, r]) => String(h).endsWith("/delete") && r === "pattern"));
  assert.ok(skipped.some(([, r]) => r === "scheme"));
  assert.ok(s.hooks.includes("customer-table"));
  const json = JSON.stringify(s);
  for (const secret of ["Ada Lovelace", "Grace", "alan@example.com"])
    assert.ok(!json.includes(secret), `${secret} leaked`);
  assert.ok(s.redacted.rows >= 4);
  assert.deepEqual(s.headings, ["Customers"]);
});

test("storage and cookies are names only", async () => {
  const s = await snap("/app/customers");
  assert.deepEqual(s.storage.local, ["theme"]);
  assert.deepEqual(s.storage.session, ["draft"]);
  assert.ok(s.storage.cookies.includes("session"));
  const json = JSON.stringify(s);
  assert.ok(!json.includes("dark") && !json.includes("secret-draft") && !json.includes('"ok"'));
});

test("brand is read", async () => {
  const s = await snap("/");
  assert.equal(s.brand.themeColor, "#2f6feb");
  assert.equal(s.brand.cssColors["--accent"], "#2f6feb");
  assert.ok(!("--radius" in s.brand.cssColors));
  assert.ok(s.brand.logos.some((l) => l.endsWith("/logo.svg")));
  assert.ok(s.brand.icons.some((l) => l.endsWith("/favicon.ico")));
  assert.ok(s.brand.icons.some((l) => l.endsWith("/og.png")));
});

test("the button colour is read from the most prominent button", async () => {
  const s = await snap("/app/customers/new");
  assert.equal(s.brand.buttonColor, "rgb(47, 111, 235)");
});

test("same-origin frames are read", async () => {
  const s = await snap("/app/frame");
  assert.equal(s.frames.length, 1);
  assert.equal(s.frames[0]!.sameOrigin, true);
  assert.ok(s.frames[0]!.controls?.some((c) => c.nameAttr === "subject"));
  assert.match(s.frames[0]!.aria ?? "", /Quick note/);
});

test("a record page hides its title and main heading", async () => {
  const s = await snap("/app/customers/17");
  assert.equal(s.key, "/app/customers/:id");
  const json = JSON.stringify(s);
  assert.ok(!json.includes("Ada") && !json.includes("555-1234"), json);
  assert.deepEqual(s.headings, ["…"]);
});

test("the sign-in page is recognised", async () => {
  await context.clearCookies();
  const s = await snap("/app/customers");
  assert.equal(s.signIn, true);
  assert.match(s.finalUrl, /\/login$/);
  await context.addCookies([{ name: "session", value: "ok", url: site.url }]);
  assert.equal((await snap("/app/customers")).signIn, false);
  const sso = await snap("/sso");
  assert.equal(sso.signIn, true);
  assert.ok(sso.finalUrl.startsWith(site.idpUrl));
});

test("a page is snapshotted after it settles", async () => {
  const s = await snap("/");
  assert.equal(s.settled, true);
  assert.equal(s.status, 200);
  assert.equal(s.title, "Dashboard – Demo CRM");
});
