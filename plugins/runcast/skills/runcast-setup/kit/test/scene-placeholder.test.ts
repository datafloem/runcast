// Scenes added at render time: what a scene step leaves in a take.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "@playwright/test";
import { sceneHash } from "../core/scene-contract.ts";

process.env.REC_MODE = "rehearsal";
const { Recorder } = await import("../core/recorder.ts");
const { scene } = await import("../core/scene.ts");

const EXAMPLE = path.resolve(import.meta.dirname, "..", "..", "..", "runcast-scene", "example");

let browser: Browser;
let project: string;
before(async () => {
  browser = await chromium.launch({ channel: process.env.REC_CHANNEL === "chromium" ? undefined : "chrome" });
  project = mkdtempSync(path.join(tmpdir(), "runcast-placeholder-"));
  writeFileSync(path.join(project, "recording.config.ts"), `export default { dir: import.meta.dirname, name: "Demo", baseURL: "http://localhost" };\n`);
  mkdirSync(path.join(project, "scenes"), { recursive: true });
  cpSync(EXAMPLE, path.join(project, "scenes", "flow"), { recursive: true });
});
after(async () => {
  await browser.close();
  rmSync(project, { recursive: true, force: true });
});

test("the scene's hash follows its files", () => {
  const dir = path.join(project, "scenes", "flow");
  const first = sceneHash(dir);
  assert.equal(sceneHash(dir), first);
  writeFileSync(path.join(dir, "note.txt"), "one more file");
  assert.notEqual(sceneHash(dir), first);
  rmSync(path.join(dir, "note.txt"));
  assert.equal(sceneHash(dir), first);
});

test("a scene step marks its beats in no wall time and opens no stage", async () => {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  const info = {
    file: path.join(project, "scenarios", "demo.spec.ts"),
    outputPath: (name: string) => path.join(project, name),
  };
  const rec = new Recorder(page, info as never);
  await rec.start();
  const step = scene({ id: "order-flow", name: "flow", title: "How an order flows" });
  const startedAt = Date.now();
  const elapsed = rec.elapsedMs();
  await step.run({ page, rec, state: {} });
  const wall = Date.now() - startedAt;
  // The example scene lasts 5.6 s; the step spends only the contract check.
  assert.ok(wall < 4000, `took ${wall} ms`);
  assert.ok(rec.elapsedMs() - elapsed >= 5600, `clock moved ${rec.elapsedMs() - elapsed} ms`);
  assert.deepEqual(
    context.pages().map((p) => p === page),
    [true],
  );
  await rec.finish();
  const steps = (JSON.parse((await import("node:fs")).readFileSync(path.join(project, "steps.json"), "utf-8")) as {
    steps: Array<{ id: string; startMs: number }>;
  }).steps;
  const beats = steps.filter((s) => s.id.startsWith("order-flow."));
  assert.deepEqual(beats.map((s) => s.id), ["order-flow.customer", "order-flow.order", "order-flow.invoice"]);
  assert.deepEqual(
    beats.map((s) => s.startMs - beats[0]!.startMs),
    [0, 1800, 3600],
  );
  await context.close();
});

test("a live scene still plays on the stage in real time", async () => {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  const info = {
    file: path.join(project, "scenarios", "live.spec.ts"),
    outputPath: (name: string) => path.join(project, name),
  };
  const rec = new Recorder(page, info as never);
  await rec.start();
  const step = scene({ id: "order-flow", name: "flow", title: "How an order flows", live: true, back: "cut" });
  const startedAt = Date.now();
  await step.run({ page, rec, state: {} });
  const wall = Date.now() - startedAt;
  // Played, not left for rendering: the step takes the scene's 5.6 s.
  assert.ok(wall >= 5600, `took ${wall} ms`);
  // The stage page showed the scene.
  const stage = context.pages().find((p) => p !== page);
  assert.ok(stage, "no stage page");
  assert.match(stage.url(), /scenes\/flow\/index\.html\?record$/);
  await rec.finish();
  const steps = (JSON.parse((await import("node:fs")).readFileSync(path.join(project, "steps.json"), "utf-8")) as {
    steps: Array<{ id: string; startMs: number }>;
  }).steps;
  const beats = steps.filter((s) => s.id.startsWith("order-flow."));
  assert.deepEqual(beats.map((s) => s.id), ["order-flow.customer", "order-flow.order", "order-flow.invoice"]);
  const gaps = beats.map((s) => s.startMs - beats[0]!.startMs);
  for (const [i, want] of [0, 1800, 3600].entries()) {
    assert.ok(Math.abs(gaps[i]! - want) < 400, `beat ${i} at ${gaps[i]} ms, want ${want}`);
  }
  await context.close();
});
