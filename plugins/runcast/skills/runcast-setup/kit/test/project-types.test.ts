// A project made from the template type-checks against the kit as it is:
// tsc follows its imports into .kit, with the project's own compiler options.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const KIT = path.resolve(import.meta.dirname, "..");

test("the template's tsconfig type-checks a project that uses the kit", () => {
  const project = mkdtempSync(path.join(tmpdir(), "runcast-types-"));
  try {
    symlinkSync(KIT, path.join(project, ".kit"), "dir");
    const tsconfig = readFileSync(path.join(KIT, "templates", "project", "tsconfig.json.tmpl"), "utf-8");
    writeFileSync(path.join(project, "tsconfig.json"), tsconfig);
    writeFileSync(
      path.join(project, "uses-kit.ts"),
      `import { scenario, test, type StepOptions } from "./.kit/core/index.ts";\n` +
        `const options: StepOptions = { note: "Orders" };\n` +
        `test("orders", scenario({ steps: [], captions: Boolean(options.note) }));\n`,
    );
    // RUNCAST_TSC: another compiler to check with, e.g. TypeScript 5, whose
    // lib "DOM" has no iterable DOM collections (TypeScript 6+ merged them).
    const tsc = process.env.RUNCAST_TSC ?? path.join(KIT, "node_modules", "typescript", "bin", "tsc");
    const run = spawnSync(
      process.execPath,
      [tsc, "-p", project, "--noEmit"],
      { encoding: "utf-8" },
    );
    assert.equal(run.status, 0, run.stdout + run.stderr);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
