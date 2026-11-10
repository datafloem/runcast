// Reading single frames of a recording (render --check, previews).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { readFrameAt, readFrames } from "../scripts/video/frames.ts";

let dir: string;
let file: string;
before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "runcast-frames-"));
  file = path.join(dir, "clip.mp4");
  // 1 s red, then 1 s blue, 16x16.
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "color=c=red:s=16x16:d=1:r=30",
    "-f", "lavfi", "-i", "color=c=blue:s=16x16:d=1:r=30",
    "-filter_complex", "[0][1]concat=n=2:v=1:a=0", "-pix_fmt", "yuv420p", file,
  ]);
});
after(() => rmSync(dir, { recursive: true, force: true }));

const colour = (frame: Buffer | null) => (frame ? [frame[0]!, frame[1]!, frame[2]!] : null);

test("a frame inside the recording is read at its time", async () => {
  const [r, , b] = colour(await readFrameAt(file, 500, 16, 16))!;
  assert.ok(r > 200 && b < 60, `colour ${r},${b}`);
});

test("a frame asked past the end of a recording is its last frame", async () => {
  // A tab recording ends with the last frame that changed, while the page
  // can stay still for a while after it.
  const frame = await readFrameAt(file, 3500, 16, 16);
  assert.ok(frame, "no frame");
  const [r, , b] = colour(frame)!;
  assert.ok(b > 200 && r < 60, `colour ${r},${b}`);
});

/**
 * A recording like Chrome's tab capture: a frame only when the page changes
 * (red at 0 s, blue at 1 s, green at 2.4 s), nothing in between.
 */
function sparse(blueS = 1.4): string {
  const out = path.join(dir, `sparse-${blueS}.mp4`);
  const list = path.join(dir, `sparse-${blueS}.txt`);
  const still = (name: string, c: string) => {
    const f = path.join(dir, `${name}.png`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${c}:s=16x16:d=0.04`, "-frames:v", "1", f]);
    return f;
  };
  const red = still("red", "red");
  const blue = still("blue", "blue");
  const green = still("green", "green");
  writeFileSync(list, `file '${red}'\nduration 1\nfile '${blue}'\nduration ${blueS}\nfile '${green}'\nduration 0.6\nfile '${green}'\n`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-fps_mode", "vfr", "-pix_fmt", "yuv420p", out]);
  return out;
}

test("in a recording with frames only on change, a frame is the one shown at that time, not the next", async () => {
  const file = sparse();
  const [r1, g1, b1] = colour(await readFrameAt(file, 1500, 16, 16))!;
  assert.ok(b1 > 200 && r1 < 60 && g1 < 60, `1.5 s ${r1},${g1},${b1}`);
  const [r2, , b2] = colour(await readFrameAt(file, 600, 16, 16))!;
  assert.ok(r2 > 200 && b2 < 60, `0.6 s ${r2},${b2}`);
});

test("frames read from the middle of a sparse recording start with the frame shown there", async () => {
  const file = sparse();
  const frames: Array<[number, number, number]> = [];
  // From 1.5 s: blue until 2.4 s (27 frames at 30 fps), then green.
  for await (const frame of readFrames(file, 0, 16, 16, 1500, 30)) {
    frames.push(colour(frame) as [number, number, number]);
    if (frames.length >= 30) break;
  }
  const blue = frames.findIndex(([r, g, b]) => !(b > 200 && r < 60 && g < 60));
  assert.equal(blue, 27, `first not-blue frame ${blue}: ${JSON.stringify(frames[0])}`);
});

test("a change between two frame slots shows from the next slot, never the one before", async () => {
  // Green from 2.38 s: the slot at 2.367 s still shows blue, 2.4 s is green.
  const file = sparse(1.38);
  const frames: Array<[number, number, number]> = [];
  for await (const frame of readFrames(file, 0, 16, 16, 1500, 30)) {
    frames.push(colour(frame) as [number, number, number]);
    if (frames.length >= 30) break;
  }
  const blue = frames.findIndex(([r, g, b]) => !(b > 200 && r < 60 && g < 60));
  assert.equal(blue, 27, `first not-blue frame ${blue}`);
});
