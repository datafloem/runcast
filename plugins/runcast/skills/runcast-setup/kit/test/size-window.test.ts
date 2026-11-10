// sizeWindow against a browser that rounds: at a fractional scale (Linux,
// REC_SCALE 1.5) some page heights cannot be reached at all.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "@playwright/test";
import { sizeWindow } from "../core/tab-capture.ts";

const FRAME = 87;

/** A window whose page height is `reach(bounds height - frame)`. */
function fakePage(reach: (height: number) => number): Page {
  const bounds = { width: 800, height: 600 };
  const inner = () => ({ width: bounds.width, height: reach(bounds.height - FRAME) });
  const cdp = {
    async send(method: string, params?: { bounds?: { width?: number; height?: number } }) {
      if (method === "Browser.getWindowForTarget") return { windowId: 1, bounds: { ...bounds } };
      if (method === "Browser.getWindowBounds") return { bounds: { ...bounds } };
      if (method === "Browser.setWindowBounds") {
        if (params?.bounds?.width) bounds.width = params.bounds.width;
        if (params?.bounds?.height) bounds.height = params.bounds.height;
      }
      return {};
    },
    async detach() {},
  };
  const page = {
    context: () => ({ newCDPSession: async () => cdp }),
    evaluate: async () => {
      const now = inner();
      return {
        width: now.width,
        height: now.height,
        frameWidth: bounds.width - now.width,
        frameHeight: bounds.height - now.height,
      };
    },
  };
  return page as unknown as Page;
}

test("sizeWindow sizes the page exactly when the browser allows it", async () => {
  const inner = await sizeWindow(fakePage((h) => h), { width: 1920, height: 1080 });
  assert.deepEqual(inner, { width: 1920, height: 1080 });
});

test("sizeWindow accepts a page 1 px off when rounding allows no exact size", async () => {
  // Only odd heights can be reached.
  const odd = (h: number) => 2 * Math.floor(h / 2) + 1;
  const inner = await sizeWindow(fakePage(odd), { width: 1920, height: 1080 });
  assert.equal(inner.width, 1920);
  assert.ok(Math.abs(inner.height - 1080) === 1, `got ${inner.height}`);
});

test("sizeWindow still fails when the page stays more than 1 px off", async () => {
  // Only heights ending in 5 can be reached.
  const fives = (h: number) => 10 * Math.floor(h / 10) + 5;
  await assert.rejects(
    sizeWindow(fakePage(fives), { width: 1920, height: 1080 }),
    /should be 1920x1080 but is 1920x10[78]5/,
  );
});
