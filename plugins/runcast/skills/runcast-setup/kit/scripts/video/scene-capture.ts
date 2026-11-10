// A scene's own capture: .captures/scene-<name>/ (capture/, steps.json with a
// step per beat, scene.json). Written by `scene preview` / `scene render`,
// and by the renderer when a take shows a scene added at render time and its
// capture is missing or out of date.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { captureRootFor, type ProjectConfig } from "../../core/project.ts";
import { brandStyle, sceneFile, sceneHash, sceneProblems } from "../../core/scene-contract.ts";
import {
  blockNetwork,
  captureChannel,
  sizeWindow,
  TabCapture,
  TAB_CAPTURE_ARGS,
  TAB_CAPTURE_IGNORED_ARGS,
} from "../../core/tab-capture.ts";

/** Still frame kept before the scene starts and after it ends. */
const LEAD_MS = 400;

/** scene.json: what the renderer needs to put the scene into a video. */
export interface SceneCaptureInfo {
  /** The scene folder's content it was recorded from. */
  hash: string;
  /** Where the scene starts on the capture's clock (ms). */
  startMs: number;
  duration: number;
  beats: Array<{ id: string; at: number }>;
  viewport: { width: number; height: number };
  scale: number;
}

export function sceneCaptureRoot(projectDir: string, name: string): string {
  return captureRootFor(projectDir, `scene-${name}`);
}

/** The scene's capture info, or null when it is missing. */
export function readSceneCapture(projectDir: string, name: string): SceneCaptureInfo | null {
  const file = path.join(sceneCaptureRoot(projectDir, name), "scene.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as SceneCaptureInfo;
  } catch {
    return null;
  }
}

/**
 * Whether the scene's capture can be used for a video of this page size and
 * scale: recorded from the scene folder as it is now, at the same size.
 */
export function sceneCaptureFresh(
  projectDir: string,
  name: string,
  viewport: { width: number; height: number },
  scale: number,
): boolean {
  const info = readSceneCapture(projectDir, name);
  if (!info) return false;
  const dir = path.dirname(sceneFile(projectDir, name));
  return (
    existsSync(dir) &&
    info.hash === sceneHash(dir) &&
    Math.round(info.viewport.width) === Math.round(viewport.width) &&
    Math.round(info.viewport.height) === Math.round(viewport.height) &&
    Math.abs(info.scale - scale) < 1e-6
  );
}

/** Records the scene alone at this page size and scale (headless Chrome, tab capture). */
export async function recordSceneCapture(
  project: ProjectConfig,
  name: string,
  options: { viewport: { width: number; height: number }; scale: number; format?: string },
): Promise<SceneCaptureInfo> {
  const file = sceneFile(project.dir, name);
  if (!existsSync(file)) throw new Error(`No scene ${path.relative(process.cwd(), file)}.`);
  const root = sceneCaptureRoot(project.dir, name);
  const captureDir = path.join(root, "capture");
  const browser = await chromium.launch({
    channel: captureChannel(),
    headless: true,
    args: [...TAB_CAPTURE_ARGS, `--force-device-scale-factor=${options.scale}`],
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
    await sizeWindow(page, {
      width: Math.round(options.viewport.width),
      height: Math.round(options.viewport.height),
    });
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
      scale: options.scale,
      stage: false,
    });
    await capture.start();
    await sleep(LEAD_MS);
    const from = capture.now();
    await page.evaluate(() => (window as unknown as { runcastScene: { start(): void } }).runcastScene.start());
    const marks: Array<{ id: string; title: string; seconds: number; startMs: number }> = [];
    for (const beat of beats) {
      await sleep(Math.max(0, from + beat.at - capture.now()));
      const ms = from + beat.at;
      marks.push({ id: beat.id, title: beat.id, seconds: Math.round(ms / 100) / 10, startMs: Math.round(ms) });
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
        { scenario: `scene-${name}`, captions: false, compressWaits: false, format: options.format, steps: marks },
        null,
        2,
      ),
    );
    const info: SceneCaptureInfo = {
      hash: sceneHash(path.dirname(file)),
      startMs: Math.round(from),
      duration,
      beats,
      viewport: options.viewport,
      scale: options.scale,
    };
    writeFileSync(path.join(root, "scene.json"), JSON.stringify(info, null, 2));
    return info;
  } finally {
    await browser.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
