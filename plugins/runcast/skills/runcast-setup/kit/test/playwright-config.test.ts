// The Playwright config every project uses, per mode.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
