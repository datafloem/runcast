// Settings read from the environment when core/mode.ts loads: each case in a fresh Node.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

const MODE = path.join(import.meta.dirname, "..", "core", "mode.ts");
const FORMAT = path.join(import.meta.dirname, "..", "core", "format.ts");

function settingsWith(env: Record<string, string>): {
  capture: string;
  scale: number;
  headless: boolean;
  pageSize: { width: number; height: number };
} {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("REC_")),
  );
  const out = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(MODE)});
       console.log(JSON.stringify({ capture: m.settings.capture, scale: m.settings.scale,
         headless: m.settings.headless, pageSize: m.pageSize }));`,
    ],
    { env: { ...clean, ...env }, encoding: "utf-8" },
  );
  return JSON.parse(out);
}

test("video mode records a headless tab at 1440x810, scale 2, by default", () => {
  const s = settingsWith({ REC_MODE: "video" });
  assert.equal(s.capture, "tab");
  assert.equal(s.scale, 2);
  assert.equal(s.headless, true);
  assert.deepEqual(s.pageSize, { width: 1440, height: 810 });
});

test("REC_CAPTURE=screen keeps a visible window", () => {
  const s = settingsWith({ REC_MODE: "video", REC_CAPTURE: "screen" });
  assert.equal(s.capture, "screen");
  assert.equal(s.headless, false);
});

test("REC_PAGE_SIZE and REC_SCALE set the tab's page", () => {
  const s = settingsWith({ REC_MODE: "video", REC_PAGE_SIZE: "1280x720", REC_SCALE: "1" });
  assert.deepEqual(s.pageSize, { width: 1280, height: 720 });
  assert.equal(s.scale, 1);
});

test("vertical pages are 540x960", async () => {
  const { VERTICAL_PAGE } = (await import(FORMAT)) as {
    VERTICAL_PAGE: { width: number; height: number };
  };
  assert.deepEqual(VERTICAL_PAGE, { width: 540, height: 960 });
});

test("app audio: off by default, scenario levels with defaults, REC_APP_AUDIO overrides", async () => {
  const { resolveAppAudio } = (await import(MODE)) as {
    resolveAppAudio(
      own: { volume?: number; duckTo?: number } | undefined,
      setting: string | undefined,
    ): { volume: number; duckTo: number } | null;
  };
  assert.equal(resolveAppAudio(undefined, undefined), null);
  assert.deepEqual(resolveAppAudio({}, undefined), { volume: 1, duckTo: 0.3 });
  assert.deepEqual(resolveAppAudio({ volume: 0.6 }, undefined), { volume: 0.6, duckTo: 0.3 });
  assert.equal(resolveAppAudio({ volume: 0.6 }, "0"), null);
  assert.deepEqual(resolveAppAudio(undefined, "1"), { volume: 1, duckTo: 0.3 });
  assert.deepEqual(resolveAppAudio({ volume: 7, duckTo: -1 }, undefined), { volume: 1, duckTo: 0 });
});
