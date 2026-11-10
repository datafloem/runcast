// Reading single frames of a recording (render --check, previews).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { readFrameAt } from "../scripts/video/frames.ts";

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
