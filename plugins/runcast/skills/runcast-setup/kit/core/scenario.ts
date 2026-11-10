import type { Page } from "@playwright/test";
import { requireEnv } from "./env.ts";
import { resolveFormat, type VideoFormat } from "./format.ts";
import { isVideoMode, resolveAppAudio, settings } from "./mode.ts";
import {
  loadNarration,
  segmentLength,
  type NarrationScript,
} from "./narration.ts";
import { sleep } from "./cursor.ts";
import { test, type Recorder, type Ui } from "./recorder.ts";

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
   * What the viewer should look at once the step is done (e.g. the cards a
   * dashboard opens with): a CSS selector, or `{ target, transition }` to
   * choose how the camera gets there (see ShowTransition; default the
   * scenario's showTransition). The camera frames it tightly, or moves a
   * vertical crop there, until the next action. Scenario-specific: passed
   * with the step's options. On `hold`, it is framed during the hold.
   */
  show?: StepShow;
  /**
   * Runs the step off camera: fast and silent, as in preparation, and cut
   * out of the video, which goes on with the next step (a short cross-fade
   * joins both sides). For waits and repeated work the viewer need not see.
   * Has no note, voice-over or caption. Tests run it as usual.
   */
  offCamera?: boolean;
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

/**
 * How the camera reaches a shown element (Step.show, rec.show): "pan" (a
 * camera move, default), "slide" (the new view pushes the old one out
 * sideways), "fade", "cube" (a cube turn) or "cut" (at once).
 */
export type ShowTransition = "pan" | "slide" | "fade" | "cube" | "cut";

/** Step.show: a CSS selector, or one with its transition. */
export type StepShow = string | { target: string; transition?: ShowTransition };

/** How long the page settles after an off-camera step before the video goes on. */
const OFF_CAMERA_SETTLE_MS = 300;

/**
 * How long the page settles at the end of each recorded step (video mode):
 * the renderer may hold a step's last frame for its narration, and right
 * after a navigation or a click that frame can still be half drawn. App
 * time, so the renderer can shorten it again.
 */
const STEP_SETTLE_MS = 300;

/** The shortest a step with a transition lasts in the video, so the turn can be followed. */
export const TRANSITION_MIN_MS = 1200;

/** Per-use overrides every step factory accepts. */
export interface StepOptions {
  id?: string;
  title?: string;
  note?: string;
  transition?: StepTransition;
  show?: StepShow;
  offCamera?: boolean;
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
   * The video's shape (see VideoFormat): "landscape" (default), "vertical"
   * (the page is 9:16, so the app shows its mobile layout, in every mode),
   * "vertical-crop" or "vertical-fit" (9:16 video from a desktop recording).
   * Chosen in the plan skill. REC_FORMAT overrides it.
   */
  format?: VideoFormat;
  /**
   * How the camera reaches shown elements (steps' `show`, rec.show) when they
   * name no transition: "pan" (default), "slide", "fade", "cube" or "cut".
   * Chosen in the plan skill when several areas are shown.
   */
  showTransition?: ShowTransition;
  /**
   * CSS selectors of elements to blur once they hold a value, e.g. `['[name="email"]']`,
   * for values the viewer must not read (e-mail addresses, server names...).
   * Applied in the page from the first load on, in every mode, so the blur
   * follows scrolling and the camera.
   */
  blur?: Array<string>;
  /**
   * When a step runs longer than its narration, the renderer shortens the
   * step's app waits (loading, spinners) so the voice and the screen stay
   * together. Default true; false keeps real time and leaves silence (e.g.
   * when the video must show how long the app takes).
   * REC_COMPRESS_WAITS=0/1 overrides it when rendering.
   */
  compressWaits?: boolean;
  /**
   * The app's own sound in the video (games, media), mixed under the
   * voice-over: `volume` 0-1 (default 1), `duckTo` 0-1, its level while the
   * voice speaks (default 0.3). Off when not given; REC_APP_AUDIO=0/1
   * overrides it. Recording then runs at the viewer's pace (sound cannot be
   * stretched), and loading waits are cut, never sped up. Tab capture only.
   */
  appAudio?: { volume?: number; duckTo?: number };
  /**
   * How browser dialogs (alert, confirm, prompt, beforeunload) are answered:
   * "accept" (default) or "dismiss". A step can answer the next one
   * differently with `rec.onDialog({ accept, text })`. The video holds the
   * frame and draws the dialog being answered (1.5 s).
   */
  dialogs?: "accept" | "dismiss";
  /**
   * Browser permissions granted before the first page load, so no prompt
   * shows, e.g. `["geolocation", "notifications", "clipboard-read"]`
   * (Playwright's names).
   */
  permissions?: Array<string>;
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
 * Voice-over: scenarios/<name>.narration.json does not change the
 * recording. The renderer fits each segment to its step (holds the step's
 * last frame for a longer voice, shortens app waits for a shorter one), so a
 * changed text needs new audio and a new render, never a new recording.
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
    rec.compressWaits = definition.compressWaits ?? true;
    rec.cards = { intro: definition.intro, outro: definition.outro };
    rec.showTransition = definition.showTransition ?? "pan";
    rec.appAudio = resolveAppAudio(definition.appAudio);
    rec.dialogs = definition.dialogs ?? "accept";
    if (definition.permissions?.length) {
      await page.context().grantPermissions(definition.permissions);
    }
    // Before the first page load, so the app starts in the layout it is recorded in.
    await rec.useFormat(resolveFormat(definition.format));
    if (definition.blur?.length) await blurOnScreen(page, definition.blur);
    const ctx: StepContext = { page, rec, state: {} };
    await steps[0]?.entry?.(ctx);

    for (const [index, step] of steps.entries()) {
      if (index > to) break;
      if (index === from) await rec.start();
      const title = `${index + 1}. ${step.title}`;

      if (step.offCamera && rec.isLive) {
        console.log(`(off camera) ${title}`);
        rec.suspend();
        await test.step(title, () => step.run(ctx));
        // Let the page finish drawing while still off camera, so the video
        // goes on from a settled screen.
        if (isVideoMode) await sleep(OFF_CAMERA_SETTLE_MS);
        rec.resume();
        continue;
      }

      const startedMs = rec.elapsedMs();
      await rec.step(title, step.note, {
        id: step.id,
        transition: step.transition,
      });
      await test.step(title, async () => {
        await step.run(ctx);
        if (step.show) await showStep(ctx, step.show);
      });
      if (isVideoMode) await sleep(STEP_SETTLE_MS);

      if (step.transition) {
        // A turn faster than this cannot be followed (rec.pause: video and rehearsal only).
        const spentMs = rec.elapsedMs() - startedMs;
        if (spentMs < TRANSITION_MIN_MS)
          await rec.pause(TRANSITION_MIN_MS - spentMs);
      }
    }
  };
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
    } else if (steps.find((step) => step.id === segment.step)?.offCamera) {
      console.warn(
        `Narration: "${segment.step}" runs off camera; its segment is not used.`,
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
  const ms = options.ms ?? 4000;
  return {
    id: options.id ?? "hold",
    title: options.title ?? "Closing",
    note: options.note,
    transition: options.transition,
    offCamera: options.offCamera,
    // Its `show` is framed during the hold, not after it.
    run: (ctx) =>
      options.show ? showStep(ctx, options.show, ms) : ctx.rec.pause(ms),
  };
}

/** Points the camera at a step's `show`. */
function showStep(
  { page, rec }: StepContext,
  show: StepShow,
  ms?: number,
): Promise<void> {
  const { target, transition } =
    typeof show === "string" ? { target: show, transition: undefined } : show;
  return rec.show(page.locator(target).first(), { ms, transition });
}
