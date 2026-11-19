// explore: page keys, file names and which links a crawl skips.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  pageKey,
  resolveBase,
  skipReason,
  slugFor,
  urlForKey,
} from "../scripts/explore/urls.ts";

const base = resolveBase("http://localhost:4173");
const key = (path: string) => pageKey(`http://localhost:4173${path}`, base);

test("ids collapse", () => {
  assert.equal(key("/customers/17"), "/customers/:id");
  assert.equal(key("/orders/3f2a9c1e-7b4d-4e2a-9c1e-7b4d4e2a9c1e"), "/orders/:id");
  assert.equal(key("/orders/a1b2c3d4e5"), "/orders/:id");
  assert.equal(key("/customers/new"), "/customers/new");
  assert.equal(key("/customers/settings"), "/customers/settings");
});

test("query values collapse", () => {
  assert.equal(key("/customers?page=2"), "/customers?page=:v");
  assert.equal(key("/customers?page=3"), "/customers?page=:v");
  assert.equal(key("/customers?sort=name&page=2"), "/customers?page=:v&sort=:v");
});

test("hash routes are pages", () => {
  assert.equal(key("/#/customers"), "/#/customers");
  assert.equal(key("/#/customers/17"), "/#/customers/:id");
  assert.equal(key("/customers#top"), "/customers");
});

test("keys are relative to a base path and pages outside it are skipped", () => {
  const app = resolveBase("https://example.com/app/");
  assert.deepEqual(app, { origin: "https://example.com", basePath: "/app/" });
  assert.equal(pageKey("https://example.com/app/customers", app), "/customers");
  assert.equal(pageKey("https://example.com/app/", app), "/");
  assert.equal(pageKey("https://example.com/app", app), "/");
  assert.equal(pageKey("https://example.com/blog", app), null);
  assert.equal(pageKey("https://other.example/app/customers", app), null);
  assert.equal(skipReason("/blog", { download: false, base: app }), "outside-base");
  assert.equal(urlForKey("/customers", app), "https://example.com/app/customers");
  assert.equal(urlForKey("/", app), "https://example.com/app/");
});

test("skip rules", () => {
  const skip = (href: string, extra?: RegExp, download = false) =>
    skipReason(href, { download, base, extra });
  assert.equal(skip("/logout"), "pattern");
  assert.equal(skip("/customers/17/delete"), "pattern");
  assert.equal(skip("/Sign-Out"), "pattern");
  assert.equal(skip("mailto:a@b.c"), "scheme");
  assert.equal(skip("tel:+100"), "scheme");
  assert.equal(skip("javascript:void(0)"), "scheme");
  assert.equal(skip("/export.csv"), "download");
  assert.equal(skip("/report", undefined, true), "download");
  assert.equal(skip("https://other.example/"), "other-origin");
  assert.equal(skip("/archive", /archive/), "pattern");
  assert.equal(skip("/customers"), null);
  assert.equal(skip("/#/orders"), null);
});

test("slugs keep letters of any script", () => {
  assert.equal(slugFor("/müşteriler/:id"), "müşteriler_id");
  assert.equal(slugFor("/"), "_root");
  assert.equal(slugFor("/customers?page=:v"), "customers_page_v");
  const long = `/${"a".repeat(200)}`;
  assert.ok(slugFor(long).length <= 89);
  assert.equal(slugFor(long), slugFor(long));
  assert.notEqual(slugFor(long), slugFor(`${long}b`));
});

test("slugs keep combining marks and avoid names Windows reserves", () => {
  // कि is क plus a vowel sign (a combining mark), not क followed by "_".
  assert.equal(slugFor("/कि"), "कि");
  assert.notEqual(slugFor("/कि"), slugFor("/क"));
  for (const reserved of ["/con", "/CON", "/nul", "/com1", "/lpt9", "/aux", "/prn"])
    assert.doesNotMatch(slugFor(reserved), /^(con|prn|aux|nul|com\d|lpt\d)$/i, reserved);
});

test("links that act are skipped by name, verb or method", () => {
  const skip = (href: string, o: { name?: string; method?: boolean } = {}) =>
    skipReason(href, { download: false, base, ...o });
  assert.equal(skip("/orders/7/go", { name: "Approve" }), "pattern");
  assert.equal(skip("/orders/7", { name: "Ada Lovelace" }), null);
  for (const verb of ["archive", "cancel", "approve", "reject", "send", "publish", "disable", "deactivate", "revoke", "reset", "void", "refund", "duplicate", "impersonate"])
    assert.equal(skip(`/orders/7/${verb}`), "pattern", verb);
  assert.equal(skip("/orders/7", { method: true }), "pattern");
});
