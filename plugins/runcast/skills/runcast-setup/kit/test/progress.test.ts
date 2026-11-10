// Render progress: one line rewritten on a terminal, plain lines in a log.
import assert from "node:assert/strict";
import { test } from "node:test";
import { progressText } from "../scripts/video/progress.ts";

test("a terminal gets one line, rewritten every second", () => {
  assert.equal(progressText(true, "orders", 3000, 60_000), "\rorders: 3 / 60 s");
  assert.equal(progressText(true, "orders", 4000, 60_000), "\rorders: 4 / 60 s");
});

test("a log gets a line every 10 seconds, no carriage returns", () => {
  assert.equal(progressText(false, "orders", 3000, 60_000), null);
  assert.equal(progressText(false, "orders", 10_000, 60_000), "orders: 10 / 60 s\n");
  assert.equal(progressText(false, "orders", 0, 60_000), "orders: 0 / 60 s\n");
});
