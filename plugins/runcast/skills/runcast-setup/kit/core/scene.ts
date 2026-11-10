// AI-designed scenes: an HTML animation in <recording folder>/scenes/<name>/
// played on the stage tab as a step of a scenario (runcast-scene skill).
import type { Page } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SourceSwitch } from "./capture-log.ts";
import { loadProject } from "./project.ts";
import { blockNetwork } from "./tab-capture.ts";
import type { Step, StepOptions } from "./scenario.ts";
import { brandStyle, sceneFile, sceneHash, sceneProblems } from "./scene-contract.ts";

export { sceneFile, sceneHash, sceneProblems } from "./scene-contract.ts";

/**
 * A step that shows the scene `name` (scenes/<name>/index.html), reached by
 * `transition` (default "fade") and left by `back` (default: the same).
 * Each beat becomes a step mark `<step id>.<beat id>` in steps.json, so
 * narration can speak over a beat; a longer voice holds the beat's last
 * frame and the scene is never shortened.
 *
 * Default: added when rendering. Recording only checks the scene's contract
 * in an unrecorded page and leaves a placeholder of its length (no wall
 * time), so changing or swapping a scene needs only `render`. `live: true`
 * plays it on the stage tab during the take instead. Test mode checks the
 * contract.
 */
export function scene(
  options: Omit<StepOptions, "transition"> & {
    name: string;
    transition?: SourceSwitch["transition"];
    back?: SourceSwitch["transition"];
    live?: boolean;
  },
): Step {
  const id = options.id ?? options.name;
  const title = options.title ?? "Scene";
  const into = options.transition ?? "fade";
  const back = options.back ?? into;
  return {
    id,
    title,
    note: options.note,
    offCamera: options.offCamera,
    show: options.show,
    scene: options.name,
    run: async ({ page, rec }) => {
      const projectDir = rec.projectDir;
      const file = sceneFile(projectDir, options.name);
      if (!existsSync(file)) {
        throw new Error(`Scene not found: ${path.relative(process.cwd(), file)}.`);
      }
      const url = `${pathToFileURL(file).href}?record`;

      // Its contract, read in a page the video never shows.
      const check = async () => {
        const probe = await page.context().newPage();
        await blockNetwork(probe);
        try {
          return await openScene(probe, url, file);
        } finally {
          await probe.close();
        }
      };

      if (!rec.isLive || !rec.onCamera) {
        // Test mode (and preparation, off camera): the scene loads and keeps the contract.
        await check();
        return;
      }

      if (!options.live) {
        const { duration, beats } = await check();
        rec.scenePlaceholder(
          { id, title },
          {
            name: options.name,
            duration,
            beats,
            in: into,
            out: back,
            hash: sceneHash(path.dirname(file)),
          },
        );
        return;
      }

      const project = await loadProject(projectDir);
      let scene = { duration: 0, beats: [] as Array<{ id: string; at: number }> };
      await rec.onStage(
        async (stage) => {
          const { beats, duration } = scene;
          await rec.realTime(async () => {
            const startedAt = Date.now();
            await stage.evaluate(() =>
              (window as unknown as { runcastScene: { start(): void } }).runcastScene.start(),
            );
            for (const beat of beats) {
              await sleepUntil(startedAt + beat.at);
              await rec.step(`${title} › ${beat.id}`, undefined, { id: `${id}.${beat.id}` });
            }
            await sleepUntil(startedAt + duration);
          });
        },
        into,
        back,
        {
          cursor: false,
          // Loaded, checked and branded before the video changes to it.
          prepare: async (stage) => {
            scene = await openScene(stage, url, file);
            await stage.addStyleTag({ content: brandStyle(project.brand, projectDir) });
          },
        },
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
