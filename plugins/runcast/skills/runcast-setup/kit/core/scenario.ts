import type { Page } from "@playwright/test";
import { requireEnv } from "./env.ts";
import { settings } from "./mode.ts";
import {
  loadNarration,
  segmentLength,
  type NarrationScript,
} from "./narration.ts";
import { sleep } from "./cursor.ts";
import {
  test,
  type Recorder,
  type StepNarration,
  type Ui,
} from "./recorder.ts";

/** What a step gets: the page, the recorder, and state shared along the scenario. */
export interface StepContext extends Ui {
  /** Values a step leaves for later ones (e.g. a created name). */
  state: Record<string, unknown>;
}

/**
 * One reusable piece of a scenario: log in, create a customer, add an order...
 * Steps live in the recording folder's steps/ and are combined into
 * scenarios; a scenario never re-implements one. Step factories take
 * StepOptions and pass id, title, note and transition on.
 */
export interface Step {
  /** Unique within a scenario, kebab-case: "login", "create-customer". REC_FROM can name it. */
  id: string;
  /** Short title, numbered by the runner: "Login" -> "1. Login". */
  title: string;
  /** The on-screen message for this step (scenario-specific). */
  note?: string;
  /**
   * Hides this step in the video behind a transition. "cube": the renderer
   * turns a cube from the page as this step starts to the page as the next
   * step starts. What happens during the step is not shown, so use it on a
   * step that only moves somewhere else (opens another area, waits for a
   * load). In video and rehearsal the step lasts at least
   * TRANSITION_MIN_MS; tests ignore it.
   */
  transition?: StepTransition;
  /**
   * Brings a fresh page to where this step starts, when it is the first step
   * of the scenario (e.g. login opens the login page). Runs before recording.
   */
  entry?: (ctx: StepContext) => Promise<void>;
  /** Does the step and checks its result with `expect`. */
  run: (ctx: StepContext) => Promise<void>;
}

/** A transition the renderer draws over a step (see Step.transition). */
export type StepTransition = "cube";

/** The shortest a step with a transition lasts in the video, so the turn can be followed. */
export const TRANSITION_MIN_MS = 1200;

/** Per-use overrides every step factory accepts. */
export interface StepOptions {
  id?: string;
  title?: string;
  note?: string;
  transition?: StepTransition;
}

export interface ScenarioDefinition {
  /** Settings the scenario cannot run without (checked before anything opens). */
  require?: Array<string>;
  steps: Array<Step>;
  /**
   * Where the video starts when REC_FROM is not set (step number or id), for
   * scenarios whose opening steps are never meant to be seen (e.g. login).
   */
  recordFrom?: number | string;
  /**
   * Show each step's note as a caption at the bottom of the video. Off by
   * default; ask the user (plan skill). REC_CAPTIONS=1/0 overrides it when
   * rendering.
   */
  captions?: boolean;
  /**
   * CSS selectors of elements to blur once they hold a value, e.g. `['[name="email"]']`,
   * for values the viewer must not read (e-mail addresses, server names...).
   * Applied in the page from the first load on, in every mode, so the blur
   * follows scrolling and the camera.
   */
  blur?: Array<string>;
  /** Opening card before the recording (video mode). Off when not given. */
  intro?: VideoCard;
  /** Closing card after the recording (video mode). Off when not given. */
  outro?: VideoCard;
  timeoutMs?: number;
}

/**
 * A title card the renderer draws on the brand background with the logo.
 * A narration segment with step "intro" / "outro" is spoken over it; the
 * card then lasts at least as long as that audio.
 */
export interface VideoCard {
  title: string;
  subtitle?: string;
  /** Default 3000 ms (intro) / 4000 ms (outro). */
  durationMs?: number;
}

/**
 * Turns a list of steps into the body of a Playwright test:
 *
 *     test("scenario name", scenario({ require: [...], steps: [...] }));
 *
 *
 * REC_FROM / REC_TO (step number, 1-based, or step id) choose which part is
 * the video (`recordFrom` is the scenario's own default): steps before REC_FROM still run, as fast preparation before the
 * recording starts (they create what the later steps need); steps after
 * REC_TO do not run. Without them the whole scenario is recorded.
 *
 * Voice-over: when scenarios/<name>.narration.json exists (record mode,
 * REC_NARRATION not 0), each recorded step lasts at least as long as its
 * segment plus the gap, so the audio placed at the step's start fits.
 */
