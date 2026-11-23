// Saved sessions: what is saved, how it is kept, how it comes back.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "@playwright/test";
import {
  captureSession,
  clearSession,
  readSession,
  restoreSessionStorage,
  sessionExpired,
  sessionPath,
  storageStateFor,
  writeSession,
} from "../core/session.ts";
import { startSite, type Site } from "./explore/server.ts";

let browser: Browser;
let site: Site;
let dir: string;
before(async () => {
  site = await startSite({ open: true });
  site.set(
    "/app/store",
    "Store",
    `<h1>Store</h1><script>
      localStorage.setItem("token", "local-1");
      sessionStorage.setItem("msal", "session-1");
      document.cookie = "sid=cookie-1; path=/";
      const open = indexedDB.open("auth", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("keys");
      open.onsuccess = () => {
        const tx = open.result.transaction("keys", "readwrite");
        tx.objectStore("keys").put("idb-1", "token");
        tx.oncomplete = () => (window.ready = true);
      };
    </script>`,
  );
  site.set(
    "/app/read",
    "Read",
    `<h1>Read</h1><script>
      const open = indexedDB.open("auth", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("keys");
      open.onsuccess = () => {
        const req = open.result.transaction("keys").objectStore("keys").get("token");
        req.onsuccess = () => (window.values = {
          local: localStorage.getItem("token"),
          session: sessionStorage.getItem("msal"),
          cookie: document.cookie,
          idb: req.result ?? null,
          theme: localStorage.getItem("theme"),
        });
      };
    </script>`,
  );
  browser = await chromium.launch({
    channel: process.env.REC_CHANNEL === "chromium" ? undefined : "chrome",
  });
  dir = mkdtempSync(path.join(tmpdir(), "runcast-session-"));
});
after(async () => {
  await browser.close();
  await site.close();
  rmSync(dir, { recursive: true, force: true });
});

async function saveFromStore() {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${site.url}/app/store`);
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
  const session = await captureSession(context, { origin: site.url, pathPattern: "/login" });
  writeSession(dir, session);
  await context.close();
  return session;
}

async function readWith(seed: Record<string, string> = {}) {
  const session = readSession(dir)!;
  const context = await browser.newContext({ storageState: storageStateFor(session, site.url, seed) });
  await restoreSessionStorage(context, session);
  const page = await context.newPage();
  await page.goto(`${site.url}/app/read`);
  await page.waitForFunction(() => (window as unknown as { values?: unknown }).values);
  const values = await page.evaluate(() => (window as unknown as { values: Record<string, string | null> }).values);
  return { context, page, values };
}

test("a session round-trips cookies, local and session storage and IndexedDB", async () => {
  const saved = await saveFromStore();
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.signIn, { origin: site.url, pathPattern: "/login" });
  const { context, values } = await readWith();
  assert.equal(values.local, "local-1");
  assert.equal(values.session, "session-1");
  assert.match(values.cookie ?? "", /sid=cookie-1/);
  assert.equal(values.idb, "idb-1");
  await context.close();
});

test("the session file is private", { skip: process.platform === "win32" }, async () => {
  await saveFromStore();
  assert.equal(statSync(sessionPath(dir)).mode & 0o777, 0o600);
  assert.equal(sessionPath(dir), path.join(dir, ".auth", "session.json"));
});

test("seeded localStorage wins over the session's", async () => {
  await saveFromStore();
  const { context, values } = await readWith({ token: "seeded", theme: "dark" });
  assert.equal(values.local, "seeded");
  assert.equal(values.theme, "dark");
  await context.close();
});

test("the session's sessionStorage is restored once per tab", async () => {
  await saveFromStore();
  const { context, page } = await readWith();
  await page.evaluate(() => sessionStorage.setItem("msal", "app-own"));
  await page.reload();
  assert.equal(await page.evaluate(() => sessionStorage.getItem("msal")), "app-own");
  await context.close();
});

test("a session can be cleared", async () => {
  await saveFromStore();
  assert.equal(clearSession(dir), true);
  assert.equal(readSession(dir), null);
  assert.equal(clearSession(dir), false);
});

test("only the saved sign-in page means the session expired", async () => {
  site.set("/app/password", "Password", `<h1>Change password</h1><label>New <input type="password"></label>`);
  const page = await browser.newPage();
  const signIn = { origin: site.url, pathPattern: "/login" };
  await page.goto(`${site.url}/login`);
  assert.equal(await sessionExpired(page, signIn), true);
  await page.goto(`${site.url}/app/password`);
  assert.equal(await sessionExpired(page, signIn), false, "a change-password page");
  await page.goto(`${site.idpUrl}/signin`);
  assert.equal(await sessionExpired(page, signIn), false, "another origin");
  await page.goto(`${site.url}/`);
  assert.equal(await sessionExpired(page, { origin: site.url, pathPattern: "/" }), false, "sign-in at the root, signed in");
  await page.goto(`${site.idpUrl}/signin`);
  assert.equal(await sessionExpired(page, { origin: site.idpUrl, pathPattern: "/signin" }), true, "the provider's page");
  await page.close();
});
