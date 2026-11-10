// The Recorder in test mode (the default): never on camera, even after start().
import assert from "node:assert/strict";
import { test } from "node:test";

delete process.env.REC_MODE;
const { Recorder } = await import("../core/recorder.ts");

test("test mode is never on camera", async () => {
  const rec = new Recorder({} as never, { file: "/demo/scenarios/demo.spec.ts" } as never);
  assert.equal(rec.onCamera, false);
  await rec.start();
  assert.equal(rec.isLive, true);
  assert.equal(rec.onCamera, false);
});
