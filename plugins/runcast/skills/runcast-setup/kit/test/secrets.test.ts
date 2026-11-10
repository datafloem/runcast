// Secrets typed with rec.typeSecret (and any password field) must not reach
// what a failed run leaves behind: error-context.md, traces, attachments.
// A real Playwright run of a made-up project that uses the kit.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const KIT = path.resolve(import.meta.dirname, "..");
const PASSWORD = "S3cret-Pass-4242";
const TOKEN = "T0ken-Value-4242";

/** Every file under `dir`. */
function files(dir: string): Array<string> {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    return statSync(file).isDirectory() ? files(file) : [file];
  });
}

/** Whether `secret` appears in the file (inside zips: in any entry). */
function contains(file: string, secret: string): boolean {
  if (file.endsWith(".zip")) {
    const text = execFileSync("sh", ["-c", `unzip -p "$1" | strings`, "sh", file], {
      encoding: "utf-8",
      maxBuffer: 256 * 1024 * 1024,
    });
    return text.includes(secret);
  }
  return readFileSync(file).includes(secret);
}

test("a failed run keeps typed secrets out of its error context and trace", () => {
  const project = mkdtempSync(path.join(tmpdir(), "runcast-secrets-"));
  try {
    symlinkSync(KIT, path.join(project, ".kit"), "dir");
    writeFileSync(path.join(project, "kit.ts"), `export * from "./.kit/core/index.ts";\n`);
    writeFileSync(path.join(project, "package.json"), `{ "private": true, "type": "module" }\n`);
    writeFileSync(
      path.join(project, "recording.config.ts"),
      `import { defineProject } from "./kit.ts";\n` +
        `export default defineProject({ dir: import.meta.dirname, name: "Secrets", baseURL: "http://localhost:9" });\n`,
    );
    writeFileSync(
      path.join(project, "playwright.config.ts"),
      `import project from "./recording.config.ts";\n` +
        `import { definePlaywrightConfig } from "./.kit/core/playwright.ts";\n` +
        `export default await definePlaywrightConfig(project);\n`,
    );
    mkdirSync(path.join(project, "scenarios"));
    writeFileSync(
      path.join(project, "scenarios", "secrets.spec.ts"),
      `import { expect, test } from "../kit.ts";
test("secrets", async ({ page, rec }) => {
  await page.setContent('<label>Password <input id="pw" type="password"></label>' +
    '<label>API token <input id="tok" type="text"></label>');
  await rec.start();
  // Secrets come from settings, never from the scenario's text.
  await rec.typeSecret(page.locator("#pw"), process.env.DEMO_PASSWORD!);
  await rec.typeSecret(page.locator("#tok"), process.env.DEMO_TOKEN!);
  expect(await page.locator("#pw").evaluate((el) => (el as HTMLInputElement).value.length)).toBe(${PASSWORD.length});
  await expect(page.locator("#signed-in")).toBeVisible({ timeout: 300 });
});
`,
    );
    const run = spawnSync(
      process.execPath,
      [path.join(KIT, "node_modules", "@playwright", "test", "cli.js"), "test", "-c", project],
      {
        cwd: project,
        env: { ...process.env, REC_MODE: "test", REC_PROJECT: project, DEMO_PASSWORD: PASSWORD, DEMO_TOKEN: TOKEN },
        encoding: "utf-8",
      },
    );
    assert.notEqual(run.status, 0, "the scenario was meant to fail");
    if (!readdirSync(project).includes(".results")) assert.fail(`${run.stdout}\n${run.stderr}`);
    const left = files(path.join(project, ".results"));
    assert.ok(left.some((f) => f.endsWith("error-context.md")), `no error context in ${left}`);
    const leaks = left.filter((f) => contains(f, PASSWORD) || contains(f, TOKEN));
    assert.deepEqual(leaks.map((f) => path.relative(project, f)), []);
  } finally {
    if (process.env.KEEP_SECRETS_PROJECT) console.log(project);
    else rmSync(project, { recursive: true, force: true });
  }
});
