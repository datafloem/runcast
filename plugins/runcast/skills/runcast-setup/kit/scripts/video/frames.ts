// Single frames of a recording, decoded by ffmpeg (render --check, previews).
//
// Pure functions, no kit imports: plain Node runs this file.
import { spawn } from "node:child_process";

/**
 * One raw RGBA frame of a recording at `ms` from its start. Past the end it
 * is the last frame: a tab recording ends with the last frame that changed,
 * while the page may have stayed still after it. Null only when the file
 * has no frame at all.
 */
export async function readFrameAt(
  file: string,
  ms: number,
  width: number,
  height: number,
): Promise<Buffer | null> {
  const size = width * height * 4;
  // The frame shown at ms: the last one that starts at or before it. A
  // seek to ms itself gives the first frame at or after it, which in a tab
  // recording (a frame only when the page changes) can be the next change.
  const shown = (await frameAtOrBefore(file, ms)) ?? ms;
  const at = await decode(["-ss", seconds(shown), "-i", file, "-frames:v", "1"]);
  if (at.length >= size) return at.subarray(0, size);
  // The last second's frames; the last of them.
  const tail = await decode(["-sseof", "-1", "-i", file]);
  if (tail.length < size) return null;
  const last = Math.floor(tail.length / size) - 1;
  return tail.subarray(last * size, (last + 1) * size);
}

/** ms as seconds for -ss, rounded down so the frame starting there is kept. */
function seconds(ms: number): string {
  return (Math.floor(Math.max(0, ms)) / 1000).toFixed(3);
}

/** How far back to look for the frame shown at a time (a still page sends about one frame a second). */
const LOOK_BACK_MS = 3_000;

/**
 * When the frame shown at `ms` starts: the last frame at or before it (ms
 * from the file's start), from the file's packet times. Null when the file
 * has no frame before ms.
 */
export async function frameAtOrBefore(file: string, ms: number): Promise<number | null> {
  const probe = (from: number) =>
    run("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-read_intervals", `${(from / 1000).toFixed(3)}%${((ms + 1) / 1000).toFixed(3)}`,
      "-show_entries", "packet=pts_time", "-of", "csv=p=0", file,
    ]);
  for (const from of [Math.max(0, ms - LOOK_BACK_MS), 0]) {
    const times = (await probe(from))
      .split("\n")
      .map((line) => Number.parseFloat(line) * 1000)
      .filter((t) => Number.isFinite(t) && t <= ms + 0.5);
    if (times.length > 0) return Math.max(...times);
    if (from === 0) break;
  }
  return null;
}

/**
 * Raw RGBA frames of the recording at `fps`, starting at recording time
 * `fromMs` (default 0). The recording usually starts a little before that
 * (startMs < 0): skip ahead. If it started later, repeat its first frame
 * until then. Off-camera time stays in: the time map (timemap.ts) decides
 * which frame shows when. A start inside a still stretch begins with the
 * frame shown there (decoding from where it starts), not the next change.
 */
export async function* readFrames(
  file: string,
  startMs: number,
  width: number,
  height: number,
  fromMs = 0,
  fps = 30,
): AsyncGenerator<Buffer> {
  // Recording time r is at r - startMs in the file.
  const offset = fromMs - startMs;
  const args = ["-v", "error"];
  let skip = 0;
  if (offset > 0) {
    const shown = (await frameAtOrBefore(file, offset)) ?? 0;
    args.push("-ss", seconds(shown));
    // The output starts with the frame shown at `shown`: drop the frames
    // up to `offset`.
    skip = Math.floor(((offset - Math.floor(shown)) * fps) / 1000 + 1e-6);
  }
  args.push("-i", file);
  const filters: Array<string> = [];
  if (offset < 0) {
    filters.push(`tpad=start_duration=${(-offset / 1000).toFixed(3)}:start_mode=clone`);
  }
  // round=up: a frame lands in the first slot at or after its time, never
  // earlier (the output -r rounds to the nearest slot, and older ffmpeg
  // versions put a change one slot early).
  filters.push(`fps=${fps}:round=up`);
  args.push("-vf", filters.join(","), "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1");
  const decoder = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "ignore"] });

  const frameSize = width * height * 4;
  // Collect pieces and join them once per frame: joining on every piece
  // copies the growing buffer again and again.
  const pieces: Array<Buffer> = [];
  let size = 0;
  try {
    for await (const chunk of decoder.stdout as AsyncIterable<Buffer>) {
      pieces.push(chunk);
      size += chunk.length;
      while (size >= frameSize) {
        const joined = Buffer.concat(pieces, size);
        const frame = joined.subarray(0, frameSize);
        const rest = joined.subarray(frameSize);
        pieces.length = 0;
        if (rest.length > 0) pieces.push(rest);
        size = rest.length;
        if (skip > 0) skip--;
        else yield frame;
      }
    }
  } finally {
    // The video may be longer than needed: stop the decoder quietly.
    decoder.stdout.destroy();
    decoder.kill();
  }
}

/** A command's standard output. */
function run(command: string, args: Array<string>): Promise<string> {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
  const pieces: Array<Buffer> = [];
  child.stdout.on("data", (chunk: Buffer) => pieces.push(chunk));
  return new Promise((resolve) => child.on("close", () => resolve(Buffer.concat(pieces).toString("utf-8"))));
}

/** Raw RGBA frames ffmpeg decodes with these input and output options. */
function decode(options: Array<string>): Promise<Buffer> {
  const args = ["-v", "error", ...options, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"];
  const decoder = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "ignore"] });
  const pieces: Array<Buffer> = [];
  decoder.stdout.on("data", (chunk: Buffer) => pieces.push(chunk));
  return new Promise((resolve) => {
    decoder.on("close", () => resolve(Buffer.concat(pieces)));
  });
}
