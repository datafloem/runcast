// AI-designed scenes: an HTML animation in <recording folder>/scenes/<name>/
// played on the stage tab as a step of a scenario (runcast-scene skill).
import type { Page } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SourceSwitch } from "./capture-log.ts";
import { projectDirOf } from "./narration.ts";
import { loadProject } from "./project.ts";
import { test } from "./recorder.ts";
import type { Step, StepOptions } from "./scenario.ts";
import { brandStyle, sceneFile, sceneProblems } from "./scene-contract.ts";

export { sceneFile, sceneProblems } from "./scene-contract.ts";

/**
 * A step that plays the scene `name` on the stage tab (video and
 * rehearsal), reached and left by `transition` (default "fade"). Each beat
 * becomes a step mark `<step id>.<beat id>` in steps.json, so narration can
 * speak over a beat; the renderer holds a beat's last frame for a longer
 * voice and never shortens the scene. Test mode loads the scene and checks
 * its contract.
 */
export function scene(
  options: Omit<StepOptions, "transition"> & {
    name: string;
    transition?: SourceSwitch["transition"];
  },
): Step {
  const id = options.id ?? options.name;
  return {
    id,
    title: options.title ?? "Scene",
    note: options.note,
    offCamera: options.offCamera,
    show: options.show,
    scene: options.name,
    run: async ({ page, rec }) => {
      const projectDir = projectDirOf(test.info().file);
      const file = sceneFile(projectDir, options.name);
      if (!existsSync(file)) {
        throw new Error(`Scene not found: ${path.relative(process.cwd(), file)}.`);
      }
      const url = `${pathToFileURL(file).href}?record`;

      if (!rec.isLive || !rec.onCamera) {
        // Test mode (and preparation): the scene loads and keeps the contract.
        const check = await page.context().newPage();
        try {
          await openScene(check, url, file);
        } finally {
          await check.close();
        }
        return;
      }

      const project = await loadProject(projectDir);
      await rec.onStage(
        async (stage) => {
          const { beats, duration } = await openScene(stage, url, file);
          await stage.addStyleTag({ content: brandStyle(project.brand, projectDir) });
          await rec.realTime(async () => {
            const startedAt = Date.now();
            await stage.evaluate(() =>
              (window as unknown as { runcastScene: { start(): void } }).runcastScene.start(),
            );
            for (const beat of beats) {
              await sleepUntil(startedAt + beat.at);
              await rec.step(`${options.title ?? "Scene"} › ${beat.id}`, undefined, {
                id: `${id}.${beat.id}`,
              });
            }
            await sleepUntil(startedAt + duration);
          });
        },
        options.transition ?? "fade",
        options.transition ?? "fade",
        { cursor: false },
      );
    },
  };
}

/** Loads a scene page and checks it; returns its beats and length. */
async function openScene(
  page: Page,
  url: string,
  file: string,
): Promise<{ duration: number; beats: Array<{ id: string; at: number }> }> {
  await page.goto(url);
  const declared = await page.evaluateHandle(
    () => (window as unknown as { runcastScene?: unknown }).runcastScene,
  );
  const problems = await page.evaluate(sceneProblems, declared);
  if (problems.length > 0) {
    throw new Error(
      `${path.relative(process.cwd(), file)} does not keep the scene contract:\n- ${problems.join("\n- ")}`,
    );
  }
  return page.evaluate(() => {
    const scene = (window as unknown as {
      runcastScene: { duration: number; beats: Array<{ id: string; at: number }> };
    }).runcastScene;
    return { duration: scene.duration, beats: scene.beats.map((b) => ({ id: b.id, at: b.at })) };
  });
}

function sleepUntil(wall: number): Promise<void> {
  return new Promise((done) => setTimeout(done, Math.max(0, wall - Date.now())));
}
