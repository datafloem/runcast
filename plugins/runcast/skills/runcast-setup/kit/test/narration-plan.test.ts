// The narration plan's step lengths: from the newest video, else a rehearsal.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "narration.ts");

test("a video from before the time map gives way to the rehearsal", () => {
  const project = mkdtempSync(path.join(tmpdir(), "runcast-plan-"));
  const write = (file: string, data: unknown) => {
    mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    writeFileSync(path.join(project, file), typeof data === "string" ? data : JSON.stringify(data));
  };
  write("recording.config.ts", `export default { dir: import.meta.dirname, name: "Plan", baseURL: "http://localhost" };\n`);
  write("scenarios/demo.spec.ts", "// a scenario\n");
  write("scenarios/demo.narration.json", {
    language: "en",
    wordsPerMinute: 150,
    gapMs: 400,
    segments: [{ step: "orders", text: "Every order of the customer in one list." }],
  });
  // An older video: its steps were timed to their narration.
  write(".captures/demo/steps.json", {
    scenario: "demo",
    steps: [{ id: "orders", seconds: 0, narration: { ms: 4000 } }],
  });
  write(".captures/demo/capture/events.json", { durationMs: 5000 });
  // A rehearsal, older than the video.
  write(".results/demo-run/steps.json", {
    scenario: "demo",
    steps: [{ id: "orders", seconds: 0, durationMs: 3200 }],
  });
  const old = new Date(Date.now() - 60_000);
  utimesSync(path.join(project, ".results/demo-run/steps.json"), old, old);

  const out = execFileSync(process.execPath, [SCRIPT, "plan", "demo"], {
    env: { ...process.env, REC_PROJECT: project },
    encoding: "utf-8",
    cwd: project,
  });
  rmSync(project, { recursive: true, force: true });
  assert.match(out, /Step times: \.results\/demo-run\/steps\.json/);
  assert.match(out, /3\.2 s/);
});

test("the plan flags a step that leaves a long silence", () => {
  const project = mkdtempSync(path.join(tmpdir(), "runcast-plan-"));
  const write = (file: string, data: unknown) => {
    mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    writeFileSync(path.join(project, file), typeof data === "string" ? data : JSON.stringify(data));
  };
  write("recording.config.ts", `export default { dir: import.meta.dirname, name: "Plan", baseURL: "http://localhost" };\n`);
  write("scenarios/demo.spec.ts", "// a scenario\n");
  write("scenarios/demo.narration.json", {
    language: "en",
    wordsPerMinute: 150,
    gapMs: 400,
    segments: [{ step: "orders", text: "Every order in one list." }],
  });
  write(".results/demo-run/steps.json", { scenario: "demo", steps: [{ id: "orders", seconds: 0, durationMs: 12000 }] });
  const out = execFileSync(process.execPath, [SCRIPT, "plan", "demo"], {
    env: { ...process.env, REC_PROJECT: project },
    encoding: "utf-8",
    cwd: project,
  });
  rmSync(project, { recursive: true, force: true });
  assert.match(out, /long silence/i);
});
