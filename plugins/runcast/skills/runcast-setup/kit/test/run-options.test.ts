// What `video` does after a take.
import assert from "node:assert/strict";
import { test } from "node:test";
import { takeOptions } from "../scripts/video/take.ts";

test("a take ends with the check by default", () => {
  assert.deepEqual(takeOptions(["demo"], {}), { render: "check", args: ["demo"] });
});

test("--render or REC_RENDER=full renders the whole video", () => {
  assert.deepEqual(takeOptions(["demo", "--render"], {}), { render: "full", args: ["demo"] });
  assert.deepEqual(takeOptions(["demo"], { REC_RENDER: "full" }), { render: "full", args: ["demo"] });
  assert.deepEqual(takeOptions(["--render=check", "demo"], { REC_RENDER: "full" }), {
    render: "check",
    args: ["demo"],
  });
});
