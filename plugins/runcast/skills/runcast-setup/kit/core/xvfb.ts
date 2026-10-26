// Linux video mode without a screen (CI, servers, containers): starts an Xvfb
// virtual display for Chrome to open on and ffmpeg to record. Stopped when the
// test run ends.
import { spawn } from "node:child_process";
import { openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Sets DISPLAY to a new Xvfb display when there is none, and returns the
 * scale Chrome must draw at on it (null: an existing display, left alone).
 *
 * REC_XVFB_SIZE is the page area in CSS pixels (default 1920x1080);
 * REC_XVFB_SCALE (default 1) multiplies the display, like a Retina screen:
 * at 2 the page keeps its layout but is drawn with twice the pixels.
 */
export async function ensureDisplay(): Promise<number | null> {
  // Workers load the config again: they reuse the display and its scale.
  if (process.env.REC_XVFB_DISPLAY_SCALE)
    return Number(process.env.REC_XVFB_DISPLAY_SCALE);
  if (process.env.DISPLAY) return null;
  const [width = 1920, height = 1080] = (
    process.env.REC_XVFB_SIZE ?? "1920x1080"
  )
    .split("x")
    .map(Number);
  const scale = Number(process.env.REC_XVFB_SCALE ?? 1) || 1;
  const size = `${Math.round(width * scale)}x${Math.round(height * scale)}`;
  const log = path.join(tmpdir(), `rec-xvfb-${process.pid}.log`);
  // -displayfd: Xvfb picks a free display number and writes it to stdout.
  const xvfb = spawn(
    "Xvfb",
    ["-displayfd", "1", "-screen", "0", `${size}x24`, "-nolisten", "tcp"],
    { stdio: ["ignore", "pipe", openSync(log, "w")] },
  );
  const stdout = xvfb.stdout;
  if (!stdout) throw new Error("Xvfb: no stdout");
  const display = await new Promise<string>((resolve, reject) => {
    stdout.on("data", (chunk: Buffer) => {
      const number = /\d+/.exec(chunk.toString())?.[0];
      if (number) resolve(`:${number}`);
    });
    xvfb.once("error", () => {
      reject(
        new Error(
          "Video mode on Linux without a screen needs Xvfb (e.g. apt install xvfb).",
        ),
      );
    });
    xvfb.once("exit", (code) => {
      reject(
        new Error(
          `Xvfb exited (${code ?? "signal"}):\n${readFileSync(log, "utf-8")}`,
        ),
      );
    });
  });
  // Nothing more to read; the test run must not wait for Xvfb to end.
  stdout.destroy();
  xvfb.unref();
  process.on("exit", () => xvfb.kill());
  process.env.DISPLAY = display;
  process.env.REC_XVFB_DISPLAY_SCALE = String(scale);
  console.log(`Xvfb ${size} (scale ${scale}) on ${display}`);
  return scale;
}
