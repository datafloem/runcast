// A scene on its own (runcast-scene skill): recorded in a headless Chrome
// tab like a scenario, then checked or rendered.
//
//   node <recording folder>/.kit/cli.ts scene preview <name>          draft MP4 + contact sheet of the beats
//   node <recording folder>/.kit/cli.ts scene render <name> [--gif] [--bare]   videos/scene-<name>.mp4 (and .gif)
//
// --bare: the scene alone, filling the frame (for articles and websites),
// without the video's background and rounded frame.
//
// The scene is <recording folder>/scenes/<name>/index.html. Its recording
// goes to .captures/scene-<name>/ with each beat as a step, so the renderer's
// --check (one frame per beat: its settled end) and --draft apply as they are.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { captureRootFor, kitCommand, loadProject } from "../core/project.ts";
import { sceneFile } from "../core/scene-contract.ts";
import { recordSceneCapture, sceneCaptureFresh } from "./video/scene-capture.ts";
/** GIF: width and frame rate. */
const GIF_WIDTH = 960;
const GIF_FPS = 15;

const project = await loadProject();
// Read after the project's .env.local is loaded (REC_PAGE_SIZE, REC_SCALE, REC_FORMAT).
const { pageSize, settings } = await import("../core/mode.ts");
const { resolveFormat, recordsVertically, VERTICAL_PAGE } = await import("../core/format.ts");
const KIT_CMD = kitCommand(project.dir);

const [command, name, ...flags] = process.argv.slice(2);
if (!["preview", "render"].includes(command ?? "") || !name) {
  console.error(
    `Usage: ${KIT_CMD} scene preview <name>\n       ${KIT_CMD} scene render <name> [--gif] [--bare]`,
  );
  process.exit(1);
}
const file = sceneFile(project.dir, name);
if (!existsSync(file)) {
  console.error(`No scene ${path.relative(process.cwd(), file)}.`);
  process.exit(1);
}
const root = captureRootFor(project.dir, `scene-${name}`);
const captureDir = path.join(root, "capture");

/** Records the scene into .captures/scene-<name>/ at the video's page size and scale. */
async function record(): Promise<void> {
  const format = resolveFormat(undefined);
  const size = recordsVertically(format) ? VERTICAL_PAGE : pageSize;
  await recordSceneCapture(project, name!, { viewport: size, scale: settings.scale, format });
}

/** The recording is there, from the scene as it is now, at this page size and scale. */
function upToDate(): boolean {
  const format = resolveFormat(undefined);
  const size = recordsVertically(format) ? VERTICAL_PAGE : pageSize;
  return sceneCaptureFresh(project.dir, name!, size, settings.scale);
}


// Errors set the exit code instead of escaping (see scripts/video/run.ts).
try {
  if (command === "preview" || !upToDate()) {
    console.log(`Recording scene ${name}...`);
    await record();
  }
  const { check, render } = await import("./video/render.ts");
  if (command === "preview") {
    const sheet = await check(captureDir);
    const draft = await render(captureDir, { draft: true });
    console.log(`Beats: ${path.relative(process.cwd(), sheet)}`);
    console.log(`Draft: ${path.relative(process.cwd(), draft)}`);
  } else {
    const video = await render(captureDir, { bare: flags.includes("--bare") });
    console.log(`Video: ${path.relative(process.cwd(), video)}`);
    if (flags.includes("--gif")) {
      const gif = video.replace(/\.mp4$/, ".gif");
      const result = spawnSync(
        "ffmpeg",
        [
          "-v", "error", "-y", "-i", video,
          "-vf", `fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`,
          gif,
        ],
        { stdio: "inherit" },
      );
      if (result.status !== 0) throw new Error("ffmpeg could not make the GIF.");
      console.log(`GIF: ${path.relative(process.cwd(), gif)}`);
    }
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
