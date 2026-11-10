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
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { captureRootFor, kitCommand, loadProject } from "../core/project.ts";
import { brandStyle, sceneFile, sceneProblems } from "../core/scene-contract.ts";
import {
  blockNetwork,
  captureChannel,
  sizeWindow,
  TabCapture,
  TAB_CAPTURE_ARGS,
  TAB_CAPTURE_IGNORED_ARGS,
} from "../core/tab-capture.ts";

/** Still frame kept before the scene starts and after it ends. */
const LEAD_MS = 400;
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

/** Records the scene into .captures/scene-<name>/ (capture/ and steps.json). */
async function record(): Promise<void> {
  const format = resolveFormat(undefined);
  const size = recordsVertically(format) ? VERTICAL_PAGE : pageSize;
  const browser = await chromium.launch({
    channel: captureChannel(),
    headless: true,
    args: [...TAB_CAPTURE_ARGS, `--force-device-scale-factor=${settings.scale}`],
    ignoreDefaultArgs: [...TAB_CAPTURE_IGNORED_ARGS],
  });
  try {
    const context = await browser.newContext({
      viewport: null,
      colorScheme: project.colorScheme,
      locale: project.locale ?? "en-US",
    });
    const page = await context.newPage();
    await blockNetwork(page);
    await sizeWindow(page, size);
    await page.goto(`${pathToFileURL(file).href}?record`);
    const problems = await page.evaluate(
      sceneProblems,
      await page.evaluateHandle(() => (window as unknown as { runcastScene?: unknown }).runcastScene),
    );
    if (problems.length > 0) {
      throw new Error(`${path.relative(process.cwd(), file)} does not keep the scene contract:\n- ${problems.join("\n- ")}`);
    }
    await page.addStyleTag({ content: brandStyle(project.brand, project.dir) });
    const { duration, beats } = await page.evaluate(() => {
      const s = (window as unknown as {
        runcastScene: { duration: number; beats: Array<{ id: string; at: number }> };
      }).runcastScene;
      return { duration: s.duration, beats: s.beats.map((b) => ({ id: b.id, at: b.at })) };
    });

    rmSync(root, { recursive: true, force: true });
    const capture = new TabCapture(page, captureDir, `scene-${name}`, {
      scale: settings.scale,
      stage: false,
    });
    await capture.start();
    await sleep(LEAD_MS);
    const from = capture.now();
    await page.evaluate(() => (window as unknown as { runcastScene: { start(): void } }).runcastScene.start());
    const marks: Array<{ id: string; title: string; seconds: number }> = [];
    for (const beat of beats) {
      await sleep(Math.max(0, from + beat.at - capture.now()));
      marks.push({ id: beat.id, title: beat.id, seconds: Math.round(capture.now() / 100) / 10 });
    }
    await sleep(Math.max(0, from + duration - capture.now()));
    // The scene plays as recorded: never shortened.
    capture.span("hold", from, capture.now(), capture.now() - from);
    await sleep(LEAD_MS);
    await capture.stop();
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, "steps.json"),
      JSON.stringify(
        { scenario: `scene-${name}`, captions: false, compressWaits: false, format, steps: marks },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
}

/** The recording is there and newer than the scene's files. */
function upToDate(): boolean {
  const events = path.join(captureDir, "events.json");
  if (!existsSync(events)) return false;
  const recorded = statSync(events).mtimeMs;
  return !newestIn(path.dirname(file)).some((mtime) => mtime > recorded);
}

/** When each file in the scene's folder last changed. */
function newestIn(dir: string): Array<number> {
  return readdirSync(dir, { recursive: true, encoding: "utf-8" })
    .map((entry) => statSync(path.join(dir, entry)))
    .filter((stat) => stat.isFile())
    .map((stat) => stat.mtimeMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
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
