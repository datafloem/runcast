// Pruning old runtimes never removes one that a project's .kit still links to.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pruneRuntimes, registerLink } from "../core/runtimes.ts";

function makeRuntime(home: string, name: string, ageS: number): string {
  const dir = path.join(home, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, ".runtime.json"), "{}");
  const t = Date.now() / 1000 - ageS;
  utimesSync(path.join(dir, ".runtime.json"), t, t);
  return dir;
}

function linkProject(root: string, name: string, runtime: string): string {
  const folder = path.join(root, name);
  mkdirSync(folder, { recursive: true });
  const kit = path.join(folder, ".kit");
  symlinkSync(runtime, kit, process.platform === "win32" ? "junction" : "dir");
  registerLink(runtime, kit);
  return kit;
}

test("pruning keeps an old runtime that another project still links to", () => {
  const root = mkdtempSync(path.join(tmpdir(), "runcast-runtimes-"));
  try {
    const home = path.join(root, "cache");
    const linked = makeRuntime(home, "0.2.0-old", 500);
    const unlinked = makeRuntime(home, "0.2.0-older", 400);
    makeRuntime(home, "0.2.0-b", 300);
    makeRuntime(home, "0.2.0-c", 200);
    const current = makeRuntime(home, "0.2.0-new", 0);
    linkProject(root, "customers-app", linked);
    pruneRuntimes(home, current, 3);
    assert.ok(existsSync(linked), "a linked runtime survives");
    assert.ok(!existsSync(unlinked), "an old unlinked runtime goes");
    assert.ok(existsSync(current));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a runtime whose projects moved on or were deleted is pruned", () => {
  const root = mkdtempSync(path.join(tmpdir(), "runcast-runtimes-"));
  try {
    const home = path.join(root, "cache");
    const old = makeRuntime(home, "0.2.0-old", 500);
    makeRuntime(home, "0.2.0-b", 300);
    makeRuntime(home, "0.2.0-c", 200);
    const current = makeRuntime(home, "0.2.0-new", 0);
    const moved = linkProject(root, "orders-app", old);
    const gone = linkProject(root, "gone-app", old);
    rmSync(moved);
    symlinkSync(current, moved, process.platform === "win32" ? "junction" : "dir");
    rmSync(path.dirname(gone), { recursive: true });
    pruneRuntimes(home, current, 3);
    assert.ok(!existsSync(old));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registerLink records each link once", () => {
  const root = mkdtempSync(path.join(tmpdir(), "runcast-runtimes-"));
  try {
    const runtime = makeRuntime(path.join(root, "cache"), "0.2.0-a", 0);
    const kit = linkProject(root, "customers-app", runtime);
    registerLink(runtime, kit);
    const links = JSON.parse(
      readFileSync(path.join(runtime, ".links.json"), "utf-8"),
    );
    assert.deepEqual(links, [path.resolve(kit)]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
