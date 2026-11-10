// doctor's hints for projects updating from screen capture and old skill names.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const CLI = path.join(import.meta.dirname, "..", "cli.ts");

test("doctor names the old screen page size and stale skill names", () => {
  const project = mkdtempSync(path.join(tmpdir(), "runcast-doctor-"));
  try {
    writeFileSync(path.join(project, "recording.config.ts"), "export default {};\n");
    mkdirSync(path.join(project, ".captures", "orders", "capture"), { recursive: true });
    writeFileSync(
      path.join(project, ".captures", "orders", "capture", "events.json"),
      JSON.stringify({ viewport: { width: 1800, height: 993 }, scale: 2, video: { file: "screen.mkv" } }),
    );
    writeFileSync(
      path.join(project, "AGENTS.md"),
      "Read [`recording-scenario`](.kit/skills/recording-scenario/SKILL.md) first.\n",
    );
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("REC_")));
    const out = execFileSync(process.execPath, [CLI, "doctor", "--dir", project], {
      encoding: "utf-8",
      env: clean,
    });
    assert.match(out, /REC_PAGE_WIDTH=1800/);
    assert.match(out, /REC_SCALE=2/);
    assert.match(out, /AGENTS\.md.*recording-/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
