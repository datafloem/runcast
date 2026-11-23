// The Playwright config every project uses, per mode.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const CONFIG = path.join(import.meta.dirname, "..", "core", "playwright.ts");

function useFor(mode: string): Record<string, unknown> {
  const dir = mkdtempSync(path.join(tmpdir(), "runcast-config-"));
  try {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("REC_")));
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { definePlaywrightConfig } = await import(${JSON.stringify(CONFIG)});
         const config = await definePlaywrightConfig({ dir: ${JSON.stringify(dir)}, name: "Demo", baseURL: "http://localhost:3000" });
         console.log(JSON.stringify(config.use));`,
      ],
      { env: { ...clean, REC_MODE: mode }, encoding: "utf-8" },
    );
    return JSON.parse(out.trim().split("\n").at(-1)!) as Record<string, unknown>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("video mode writes no trace; tests keep one without DOM snapshots", () => {
  assert.equal(useFor("video").trace, "off");
  assert.deepEqual(useFor("test").trace, {
    mode: "retain-on-failure",
    snapshots: false,
    screenshots: true,
    sources: true,
  });
});

function useWithSession(withFile: boolean): Record<string, unknown> {
  const dir = mkdtempSync(path.join(tmpdir(), "runcast-config-"));
  try {
    if (withFile) {
      mkdirSync(path.join(dir, ".auth"));
      writeFileSync(
        path.join(dir, ".auth", "session.json"),
        JSON.stringify({
          version: 1,
          savedAt: "2026-11-19T00:00:00.000Z",
          signIn: null,
          storageState: {
            cookies: [{ name: "sid", value: "s1", domain: "localhost", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }],
            origins: [{ origin: "http://localhost:3000", localStorage: [{ name: "token", value: "t1" }] }],
          },
          sessionStorage: [],
        }),
      );
    }
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("REC_")));
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { definePlaywrightConfig } = await import(${JSON.stringify(CONFIG)});
         const config = await definePlaywrightConfig({ dir: ${JSON.stringify(dir)}, name: "Demo", baseURL: "http://localhost:3000", localStorage: { theme: "dark" } });
         console.log(JSON.stringify(config.use));`,
      ],
      { env: { ...clean, REC_MODE: "test", REC_SESSION: "1" }, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return JSON.parse(out.trim().split("\n").at(-1)!) as Record<string, unknown>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("REC_SESSION=1 uses the saved session", () => {
  const state = useWithSession(true).storageState as {
    cookies: Array<{ name: string }>;
    origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
  };
  assert.deepEqual(state.cookies.map((c) => c.name), ["sid"]);
  const names = state.origins[0]!.localStorage.map((e) => e.name).sort();
  assert.deepEqual(names, ["theme", "token"]);
});

test("REC_SESSION=1 without a saved session says how to make one", () => {
  assert.throws(() => useWithSession(false), /No saved session\. Run `node .*session` first/);
});
