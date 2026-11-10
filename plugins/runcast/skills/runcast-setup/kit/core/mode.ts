/**
 * How the scenarios run. One switch, REC_MODE:
 *
 * - "video": the demo video. The app's tab is recorded (REC_CAPTURE: a
 *   headless Chrome tab by default, or the screen) while a virtual cursor
 *   moves inside the page at a person's pace; every pointer event is logged,
 *   then scripts/video/ turns both into a finished MP4 (camera, cursor,
 *   framing, voice-over).
 * - "rehearsal": the same pace and timing as a video, but headless and not
 *   recorded. For measuring how long each step takes (narration planning).
 * - "test" (default): a plain end-to-end run. Headless, Playwright's own
 *   clicks, no pauses. Works on any OS, e.g. in CI.
 *
 * The scenarios, steps and helpers are the same in all; only `rec` behaves
 * differently.
 */
const env = process.env;

export type Mode = "video" | "rehearsal" | "test";
export const mode: Mode =
  env.REC_MODE === "video"
    ? "video"
    : env.REC_MODE === "rehearsal"
      ? "rehearsal"
      : "test";
export const isTestMode = mode === "test";
export const isVideoMode = mode === "video";
/** Video and rehearsal run at a person's pace; a test runs as fast as it can. */
const paced = !isTestMode;

/**
 * How video mode records (REC_CAPTURE): "tab" (default) records the app's
 * tab in a headless Chrome, so the computer stays free and the page size is
 * fixed; "screen" records a visible Chrome window with ffmpeg, for flows that
 * must show real OS dialogs.
 */
const capture: "tab" | "screen" = env.REC_CAPTURE === "screen" ? "screen" : "tab";

export const settings = {
  capture,
  /**
   * Tab capture: video pixels per CSS pixel (REC_SCALE, default 1.5: a
   * 1920x1080 page becomes 2880x1620; 1 to 3, as video encoders top out near 4K).
   */
  scale: Math.min(3, Math.max(1, Number(env.REC_SCALE ?? 1.5) || 1.5)),
  /** Only screen capture needs a window on screen. */
  headless: !isVideoMode || capture === "tab",
  /**
   * Use the scenario's voice-over (scenarios/<name>.narration.json): warn
   * about segments that do not fit the steps. The renderer fits the audio
   * (REC_NARRATION=0 there too leaves it out). Never in test mode.
   */
  narration: paced && env.REC_NARRATION !== "0",
  /** How long the last frame stays before the recording stops. */
  endHoldMs: paced ? Number(env.REC_END_HOLD_MS ?? 2000) : 0,
  /** How long the cursor rests on a target before clicking. */
  aimMs: paced ? Number(env.REC_AIM_MS ?? 400) : 0,
  /**
   * Video mode records fast and the renderer restores a person's pace:
   * viewer pauses and cursor rests are cut short, cursor moves run three
   * times faster, typing at 40 ms per character (REC_RECORD_PACE, default
   * "fast"). "natural" records at the viewer's pace, for apps that react
   * differently to a fast cursor (delayed hover menus, debounced inputs).
   */
  fastRecording: isVideoMode && env.REC_RECORD_PACE !== "natural",
  /** `rec.pause()` waits only for the viewer; a test run skips it. */
  pauses: paced,
  /** Delay between typed characters. */
  typeDelay: (pacedDelayMs: number) => (paced ? pacedDelayMs : 0),
  /** Page width in CSS pixels; height at 16:9. Screen capture fills the screen instead. */
  pageWidth: Number(env.REC_PAGE_WIDTH ?? 1920),
};

/** The app's sound in the video, resolved (see ScenarioDefinition.appAudio). */
export interface AppAudio {
  /** Level of the app's sound, 0-1. */
  volume: number;
  /** Its level while the voice-over speaks, 0-1. */
  duckTo: number;
}

/**
 * Whether the video carries the app's sound and at what levels: the
 * scenario's `appAudio` (off when not given; volume 1, duckTo 0.3 by
 * default), REC_APP_AUDIO=0/1 overriding it.
 */
export function resolveAppAudio(
  own: { volume?: number; duckTo?: number } | undefined,
  setting: string | undefined = env.REC_APP_AUDIO,
): AppAudio | null {
  if (setting === "0") return null;
  if (!own && setting !== "1") return null;
  const level = (value: number | undefined, fallback: number) =>
    Math.min(1, Math.max(0, Number.isFinite(value) ? (value as number) : fallback));
  return { volume: level(own?.volume, 1), duckTo: level(own?.duckTo, 0.3) };
}

/**
 * Page size of a landscape page (tab capture, rehearsal, test). REC_PAGE_WIDTH:
 * that width at 16:9. Otherwise REC_PAGE_SIZE ("1512x860"; with screen
 * capture the Playwright config sets it from the newest video recording, so
 * tests lay the app out as the video does). Otherwise 1920x1080.
 */
const sizeSetting = /^(\d+)x(\d+)$/.exec(env.REC_PAGE_SIZE ?? "");
export const pageSize =
  sizeSetting && env.REC_PAGE_WIDTH === undefined
    ? { width: Number(sizeSetting[1]), height: Number(sizeSetting[2]) }
    : {
        width: settings.pageWidth,
        height: Math.round((settings.pageWidth * 9) / 16),
      };
