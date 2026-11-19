// Saved sign-in sessions, for apps whose sign-in a scenario cannot do (SSO,
// two-factor, a captcha) and for explore to see pages behind sign-in.
// Not importing mode.ts: core/playwright.ts uses this before the project's
// settings are final.
import type { BrowserContext, BrowserContextOptions, Page } from "@playwright/test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { kitCommand } from "./project.ts";

/** Where the app signs in, learnt when the session is saved. */
export interface SignIn {
  origin: string;
  /** Path of the sign-in page; it and paths below it count as sign-in. */
  pathPattern: string;
}

export function signInFromUrl(url: string): SignIn {
  const parsed = new URL(url);
  return { origin: parsed.origin, pathPattern: parsed.pathname };
}

function trimSlash(path: string): string {
  return path.replace(/\/+$/, "");
}

function onSignInPath(url: URL, signIn: SignIn): boolean {
  if (url.origin !== signIn.origin) return false;
  const path = trimSlash(url.pathname);
  const pattern = trimSlash(signIn.pathPattern);
  return path === pattern || (pattern !== "" && path.startsWith(`${pattern}/`));
}

/**
 * The page is a sign-in page: on another origin than the app (an identity
 * provider), on the sign-in path learnt when the session was saved, or it
 * shows a password field.
 */
export async function looksLikeSignIn(
  page: Page,
  baseURL: string,
  signIn?: SignIn | null,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(page.url());
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.origin !== new URL(baseURL).origin) return true;
  if (signIn && onSignInPath(url, signIn)) return true;
  return page
    .locator('input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);
}

/**
 * The saved session no longer signs in: the page landed on the sign-in page
 * learnt when it was saved. Other origins and other password fields (a
 * change-password page) are not expiry. A sign-in page at the app's root
 * counts only while it shows a password field.
 */
export async function sessionExpired(page: Page, signIn: SignIn | null): Promise<boolean> {
  if (!signIn) return false;
  let url: URL;
  try {
    url = new URL(page.url());
  } catch {
    return false;
  }
  if (!onSignInPath(url, signIn)) return false;
  if (trimSlash(signIn.pathPattern) !== "") return true;
  return page
    .locator('input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);
}

/**
 * For the login scenario under REC_SESSION=1: it must sign in itself, so the
 * session's cookies go and, once per tab, the localStorage entries it brought
 * (except the project's seeded ones, `keep`).
 */
export async function forgetSession(
  context: BrowserContext,
  session: SessionFile,
  keep: Array<string>,
): Promise<void> {
  await context.clearCookies();
  const entries = session.storageState.origins.map((o) => ({
    origin: o.origin,
    names: o.localStorage.map((item) => item.name).filter((name) => !keep.includes(name)),
  }));
  await context.addInitScript(
    ({ entries, marker }) => {
      try {
        if (sessionStorage.getItem(marker)) return;
        for (const name of entries.find((e) => e.origin === location.origin)?.names ?? [])
          localStorage.removeItem(name);
        sessionStorage.setItem(marker, "1");
      } catch {
        // A page without storage.
      }
    },
    { entries, marker: "__runcast_forgotten" },
  );
}

/** Playwright's storage state: cookies, and per origin localStorage and IndexedDB. */
export type StorageState = Exclude<NonNullable<BrowserContextOptions["storageState"]>, string>;

export interface SessionFile {
  version: 1;
  savedAt: string;
  signIn: SignIn | null;
  storageState: StorageState;
  /** Playwright does not save sessionStorage; the kit does. */
  sessionStorage: Array<{ origin: string; items: Array<{ name: string; value: string }> }>;
}

/** Set in sessionStorage once a tab got the saved items, so they are not set twice. */
const RESTORED = "__runcast_restored";

export function sessionPath(dir: string): string {
  return path.join(dir, ".auth", "session.json");
}

export function readSession(dir: string): SessionFile | null {
  try {
    return JSON.parse(readFileSync(sessionPath(dir), "utf-8")) as SessionFile;
  } catch {
    return null;
  }
}

/** Writes the session for the owner only: it is a credential. */
export function writeSession(dir: string, session: SessionFile): void {
  const file = sessionPath(dir);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function clearSession(dir: string): boolean {
  const file = sessionPath(dir);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

export function noSessionMessage(dir: string): string {
  return `No saved session. Run \`${kitCommand(dir)} session\` first (REC_SESSION=1).`;
}

/** The context's state, with IndexedDB and every open page's sessionStorage. */
export async function captureSession(
  context: BrowserContext,
  signIn: SignIn | null,
): Promise<SessionFile> {
  const storageState = await context.storageState({ indexedDB: true });
  const byOrigin = new Map<string, Array<{ name: string; value: string }>>();
  for (const page of context.pages()) {
    const found = await page
      .evaluate((marker) => {
        const items: Array<{ name: string; value: string }> = [];
        for (let i = 0; i < sessionStorage.length; i++) {
          const name = sessionStorage.key(i)!;
          if (name !== marker) items.push({ name, value: sessionStorage.getItem(name) ?? "" });
        }
        return { origin: location.origin, items };
      }, RESTORED)
      .catch(() => null);
    if (found && found.origin !== "null" && found.items.length) byOrigin.set(found.origin, found.items);
  }
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    signIn,
    storageState,
    sessionStorage: [...byOrigin].map(([origin, items]) => ({ origin, items })),
  };
}

/** The session's state for a new context; the project's seeded localStorage wins. */
export function storageStateFor(
  session: SessionFile,
  baseURL: string,
  seed: Record<string, string>,
): StorageState {
  const origin = new URL(baseURL).origin;
  const origins = session.storageState.origins.map((o) => ({ ...o }));
  let entry = origins.find((o) => o.origin === origin);
  if (!entry) {
    entry = { origin, localStorage: [] };
    origins.push(entry);
  }
  entry.localStorage = [
    ...entry.localStorage.filter((item) => !(item.name in seed)),
    ...Object.entries(seed).map(([name, value]) => ({ name, value })),
  ];
  return { cookies: session.storageState.cookies, origins };
}

/** Puts the saved sessionStorage back in each new tab, once, before the app runs. */
export async function restoreSessionStorage(
  context: BrowserContext,
  session: SessionFile,
): Promise<void> {
  if (!session.sessionStorage.length) return;
  await context.addInitScript(
    ({ entries, marker }) => {
      try {
        if (sessionStorage.getItem(marker)) return;
        const entry = entries.find((e) => e.origin === location.origin);
        if (!entry) return;
        for (const { name, value } of entry.items) sessionStorage.setItem(name, value);
        sessionStorage.setItem(marker, "1");
      } catch {
        // A page without storage (about:blank, a sandboxed frame).
      }
    },
    { entries: session.sessionStorage, marker: RESTORED },
  );
}
