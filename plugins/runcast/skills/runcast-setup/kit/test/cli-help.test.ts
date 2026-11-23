// The CLI's help is its header comment, whole.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

test("help prints the whole header comment", () => {
  const out = execFileSync(process.execPath, [path.join(import.meta.dirname, "..", "cli.ts"), "help"], {
    encoding: "utf-8",
  });
  assert.match(out, /explore \[paths\]/);
  assert.match(out, /its \.kit link \(gitignored\) points at the runtime\.\s*$/);
});

test("commands run through a project's .kit link find that project", async () => {
  const { mkdtempSync, mkdirSync, rmSync, symlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const root = mkdtempSync(path.join(tmpdir(), "runcast-link-"));
  try {
    mkdirSync(path.join(root, "demos", "acme"), { recursive: true });
    symlinkSync(path.join(import.meta.dirname, ".."), path.join(root, "demos", "acme", ".kit"), "dir");
    const run = spawnSync(process.execPath, ["demos/acme/.kit/cli.ts", "session"], { cwd: root, encoding: "utf-8" });
    assert.match(`${run.stdout}${run.stderr}`, /node demos\/acme\/\.kit\/cli\.ts session --manual/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
