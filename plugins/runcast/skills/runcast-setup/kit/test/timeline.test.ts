import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actionsOutOfFrame,
  baseView,
  buildCameraTrack,
  type Focus,
  SOURCE_TRANSITION_MS,
  sourceTransitionAt,
} from "../scripts/video/timeline.ts";

const viewport = { width: 1600, height: 900 };
const click = (t: number, x: number): Focus => ({
  t,
  until: t + 100,
  kind: "click",
  x,
  y: 450,
  box: { x: x - 20, y: 440, width: 40, height: 20 },
});

test("a single action is in frame", () => {
  const focus = [click(1000, 800)];
  const view = baseView(viewport, 9 / 16);
  const track = buildCameraTrack(focus, viewport, undefined, [], view);
  assert.deepEqual(actionsOutOfFrame(focus, track, viewport, view), []);
});

test("a vertical crop cannot show two actions far apart in one scene", () => {
  const focus = [click(1000, 100), click(1500, 1500)];
  const view = baseView(viewport, 9 / 16);
  const track = buildCameraTrack(focus, viewport, undefined, [], view);
  const missed = actionsOutOfFrame(focus, track, viewport, view);
  assert.ok(missed.length >= 1, "expected an action out of frame");
});

test("the whole page in view frames everything", () => {
  const focus = [click(1000, 100), click(1500, 1500)];
  const track = buildCameraTrack(focus, viewport);
  assert.deepEqual(actionsOutOfFrame(focus, track, viewport, viewport), []);
});

test("a tab switch plays its transition right after the switch", () => {
  const switches = [
    { at: 1000, from: "app" as const, to: "stage" as const, transition: "fade" as const },
    { at: 3000, from: "stage" as const, to: "app" as const, transition: "lift" as const },
    { at: 5000, from: "app" as const, to: "stage" as const, transition: "cut" as const },
  ];
  assert.equal(SOURCE_TRANSITION_MS.lift, 450);
  assert.equal(sourceTransitionAt(switches, 999), null);
  assert.deepEqual(sourceTransitionAt(switches, 1250), {
    at: 1000,
    from: "app",
    to: "stage",
    kind: "fade",
    p: 250 / SOURCE_TRANSITION_MS.fade,
  });
  assert.equal(sourceTransitionAt(switches, 3000)?.p, 0);
  assert.equal(sourceTransitionAt(switches, 3000 + 450), null);
  assert.equal(sourceTransitionAt(switches, 5000), null); // a cut takes no time
});
