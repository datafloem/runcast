// Records scenarios in video mode, then renders each capture to an MP4.
//
//   node <recording folder>/.kit/cli.ts video [<playwright args, e.g. a scenario name>]
//
// REC_FROM / REC_TO and the other settings work as in the other modes.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { statSync } from "node:fs";
import { loadProject } from "../../core/project.ts";
import { findCaptures, render } from "./render.ts";

const startedAt = Date.now();
const config = path.join((await loadProject()).dir, "playwright.config.ts");
// The kit's own Playwright (the runtime's node_modules), not the project's.
const cli = path.join(
  import.meta.dirname,
  "..",
  "..",
  "node_modules",
  "@playwright",
  "test",
  "cli.js",
);
const result = spawnSync(
  process.execPath,
  [cli, "test", "-c", config, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: { ...process.env, REC_MODE: "video" },
  },
);

// Render what this run captured, even when a test failed half-way: the video
// shows how far it got.
const captures = findCaptures().filter(
  (dir) => statSync(dir).mtimeMs >= startedAt,
);
let exitCode = result.status ?? 1;
for (const dir of captures) {
  try {
    const out = await render(dir);
    console.log(`Video: ${path.relative(process.cwd(), out)}`);
  } catch (error) {
    console.error(error);
    exitCode ||= 1;
  }
}
if (captures.length === 0) console.log("This run produced no video capture.");
// No process.exit() here, and no uncaught error: both take Node's fast exit,
// which can hang for good right after rendering (a V8 background compile job
// waits for a garbage collection that never comes). The process ends on its
// own once render() has closed its ffmpeg processes.
process.exitCode = exitCode;