export function scenario(
  definition: ScenarioDefinition,
): (fixtures: { page: Page; rec: Recorder }) => Promise<void> {
  const { steps } = definition;
  assertUniqueIds(steps);

  return async ({ page, rec }) => {
    test.setTimeout(definition.timeoutMs ?? 10 * 60_000);
    requireEnv(...(definition.require ?? []));

    // An empty REC_FROM in .env.local means "not set".
    const fromSetting = process.env.REC_FROM;
    const from = resolveStep(
      steps,
      fromSetting !== undefined && fromSetting !== ""
        ? fromSetting
        : definition.recordFrom?.toString(),
      0,
      "REC_FROM",
    );
    const to = resolveStep(
      steps,
      process.env.REC_TO,
      steps.length - 1,
      "REC_TO",
    );
    if (to < from)
      throw new Error(`REC_TO (${to + 1}) is before REC_FROM (${from + 1}).`);

    const narration = settings.narration
      ? loadNarration(test.info().file)
      : null;
    if (narration) checkNarration(narration, steps);

    rec.captions = definition.captions ?? false;
    rec.cards = { intro: definition.intro, outro: definition.outro };
    if (definition.blur?.length) await blurOnScreen(page, definition.blur);
    const ctx: StepContext = { page, rec, state: {} };
    await steps[0]?.entry?.(ctx);

    for (const [index, step] of steps.entries()) {
      if (index > to) break;
      if (index === from) await rec.start();
      const title = `${index + 1}. ${step.title}`;
      const voice = rec.isLive ? narrationFor(narration, step.id) : undefined;
      const startedMs = rec.elapsedMs();
      await rec.step(title, step.note, {
        id: step.id,
        narration: voice,
        transition: step.transition,
      });
      await test.step(title, () => step.run(ctx));

      if (step.transition) {
        // A turn faster than this cannot be followed (rec.pause: video and rehearsal only).
        const spentMs = rec.elapsedMs() - startedMs;
        if (spentMs < TRANSITION_MIN_MS)
          await rec.pause(TRANSITION_MIN_MS - spentMs);
      }

      if (voice && narration) {
        // The step lasts at least its voice-over plus the gap before the next.
        const spentMs = rec.elapsedMs() - startedMs;
        const targetMs = voice.durationMs + narration.gapMs;
        if (spentMs < targetMs) await sleep(targetMs - spentMs);
        else if (spentMs > targetMs + 250) {
          rec.markOverrun(spentMs - targetMs);
          console.warn(
            `${title}: the step ran ${((spentMs - targetMs) / 1000).toFixed(1)} s longer than its narration; ` +
              "lengthen the narration or shorten the step's pauses.",
          );
        }
      }
    }
  };
}

function narrationFor(
  script: NarrationScript | null,
  stepId: string,
): StepNarration | undefined {
  const segment = script?.segments.find((s) => s.step === stepId);
  if (!script || !segment) return undefined;
  const { ms, measured } = segmentLength(segment, script);
  // Audio made from an older text does not fit any more: do not offer it.
  const audio = measured ? (segment.audio ?? null) : null;
  return { text: segment.text, audio, durationMs: ms, measured };
}

/** Warns about segments for steps that do not exist and audio that is out of date. */
function checkNarration(script: NarrationScript, steps: Array<Step>): void {
  const ids = new Set(steps.map((step) => step.id));
  for (const segment of script.segments) {
    // "intro" / "outro" are spoken over the title cards, not over a step.
    if (segment.step === "intro" || segment.step === "outro") continue;
    if (!ids.has(segment.step)) {
      console.warn(
        `Narration: "${segment.step}" is not a step of this scenario.`,
      );
    } else if (!segmentLength(segment, script).measured) {
      console.warn(
        `Narration: no up-to-date audio for "${segment.step}"; using the estimated length ` +
          "(the narration tool's measure or generate command).",
      );
    }
  }
}

function assertUniqueIds(steps: Array<Step>): void {
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id)) {
      throw new Error(
        `Step id "${step.id}" is used twice in a scenario. Pass { id: "..." } to one of them.`,
      );
    }
    seen.add(step.id);
  }
}

/** A step number (1-based) or id from an env value; `fallback` when unset. */
function resolveStep(
  steps: Array<Step>,
  value: string | undefined,
  fallback: number,
  setting: string,
): number {
  if (!value) return fallback;
  const byNumber = Number(value);
  const index = Number.isInteger(byNumber)
    ? byNumber - 1
    : steps.findIndex((step) => step.id === value);
  if (index >= 0 && index < steps.length) return index;

  const list = steps
    .map((step, i) => `  ${i + 1}. ${step.id} (${step.title})`)
    .join("\n");
  throw new Error(
    `${setting}=${value} is not a step of this scenario. Steps:\n${list}`,
  );
}

/** Blurs the matching elements in this page and every page it loads next. */
async function blurOnScreen(
  page: Page,
  selectors: Array<string>,
): Promise<void> {
  // Runs in the page: marks matching elements once they hold a value and
  // blurs only those, so an empty field stays readable until typing starts.
  const install = (list: Array<string>) => {
    const win = window as Window & { __recBlur?: boolean };
    if (win.__recBlur) return;
    win.__recBlur = true;
    const selector = list.join(",");
    const filled = (element: Element) =>
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
        ? element.value !== ""
        : element.textContent.trim() !== "";
    const update = () => {
      document.querySelectorAll(selector).forEach((element) => {
        element.toggleAttribute("data-rec-blur", filled(element));
      });
    };
    const start = () => {
      const style = document.createElement("style");
      style.textContent = "[data-rec-blur] { filter: blur(6px) !important; }";
      document.head.append(style);
      // On every keystroke, and every frame: apps also fill fields without
      // input events (a prefilled edit form after saving).
      document.addEventListener("input", update, true);
      const loop = () => {
        update();
        requestAnimationFrame(loop);
      };
      loop();
    };
    if (document.readyState !== "loading") start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
  };
  await page.addInitScript(install, selectors);
  if (page.url() !== "about:blank") await page.evaluate(install, selectors);
}

/**
 * Holds the screen for the viewer, e.g. a closing shot. Skipped in test mode
 * and before recording.
 */
export function hold(options: StepOptions & { ms?: number } = {}): Step {
  return {
    id: options.id ?? "hold",
    title: options.title ?? "Closing",
    note: options.note,
    transition: options.transition,
    run: ({ rec }) => rec.pause(options.ms ?? 4000),
  };
}
