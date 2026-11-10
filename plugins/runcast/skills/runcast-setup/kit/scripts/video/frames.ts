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
  const at = await decode(["-ss", (ms / 1000).toFixed(3), "-i", file, "-frames:v", "1"]);
  if (at.length >= size) return at.subarray(0, size);
  // The last second's frames; the last of them.
  const tail = await decode(["-sseof", "-1", "-i", file]);
  if (tail.length < size) return null;
  const last = Math.floor(tail.length / size) - 1;
  return tail.subarray(last * size, (last + 1) * size);
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
