// The recorded cursor: what it logs for the time map.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CaptureLog } from "../core/capture-log.ts";
import { VirtualMouse } from "../core/virtual-mouse.ts";

/** A page whose mouse moves take a few ms each, like CDP round trips. */
const slowPage = {
  mouse: {
    move: () => new Promise<void>((done) => setTimeout(done, 4)),
    down: async () => {},
    up: async () => {},
  },
} as never;

test("at natural pace a move lasts in the video as long as it took", async () => {
  const log = new CaptureLog("demo");
  const mouse = new VirtualMouse(slowPage, log as never, { x: 0, y: 0 }, false);
  await mouse.moveTo({ x: 400, y: 0 }, 300);
  const [move] = log.data.spans;
  assert.equal(move?.kind, "move");
  assert.ok(move!.to - move!.from > 300, `took ${move!.to - move!.from} ms`);
  assert.equal(move!.outMs, move!.to - move!.from);
});

test("recording fast a move keeps its natural length", async () => {
  const log = new CaptureLog("demo");
  const mouse = new VirtualMouse(slowPage, log as never, { x: 0, y: 0 }, true);
  await mouse.moveTo({ x: 400, y: 0 }, 300);
  assert.equal(log.data.spans[0]?.outMs, 300);
});

test("the stage cursor's type comes from the kit's public API", async () => {
  // A helper can type rec.onStage's callback with it.
  type FromIndex = import("../core/index.ts").VirtualMouse;
  const mouse: FromIndex = new VirtualMouse(slowPage, null, { x: 0, y: 0 }, true);
  assert.deepEqual(mouse.at, { x: 0, y: 0 });
});
