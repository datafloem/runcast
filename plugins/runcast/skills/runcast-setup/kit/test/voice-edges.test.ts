// Voice-over clip edges: the stray start of the next text that ElevenLabs
// sometimes leaves at a clip's end is cut, and every clip fades in and out
// so it never starts or stops with a click.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { clipEndMs, strayTailMs, voiceClipFilter } from "../scripts/video/voice-edges.ts";

const LOUD = 8000;
const BREATH = 20;

/** 10 ms levels: `ms` of each level in turn. */
function levels(...parts: Array<[number, number]>): Array<number> {
  return parts.flatMap(([level, ms]) => Array.from({ length: ms / 10 }, () => level));
}

test("a short sound after a pause, cut off by the end of the clip, is left out", () => {
  const clip = levels([LOUD, 2000], [BREATH, 500], [LOUD, 30]);
  // Speech ends at 2000 ms; 80 ms of the quiet after it stays.
  assert.equal(strayTailMs(clip), 2080);
});

test("a clip that ends in quiet keeps all of it", () => {
  assert.equal(strayTailMs(levels([LOUD, 2000], [BREATH, 500])), null);
});

test("speech that runs to the end of the clip is not cut", () => {
  // A last word right after a short breath, no pause before it.
  assert.equal(strayTailMs(levels([LOUD, 2000], [BREATH, 100], [LOUD, 60])), null);
  // A long last sound after a pause is speech, not a stray start.
  assert.equal(strayTailMs(levels([LOUD, 2000], [BREATH, 500], [LOUD, 600])), null);
});

test("a stray start with a dip inside it is still one sound", () => {
  const clip = levels([LOUD, 2000], [BREATH, 500], [LOUD, 30], [BREATH, 20], [LOUD, 30]);
  assert.equal(strayTailMs(clip), 2080);
});

function ffmpeg(args: Array<string>): string {
  return execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", ...args], { encoding: "utf-8" });
}

/** A clip: 1 s of tone, 0.5 s of silence, then 40 ms of tone up to the end. */
function clipWithStrayTail(dir: string): string {
  const file = path.join(dir, "clip.wav");
  ffmpeg([
    "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=44100:duration=1",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=0.5",
    "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=44100:duration=0.04",
    "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1", "-ac", "1", file,
  ]);
  return file;
}

test("clipEndMs reads where a clip file should end", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voice-edges-"));
  try {
    const end = clipEndMs(clipWithStrayTail(dir));
    assert.ok(Math.abs(end - 1080) <= 10, `end ${end} ms`);
    const clean = path.join(dir, "clean.wav");
    ffmpeg(["-f", "lavfi", "-i", "sine=frequency=300:sample_rate=44100:duration=1.2", clean]);
    assert.ok(Math.abs(clipEndMs(clean) - 1200) <= 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Peak level (dB) of the filter's output over [fromS, toS] (silence reads about -91). */
function peakDb(file: string, filter: string, fromS: number, toS: number): number {
  const run = spawnSync(
    "ffmpeg",
    [
      "-hide_banner", "-i", file, "-filter_complex",
      `${filter};[v]apad=whole_dur=3,atrim=start=${fromS}:end=${toS},volumedetect`, "-f", "null", "-",
    ],
    { encoding: "utf-8" },
  );
  const match = /max_volume: (-?[\d.]+|-inf) dB/.exec(run.stderr);
  assert.ok(match, run.stderr);
  return match[1] === "-inf" ? Number.NEGATIVE_INFINITY : Number(match[1]);
}

test("the clip filter plays up to the end, fades both edges and leaves out the stray start", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voice-edges-"));
  try {
    const file = clipWithStrayTail(dir);
    const filter = voiceClipFilter({ at: 500, endMs: 1080 }, 0, "v");
    const level = (from: number, to: number) => peakDb(file, filter, from, to);
    // Placed at 0.5 s: silence before it.
    assert.ok(level(0, 0.49) < -80, "silent before");
    // The tone plays, quieter in its first 2 ms (fading in) than in the middle.
    const middle = level(0.9, 1.0);
    assert.ok(middle > -25, `middle ${middle} dB`);
    assert.ok(level(0.5, 0.502) < middle - 6, "fades in");
    // The stray start (at 1.5 s of the clip, 2.0 s placed) is gone.
    assert.ok(level(1.6, 2.2) < -80, "stray start left out");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a clip that started before the video is trimmed at its start", () => {
  const filter = voiceClipFilter({ at: -300, endMs: 1080 }, 2, "a0");
  assert.match(filter, /^\[2:a\]atrim=start=0\.300:end=1\.080/);
  assert.doesNotMatch(filter, /adelay/);
  assert.match(filter, /\[a0\]$/);
});

test("narration measure stores the length the render plays", () => {
  const project = mkdtempSync(path.join(os.tmpdir(), "voice-edges-"));
  try {
    const write = (file: string, text: string) => {
      mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
      writeFileSync(path.join(project, file), text);
    };
    write("recording.config.ts", `export default { dir: import.meta.dirname, name: "Edges", baseURL: "http://localhost" };\n`);
    write("scenarios/demo.spec.ts", "// a scenario\n");
    write(
      "scenarios/demo.narration.json",
      JSON.stringify({ language: "en", wordsPerMinute: 150, gapMs: 400, segments: [{ step: "orders", text: "Every order." }] }),
    );
    mkdirSync(path.join(project, "narration", "demo"), { recursive: true });
    renameSync(clipWithStrayTail(project), path.join(project, "narration", "demo", "01-orders.wav"));
    execFileSync(process.execPath, [path.join(import.meta.dirname, "..", "scripts", "narration.ts"), "measure", "demo"], {
      env: { ...process.env, REC_PROJECT: project },
      cwd: project,
      stdio: "ignore",
    });
    const script = JSON.parse(readFileSync(path.join(project, "scenarios", "demo.narration.json"), "utf-8"));
    const ms = script.segments[0].durationMs as number;
    assert.ok(Math.abs(ms - 1080) <= 10, `durationMs ${ms}`);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
