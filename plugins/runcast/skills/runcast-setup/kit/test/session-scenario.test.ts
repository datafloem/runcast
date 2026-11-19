// Saved sessions in use: the login scenario saves one, scenarios and
// explore start from it, a person can save one by hand, an expired one
// stops the run. A real Playwright run of a made-up project.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { readSession, sessionPath, writeSession } from "../core/session.ts";
import { explore, parseExploreArgs } from "../scripts/explore/run.ts";
import { manualSession } from "../scripts/session.ts";
import { startSite, type Site } from "./explore/server.ts";

const KIT = path.resolve(import.meta.dirname, "..");
let site: Site;
let project: string;

before(async () => {
  site = await startSite();
  project = mkdtempSync(path.join(tmpdir(), "runcast-session-scenario-"));
  symlinkSync(KIT, path.join(project, ".kit"), "dir");
  writeFileSync(path.join(project, "kit.ts"), `export * from "./.kit/core/index.ts";\n`);
  writeFileSync(path.join(project, "package.json"), `{ "private": true, "type": "module" }\n`);
  writeFileSync(
    path.join(project, "recording.config.ts"),
    `import { defineProject } from "./kit.ts";\n` +
      `export default defineProject({ dir: import.meta.dirname, name: "Demo", baseURL: ${JSON.stringify(site.url)} });\n`,
  );
  writeFileSync(
    path.join(project, "playwright.config.ts"),
    `import project from "./recording.config.ts";\n` +
      `import { definePlaywrightConfig } from "./.kit/core/playwright.ts";\n` +
      `export default await definePlaywrightConfig(project);\n`,
  );
  mkdirSync(path.join(project, "scenarios"));
  writeFileSync(
    path.join(project, "scenarios", "login.spec.ts"),
    `import { scenario, test, type Step } from "../kit.ts";
const login: Step = {
  id: "login",
  title: "Login",
  entry: async ({ page }) => { await page.goto("/login"); },
  run: async ({ page }) => {
    await page.locator('[name="username"]').fill("demo");
    await page.locator('[name="password"]').fill("demo-pass");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/app/customers");
  },
};
test("login", scenario({ steps: [login] }));
`,
  );
  writeFileSync(
    path.join(project, "scenarios", "customers.spec.ts"),
    `import { expect, open, scenario, test } from "../kit.ts";
test("customers", scenario({ steps: [
  open({ path: "/app/customers" }),
  { id: "check", title: "Check", run: async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Customers" })).toBeVisible();
  } },
] }));
`,
  );
});
after(async () => {
  await site.close();
  rmSync(project, { recursive: true, force: true });
});

