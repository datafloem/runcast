import assert from "node:assert/strict";
import { test } from "node:test";
import { fitNarration, naturalMap, retimeCapture } from "../scripts/video/timemap.ts";

test("no spans is identity", () => {
  const m = naturalMap([], 1000);
  assert.equal(m.outMs, 1000);
  assert.equal(m.toRec(500), 500);
  assert.equal(m.toOut(500), 500);
});

test("toOut interpolates inside a stretched span", () => {
  const m = naturalMap([{ from: 100, to: 200, kind: "move", outMs: 300 }], 400);
  assert.equal(m.outMs, 600);
  assert.equal(m.toOut(150), 250);
  assert.equal(m.toRec(250), 150);
  assert.equal(m.toOut(200), 400);
  assert.equal(m.toRec(500), 300);
});

test("hold plays its head, then freezes", () => {
  const m = naturalMap(
    [{ from: 100, to: 400, kind: "hold", outMs: 1000 }],
    500,
  );
  assert.equal(m.outMs, 1200);
  assert.equal(m.toRec(300), 300);
  assert.equal(m.toRec(450), 400);
  assert.equal(m.toRec(1150), 450);
  assert.equal(m.toOut(400), 1100); // right-continuous: end of the freeze
});

test("hold no longer than recorded adds nothing", () => {
  const m = naturalMap([{ from: 0, to: 500, kind: "hold", outMs: 500 }], 800);
  assert.equal(m.outMs, 800);
});

test("off-camera cut skips file time", () => {
  const m = naturalMap(
    [{ from: 300, to: 300, kind: "cut", outMs: 0, skipMs: 2000 }],
    600,
  );
  assert.equal(m.outMs, 600);
  assert.equal(m.toRec(299), 299);
  assert.equal(m.toRec(300), 2300);
  assert.equal(m.toRec(500), 2500);
  assert.equal(m.toOut(300), 300);
  assert.deepEqual(m.cutsOut, [300]);
});

test("legacy cuts", () => {
  const m = naturalMap([], 600, [{ at: 300, ms: 2000 }]);
  assert.equal(m.toRec(500), 2500);
  assert.deepEqual(m.cutsOut, [300]);
});

const two = [
  { id: "a", startMs: 0 },
  { id: "b", startMs: 3000 },
];
const on = { compressWaits: true };

test("voice longer: freeze at the step's end", () => {
  const { map, report } = fitNarration(
    naturalMap([], 3000),
    [
      { id: "a", startMs: 0 },
      { id: "b", startMs: 1000 },
    ],
    new Map([["a", 1600]]),
    on,
  );
  assert.equal(map.outMs, 3600);
  assert.equal(map.toOut(1000), 1600);
  assert.deepEqual(report[0], {
    index: 0,
    id: "a",
    naturalMs: 1000,
    voiceMs: 1600,
    freezeMs: 600,
    shortenedMs: 0,
    silenceMs: 0,
  });
});

test("step longer: wait sped up", () => {
  const { map, report } = fitNarration(
    naturalMap([], 4000),
    two,
    new Map([["a", 1500]]),
    on,
  );
  assert.equal(map.toOut(3000), 1500);
  assert.equal(map.toRec(750), 1500);
  assert.equal(report[0]!.shortenedMs, 1500);
  assert.equal(report[0]!.silenceMs, 0);
});

test("step longer: wait's middle cut beyond 4x", () => {
  const { map } = fitNarration(
    naturalMap([], 4000),
    two,
    new Map([["a", 600]]),
    on,
  );
  assert.equal(map.toOut(3000), 600);
  assert.ok(map.cutsOut.includes(300));
  assert.equal(map.toRec(299), 299);
  assert.equal(map.toRec(301), 2701);
});

test("compression off leaves silence", () => {
  const { map, report } = fitNarration(
    naturalMap([], 4000),
    two,
    new Map([["a", 1500]]),
    { compressWaits: false },
  );
  assert.equal(map.toOut(3000), 3000);
  assert.equal(report[0]!.silenceMs, 1500);
  assert.equal(report[0]!.shortenedMs, 0);
});

