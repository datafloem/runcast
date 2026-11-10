import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { captureRootFor, findCaptures } from "../core/project.ts";

/** A capture folder with an events.json, last changed `secondsAgo`. */
function capture(dir: string, secondsAgo: number): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "events.json"), "{}");
  const when = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(dir, when, when);
  return dir;
}

test("captureRootFor keeps one folder per scenario outside .results", () => {
  assert.equal(
    captureRootFor("/app/tests/recording", "orders"),
    path.join("/app/tests/recording", ".captures", "orders"),
  );
});

test("findCaptures lists .captures and older .results captures, newest first", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "runcast-"));
  const old = capture(path.join(dir, ".results", "orders-orders", "capture"), 30);
  const customers = capture(path.join(dir, ".captures", "customers", "capture"), 20);
  const orders = capture(path.join(dir, ".captures", "orders", "capture"), 10);
  mkdirSync(path.join(dir, ".captures", "empty", "capture"), { recursive: true });
  assert.deepEqual(findCaptures(dir), [orders, customers, old]);
  rmSync(dir, { recursive: true, force: true });
});

test("findCaptures without any output folder is empty", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "runcast-"));
  assert.deepEqual(findCaptures(dir), []);
  rmSync(dir, { recursive: true, force: true });
});
