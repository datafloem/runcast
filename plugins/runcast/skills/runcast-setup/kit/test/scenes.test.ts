// Scenes added at render time: a take's placeholders get the scene's
// current length and beats before the time map is built.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyScenes } from "../scripts/video/scenes.ts";

const take = () => ({
  capture: {
    durationMs: 8000,
    pointer: [
      { t: 500, x: 1, y: 1, kind: "move" as const },
      { t: 3500, x: 2, y: 2, kind: "move" as const },
    ],
    focus: [{ t: 3600, until: 3700, kind: "click", x: 0, y: 0 }],
    navigations: [3800],
    spans: [
      { from: 200, to: 600, kind: "move" as const, outMs: 600 },
      { from: 1000, to: 3000, kind: "scene" as const, outMs: 2000, scene: "flow", in: "fade" as const, out: "cube" as const },
      { from: 3200, to: 3400, kind: "hold" as const, outMs: 900 },
    ],
    scenes: [
      {
        t: 1000,
        name: "flow",
        duration: 2000,
        beats: [{ id: "a", at: 0 }, { id: "b", at: 1000 }],
        in: "fade" as const,
        out: "cube" as const,
        hash: "old",
        step: "order-flow",
        title: "How an order flows",
      },
    ],
  },
  steps: [
    { id: "login", seconds: 0, startMs: 0, title: "1. Login" },
    { id: "order-flow", seconds: 1, startMs: 995, title: "2. How an order flows" },
    { id: "order-flow.a", seconds: 1, startMs: 1000, title: "How an order flows › a" },
    { id: "order-flow.b", seconds: 2, startMs: 2000, title: "How an order flows › b" },
    { id: "orders", seconds: 3, startMs: 3000, title: "3. Orders" },
  ],
});

test("a scene's current length moves everything after it", () => {
  const { capture, steps } = applyScenes(take().capture, take().steps, new Map([
    ["flow", { duration: 3500, beats: [{ id: "a", at: 0 }, { id: "c", at: 1500 }, { id: "d", at: 2500 }], startMs: 400 }],
  ]));
  const scene = capture.spans.find((s) => s.kind === "scene")! as { from: number; to: number; outMs: number; fileFrom?: number };
  assert.deepEqual([scene.from, scene.to, scene.outMs, scene.fileFrom], [1000, 4500, 3500, 400]);
  assert.equal(capture.durationMs, 9500);
  assert.deepEqual(capture.pointer.map((p) => p.t), [500, 5000]);
  assert.deepEqual([capture.focus[0]!.t, capture.focus[0]!.until], [5100, 5200]);
  assert.deepEqual(capture.navigations, [5300]);
  assert.deepEqual(capture.spans.at(-1)!.from, 4700);
  // Beats rebuilt from the scene as it is now; later steps moved.
  assert.deepEqual(
    steps.map((s) => [s.id, s.startMs]),
    [
      ["login", 0],
      ["order-flow", 995],
      ["order-flow.a", 1000],
      ["order-flow.c", 2500],
      ["order-flow.d", 3500],
      ["orders", 4500],
    ],
  );
});

test("a scene of the same length changes nothing but its file start", () => {
  const { capture, steps } = applyScenes(take().capture, take().steps, new Map([
    ["flow", { duration: 2000, beats: [{ id: "a", at: 0 }, { id: "b", at: 1000 }], startMs: 400 }],
  ]));
  assert.equal(capture.durationMs, 8000);
  assert.deepEqual(steps.map((s) => s.startMs), [0, 995, 1000, 2000, 3000]);
  assert.equal((capture.spans.find((s) => s.kind === "scene")! as { fileFrom?: number }).fileFrom, 400);
});
