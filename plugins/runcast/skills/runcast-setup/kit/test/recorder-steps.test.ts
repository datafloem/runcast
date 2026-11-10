// Step marks a rehearsal writes to steps.json.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.REC_MODE = "rehearsal";
process.env.REC_END_HOLD_MS = "0";
const { Recorder } = await import("../core/recorder.ts");

test("steps.json keeps each step's exact start in ms", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "runcast-steps-"));
  const info = {
    file: path.join(dir, "scenarios", "demo.spec.ts"),
    outputPath: (name: string) => path.join(dir, name),
  };
  const page = { viewportSize: () => ({ width: 800, height: 600 }), mouse: { move: async () => {} } };
  const rec = new Recorder(page as never, info as never);
  await rec.start();
  await new Promise((done) => setTimeout(done, 137));
  await rec.step("First", undefined, { id: "first" });
  await new Promise((done) => setTimeout(done, 61));
  await rec.step("Second", undefined, { id: "second" });
  await rec.finish();
  const steps = (JSON.parse(readFileSync(path.join(dir, "steps.json"), "utf-8")) as {
    steps: Array<{ seconds: number; startMs?: number }>;
  }).steps;
  for (const step of steps) {
    assert.ok(Number.isInteger(step.startMs), `startMs ${step.startMs}`);
    assert.ok(Math.abs(step.startMs! - step.seconds * 1000) <= 50);
  }
  assert.ok(steps[1]!.startMs! - steps[0]!.startMs! >= 60);
  rmSync(dir, { recursive: true, force: true });
});

test("videoElapsedMs counts what the video adds to a fast recording", async () => {
  const { CaptureLog } = await import("../core/capture-log.ts");
  const page = { viewportSize: () => ({ width: 800, height: 600 }), mouse: { move: async () => {} } };
  const rec = new Recorder(page as never, { file: "/demo/scenarios/demo.spec.ts" } as never);
  await rec.start();
  const log = new CaptureLog("demo");
  (rec as unknown as { capture: unknown }).capture = log;
  log.span("hold", 0, 300, 1500);
  assert.ok(rec.videoElapsedMs() - rec.elapsedMs() >= 1199);
});

test("step() still takes the old narration option and ignores it", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "runcast-steps-"));
  const info = { file: path.join(dir, "scenarios", "demo.spec.ts"), outputPath: (name: string) => path.join(dir, name) };
  const page = { viewportSize: () => ({ width: 800, height: 600 }), mouse: { move: async () => {} } };
  const rec = new Recorder(page as never, info as never);
  await rec.start();
  await rec.step("Orders", undefined, {
    id: "orders",
    narration: { text: "Every order.", audio: null, durationMs: 1200, measured: false },
  });
  await rec.finish();
  const [mark] = (JSON.parse(readFileSync(path.join(dir, "steps.json"), "utf-8")) as {
    steps: Array<Record<string, unknown>>;
  }).steps;
  assert.equal(mark?.id, "orders");
  assert.equal("narration" in mark!, false);
  rmSync(dir, { recursive: true, force: true });
});
