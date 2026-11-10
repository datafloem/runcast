// Records scenarios in video mode, then checks each capture: one picture per
// step (the contact sheet) and the narration fit, in seconds. The full video
// is one render command away, printed at the end.
//
//   node <recording folder>/.kit/cli.ts video [--render] [<playwright args, e.g. a scenario name>]
//
// --render (or REC_RENDER=full) renders the whole MP4 right after recording.
// REC_FROM / REC_TO and the other settings work as in the other modes.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { statSync } from "node:fs";
import { kitCommand, loadProject } from "../../core/project.ts";
import { check, findCaptures, render } from "./render.ts";
import { takeOptions } from "./take.ts";

const startedAt = Date.now();
const projectDir = (await loadProject()).dir;
const config = path.join(projectDir, "playwright.config.ts");
const take = takeOptions(process.argv.slice(2), process.env);
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
  [cli, "test", "-c", config, ...take.args],
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
    if (take.render === "full") {
      const out = await render(dir);
      console.log(`Video: ${path.relative(process.cwd(), out)}`);
    } else {
      const sheet = await check(dir);
      const scenario = path.basename(path.dirname(dir));
      console.log(`Check: ${path.relative(process.cwd(), sheet)}`);
      console.log(
        `Look at the sheet and the fit table, then render the video: ${kitCommand(projectDir)} render ${scenario}`,
      );
    }
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
