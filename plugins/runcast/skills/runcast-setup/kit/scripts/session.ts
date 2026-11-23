// The saved sign-in session (<recording folder>/.auth/session.json).
//
//   node <dir>/.kit/cli.ts session --manual   a visible Chrome at the app; a person
//                                             signs in, then closes the window
//   node <dir>/.kit/cli.ts session --clear    removes the saved session
//
// (`session` alone runs the project's login scenario and saves its session;
// the CLI does that through Playwright.)
import type { Page } from "@playwright/test";
import path from "node:path";
import { loadProject, type ProjectConfig } from "../core/project.ts";
import {
  captureSession,
  clearSession,
  looksLikeSignIn,
  signInFromUrl,
  writeSession,
  type SessionFile,
  type SignIn,
} from "../core/session.ts";
import { openBrowser } from "./explore/run.ts";

const CAPTURE_EVERY_MS = 2000;

/**
 * Opens the app for a person to sign in. Takes the state every two seconds
 * and on every page change while the page is past the sign-in page; when the
 * window closes (or `stop` resolves) it saves the last state taken after
 * leaving the sign-in page. False when the page never left sign-in.
 * `drive` stands in for the person in tests.
 */
export async function manualSession(
  project: ProjectConfig,
  launch: { headless?: boolean; stop?: Promise<void>; drive?: (page: Page) => Promise<void> } = {},
): Promise<boolean> {
  const { browser, page } = await openBrowser(project, { headless: launch.headless ?? false });
  const context = page.context();
  let signIn: SignIn | null = null;
  let saved: SessionFile | null = null;
  let busy: Promise<void> = Promise.resolve();

  const take = () => {
    busy = busy.then(async () => {
      if (page.isClosed()) return;
      if (await looksLikeSignIn(page, project.baseURL)) {
        signIn ??= signInFromUrl(page.url());
        return;
      }
      if (signIn) saved = await captureSession(context, signIn);
    }).catch(() => {});
    return busy;
  };
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) void take();
  });
  const timer = setInterval(() => void take(), CAPTURE_EVERY_MS);
  const closed = new Promise<void>((resolve) => {
    page.once("close", () => resolve());
    browser.once("disconnected", () => resolve());
  });

  try {
    await page.goto(project.baseURL);
    await take();
    const ended = launch.drive
      ? launch.drive(page)
      : Promise.race([closed, launch.stop ?? new Promise<void>(() => {}), enterPressed()]);
    await ended;
    await take();
  } finally {
    clearInterval(timer);
    await busy;
    await browser.close().catch(() => {});
  }
  if (!saved) return false;
  writeSession(project.dir, saved);
  return true;
}

function enterPressed(): Promise<void> {
  if (!process.stdin.isTTY) return new Promise(() => {});
  return new Promise((resolve) => {
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const project = await loadProject();
  const args = process.argv.slice(2);
  if (args.includes("--clear")) {
    console.log(clearSession(project.dir) ? "Session removed." : "No saved session.");
  } else if (args.includes("--manual")) {
    console.log("A Chrome window opens at the app: sign in, then close the window.");
    const ok = await manualSession(project);
    console.log(
      ok
        ? "Session saved (.auth/session.json). Set REC_SESSION=1 in .env.local to use it."
        : "Nothing saved: the page never left the sign-in page.",
    );
    // A terminal's stdin, read for Enter, would keep node running.
    process.exit(ok ? 0 : 1);
  } else {
    console.error("Use session (runs the login scenario), session --manual or session --clear.");
    process.exit(1);
  }
}
