// The event log both captures (screen and tab) write into.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CaptureLog } from "../core/capture-log.ts";

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

test("a span logged while paused is dropped", () => {
  const log = new CaptureLog("demo");
  log.pause();
  log.span("move", 0, 100, 300);
  assert.equal(log.data.spans.length, 0);
});

test("resume logs a cut span with skipMs of the paused time", async () => {
  const log = new CaptureLog("demo");
  log.pause();
  await wait(50);
  log.resume();
  assert.equal(log.data.spans.length, 1);
  const [cut] = log.data.spans;
  assert.equal(cut?.kind, "cut");
  assert.ok((cut?.skipMs ?? 0) >= 50, `skipMs ${cut?.skipMs}`);
  assert.equal(cut?.from, cut?.to);
});

test("write puts events.json in the folder", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "runcast-log-"));
  const log = new CaptureLog("demo");
  log.span("hold", 0, 10, 500);
  const file = log.write(dir);
  assert.equal(file, path.join(dir, "events.json"));
  const data = JSON.parse(readFileSync(file, "utf-8")) as { spans: unknown[]; scenario: string };
  assert.equal(data.scenario, "demo");
  assert.equal(data.spans.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("a dialog logs itself and a 1.5 s held frame", () => {
  const log = new CaptureLog("demo");
  log.dialog("confirm", "Delete this order?", true);
  assert.equal(log.data.dialogs?.length, 1);
  assert.deepEqual(
    { ...log.data.dialogs![0], t: 0 },
    { t: 0, type: "confirm", message: "Delete this order?", accepted: true },
  );
  const [span] = log.data.spans;
  assert.equal(span?.kind, "dialog");
  assert.equal(span?.outMs, 1500);
  assert.equal(span?.from, span?.to);
});

test("dialogs off camera add no freeze", () => {
  const log = new CaptureLog("demo");
  log.pause();
  log.dialog("alert", "Saved", true);
  assert.equal(log.data.dialogs?.length ?? 0, 0);
  assert.equal(log.data.spans.length, 0);
});
