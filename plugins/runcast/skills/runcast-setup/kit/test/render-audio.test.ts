// The app's sound in the render: the ffmpeg filter built from the audio plan.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { appAudioFilter, shiftPlan } from "../scripts/video/audio.ts";

const plan = [
  { fileFrom: 0, fileTo: 400, outFrom: 0, fadeIn: false, fadeOut: true },
  { fileFrom: 400, fileTo: 500, outFrom: 1100, fadeIn: true, fadeOut: true },
  { fileFrom: 2300, fileTo: 3000, outFrom: 1200, fadeIn: true, fadeOut: false },
];

test("filter has one atrim per piece with fades", () => {
  const filter = appAudioFilter(plan, [], { volume: 1, duckTo: 0.3, inputIndex: 1, outLabel: "app" });
  assert.equal(filter.match(/atrim=/g)?.length, 3);
  assert.equal(filter.match(/afade=t=in/g)?.length, 2);
  assert.equal(filter.match(/afade=t=out/g)?.length, 2);
  assert.match(filter, /^\[1:a\]/);
  assert.match(filter, /atrim=start=2\.300:end=3\.000/);
  assert.match(filter, /adelay=1200:all=1/);
  assert.match(filter, /\[app\]$/);
});

test("a --steps range trims the plan like the clips", () => {
  assert.deepEqual(shiftPlan(plan, 1150), [
    { fileFrom: 450, fileTo: 500, outFrom: 0, fadeIn: false, fadeOut: true },
    { fileFrom: 2300, fileTo: 3000, outFrom: 50, fadeIn: true, fadeOut: false },
  ]);
});

/** Mean level (dB) of a mono 1 s tone run through the filter, measured over [fromS, toS]. */
function levelDb(filter: string, fromS: number, toS: number): number {
  const out = execFileSync(
    "sh",
    [
      "-c",
      `ffmpeg -hide_banner -f lavfi -i "anullsrc=r=48000:cl=mono:d=0.1" -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=6" \
        -filter_complex "$1;[app]atrim=start=${fromS}:end=${toS},volumedetect" -f null - 2>&1`,
      "sh",
      filter,
    ],
    { encoding: "utf-8" },
  );
  return Number(/mean_volume: (-?[\d.]+) dB/.exec(out)?.[1]);
}

test("duck envelope covers every clip", () => {
  const whole = [{ fileFrom: 0, fileTo: 6000, outFrom: 0, fadeIn: false, fadeOut: false }];
  const clips = [
    { at: 1000, ms: 1000 },
    { at: 3500, ms: 1000 },
  ];
  const filter = appAudioFilter(whole, clips, { volume: 1, duckTo: 0.3, inputIndex: 1, outLabel: "app" });
  const full = levelDb(filter, 0.1, 0.7);
  const duckedA = levelDb(filter, 1.1, 1.9);
  const between = levelDb(filter, 2.5, 3.2);
  const duckedB = levelDb(filter, 3.6, 4.4);
  // 0.3 of the level is about -10.5 dB.
  for (const ducked of [duckedA, duckedB]) {
    assert.ok(Math.abs(full - ducked - 10.5) < 1, `full ${full}, ducked ${ducked}`);
  }
  assert.ok(Math.abs(full - between) < 0.5, `full ${full}, between ${between}`);
});

test("a voice clip at the very start still leaves the sound after it", () => {
  // Its duck ramp starts before 0 s: the expression must not break on a negative time.
  const whole = [{ fileFrom: 0, fileTo: 6000, outFrom: 0, fadeIn: false, fadeOut: false }];
  const filter = appAudioFilter(whole, [{ at: 0, ms: 1000 }], {
    volume: 1,
    duckTo: 0.3,
    inputIndex: 1,
    outLabel: "app",
  });
  const after = levelDb(filter, 2.0, 2.8);
  const during = levelDb(filter, 0.2, 0.8);
  assert.ok(Number.isFinite(after) && Number.isFinite(during), `after ${after} dB, during ${during} dB`);
  assert.ok(Math.abs(after - during - 10.5) < 1, `after ${after}, during ${during}`);
});

test("pieces after the first keep their sound once mixed", () => {
  // Several pieces are mixed; the level that follows needs the mix's time.
  const plan = [
    { fileFrom: 0, fileTo: 1500, outFrom: 0, fadeIn: false, fadeOut: true },
    { fileFrom: 1500, fileTo: 3000, outFrom: 2500, fadeIn: true, fadeOut: true },
    { fileFrom: 3000, fileTo: 5000, outFrom: 4500, fadeIn: true, fadeOut: false },
  ];
  const filter = appAudioFilter(plan, [{ at: 0, ms: 800 }, { at: 3000, ms: 500 }], {
    volume: 1,
    duckTo: 0.3,
    inputIndex: 1,
    outLabel: "app",
  });
  const first = levelDb(filter, 1.0, 1.3);
  const later = levelDb(filter, 5.0, 6.0);
  assert.ok(Number.isFinite(later), `later piece ${later} dB`);
  assert.ok(Math.abs(first - later) < 1, `first ${first} dB, later ${later} dB`);
});