test("spans are never shortened", () => {
  const spans = [{ from: 0, to: 300, kind: "hold" as const, outMs: 1500 }];
  const { report } = fitNarration(
    naturalMap(spans, 3000),
    [
      { id: "a", startMs: 0 },
      { id: "b", startMs: 2000 },
    ],
    new Map([["a", 2000]]),
    on,
  );
  assert.equal(report[0]!.naturalMs, 3200);
  assert.equal(report[0]!.shortenedMs, 1100);
  assert.equal(report[0]!.silenceMs, 100);
});

test("waits under 600 ms are untouched", () => {
  const { report } = fitNarration(
    naturalMap([], 1000),
    [
      { id: "a", startMs: 0 },
      { id: "b", startMs: 500 },
    ],
    new Map([["a", 100]]),
    on,
  );
  assert.equal(report[0]!.shortenedMs, 0);
  assert.equal(report[0]!.silenceMs, 400);
});

test("last step freezes at the end", () => {
  const { map } = fitNarration(
    naturalMap([], 1000),
    [{ id: "a", startMs: 0 }],
    new Map([["a", 1800]]),
    on,
  );
  assert.equal(map.outMs, 1800);
  assert.equal(map.toRec(1700), 1000);
});

test("freeze before a cut at the same time shows the pre-cut frame", () => {
  const cut = [
    { from: 1000, to: 1000, kind: "cut" as const, outMs: 0, skipMs: 5000 },
  ];
  const { map } = fitNarration(
    naturalMap(cut, 2000),
    [
      { id: "a", startMs: 0 },
      { id: "b", startMs: 1000 },
    ],
    new Map([["a", 1500]]),
    on,
  );
  assert.equal(map.toRec(1200), 1000);
  assert.equal(map.toRec(1600), 6100);
});

test("retimeCapture maps pointer, focus and navigations", () => {
  const map = naturalMap([{ from: 100, to: 200, kind: "move", outMs: 300 }], 400);
  const out = retimeCapture(map, {
    pointer: [{ t: 150, x: 1, y: 2 }],
    focus: [{ t: 100, until: 200, kind: "click" }],
    navigations: [300],
  });
  assert.deepEqual(out.pointer, [{ t: 250, x: 1, y: 2 }]);
  assert.deepEqual(out.focus, [{ t: 100, until: 400, kind: "click" }]);
  assert.deepEqual(out.navigations, [500]);
});

test("freeze before an off-camera cut whose next step starts just after it", () => {
  // The recorder marks the next step a moment after the cut, and steps.json
  // rounds it to 0.1 s: 1260 -> 1300.
  const cut = [
    { from: 1260, to: 1260, kind: "cut" as const, outMs: 0, skipMs: 5000 },
  ];
  const { map } = fitNarration(
    naturalMap(cut, 2000),
    [
      { id: "a", startMs: 0 },
      { id: "b", startMs: 1300 },
    ],
    new Map([["a", 2500]]),
    { compressWaits: true },
  );
  assert.ok(map.toRec(2000) <= 1260, `froze file time ${map.toRec(2000)}`);
});

test("freeze before an off-camera cut whose next step was rounded down", () => {
  const cut = [
    { from: 1240, to: 1240, kind: "cut" as const, outMs: 0, skipMs: 5000 },
  ];
  const { map } = fitNarration(
    naturalMap(cut, 2000),
    [
      { id: "a", startMs: 0 },
      { id: "b", startMs: 1200 },
    ],
    new Map([["a", 2500]]),
    { compressWaits: true },
  );
  assert.ok(map.toRec(2000) <= 1240, `froze file time ${map.toRec(2000)}`);
  let last = -Infinity;
  for (let t = 0; t <= map.outMs; t += 10) {
    assert.ok(map.toRec(t) >= last, `toRec went back at ${t}`);
    last = map.toRec(t);
  }
});