/** Async: the app's server runs in this process and must keep answering. */
function playwright(
  scenarioFile: string,
  env: Record<string, string>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(KIT, "node_modules", "@playwright", "test", "cli.js"), "test", "-c", project, scenarioFile],
      { cwd: project, env: { ...process.env, REC_MODE: "test", REC_PROJECT: project, ...env } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("session runs only scenarios/login.spec.ts", () => {
  // A copy of the project with a runtime the CLI accepts (the kit, linked,
  // plus the marker setup writes) and another scenario whose name ends in
  // login.spec.ts, which must not run.
  const copy = mkdtempSync(path.join(tmpdir(), "runcast-session-filter-"));
  try {
    const runtime = path.join(copy, "runtime");
    mkdirSync(runtime);
    for (const entry of readdirSync(KIT)) symlinkSync(path.join(KIT, entry), path.join(runtime, entry));
    writeFileSync(path.join(runtime, ".runtime.json"), "{}");
    const dir = path.join(copy, "rec");
    cpSync(project, dir, { recursive: true, filter: (src) => !src.endsWith(`${path.sep}.kit`) && !src.includes(".auth") });
    symlinkSync(runtime, path.join(dir, ".kit"), "dir");
    writeFileSync(
      path.join(dir, "scenarios", "admin-login.spec.ts"),
      `import { scenario, test } from "../kit.ts";\ntest("admin login", scenario({ steps: [] }));\n`,
    );
    const { REC_PROJECT: _project, ...env } = process.env;
    const run = spawnSync(process.execPath, [path.join(dir, ".kit", "cli.ts"), "session", "--list"], {
      encoding: "utf-8",
      env,
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /login\.spec\.ts/);
    assert.doesNotMatch(run.stdout, /admin-login/);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test("the login scenario saves the session", async () => {
  const run = await playwright("login.spec.ts", { REC_SESSION: "0", REC_SAVE_SESSION: "1" });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const session = readSession(project);
  assert.ok(session, "no session saved");
  assert.equal(session.signIn?.pathPattern, "/login");
  assert.ok(session.storageState.cookies.some((c) => c.name === "session"));
  assert.match(run.stdout, /Session saved/);
  assert.doesNotMatch(readFileSync(sessionPath(project), "utf-8"), /demo-pass/);
});

test("a scenario starts from the saved session", async () => {
  const run = await playwright("customers.spec.ts", { REC_SESSION: "1" });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});

test("explore uses the session", async () => {
  const result = await explore(
    { dir: project, name: "Demo", baseURL: site.url },
    { ...parseExploreArgs(["/app/customers"]), session: true },
  );
  assert.equal(result.pages[0]?.signIn, false);
  assert.deepEqual(result.pages[0]?.headings, ["Customers"]);
});

test("the login scenario still signs in with REC_SESSION=1", async () => {
  const run = await playwright("login.spec.ts", { REC_SESSION: "1" });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});

test("with a session, explore notes other sign-in pages and goes on", async () => {
  const result = await explore(
    { dir: project, name: "Demo", baseURL: site.url },
    { ...parseExploreArgs(["/sso", "/app/customers"]), session: true },
  );
  assert.deepEqual(result.needsSession, ["/sso"]);
  assert.ok(result.pages.some((p) => p.key === "/app/customers" && !p.signIn));
});

test("an expired session keeps the pages explored before it", async () => {
  const session = readSession(project)!;
  writeSession(project, { ...session, storageState: { ...session.storageState, cookies: [] } });
  await assert.rejects(
    explore({ dir: project, name: "Demo", baseURL: site.url }, { ...parseExploreArgs(["/help", "/app/customers"]), session: true }),
    /saved session has expired/,
  );
  const index = JSON.parse(readFileSync(path.join(project, ".explore", "index.json"), "utf-8")) as Record<string, unknown>;
  assert.ok("/help" in index);
  writeSession(project, session);
});

test("an expired session stops scenarios and explore", async () => {
  const session = readSession(project)!;
  writeSession(project, { ...session, storageState: { ...session.storageState, cookies: [] } });
  const run = await playwright("customers.spec.ts", { REC_SESSION: "1" });
  assert.notEqual(run.status, 0);
  assert.match(`${run.stdout}${run.stderr}`, /saved session has expired/);
  await assert.rejects(
    explore(
      { dir: project, name: "Demo", baseURL: site.url },
      { ...parseExploreArgs(["/app/customers"]), session: true },
    ),
    /saved session has expired/,
  );
  writeSession(project, session);
});

test("manualSession saves after the page leaves sign-in", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "runcast-manual-"));
  try {
    const saved = await manualSession(
      { dir, name: "Demo", baseURL: site.url },
      {
        headless: true,
        drive: async (page) => {
          await page.goto(`${site.url}/login`);
          await page.locator('[name="username"]').fill("demo");
          await page.locator('[name="password"]').fill("demo-pass");
          await page.getByRole("button", { name: "Sign in" }).click();
          await page.waitForURL("**/app/customers");
        },
      },
    );
    assert.equal(saved, true);
    const session = readSession(dir);
    assert.equal(session?.signIn?.pathPattern, "/login");
    assert.ok(session?.storageState.cookies.some((c) => c.name === "session"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manualSession saves nothing when the page never leaves sign-in", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "runcast-manual-"));
  try {
    const saved = await manualSession(
      { dir, name: "Demo", baseURL: site.url },
      { headless: true, drive: async (page) => void (await page.goto(`${site.url}/login`)) },
    );
    assert.equal(saved, false);
    assert.equal(readSession(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session without a login scenario points to --manual", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "runcast-nologin-"));
  try {
    const run = spawnSync(process.execPath, [path.join(KIT, "cli.ts"), "session", "--dir", dir], {
      encoding: "utf-8",
    });
    assert.notEqual(run.status, 0);
    assert.match(`${run.stdout}${run.stderr}`, /No login scenario: sign in by hand with `.*session --manual`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
