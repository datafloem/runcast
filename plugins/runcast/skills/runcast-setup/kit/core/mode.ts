/**
 * How the scenarios run. One switch, REC_MODE:
 *
 * - "video": the demo video. A visible Chrome window is recorded with ffmpeg
 *   (macOS or Linux screen capture) while a virtual cursor moves inside the page at a
 *   person's pace; every pointer event is logged, then scripts/video/ turns
 *   both into a finished MP4 (camera, cursor, framing, voice-over).
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

export const settings = {
  /** Only the video needs a window (ffmpeg records the screen). */
  headless: !isVideoMode,
  /**
   * Time each step to its voice-over (scenarios/<name>.narration.json) when the
   * scenario has one. REC_NARRATION=0 ignores it. Never in test mode.
   */
  narration: paced && env.REC_NARRATION !== "0",
  /** How long the last frame stays before the recording stops. */
  endHoldMs: paced ? Number(env.REC_END_HOLD_MS ?? 2000) : 0,
  /** How long the cursor rests on a target before clicking. */
  aimMs: paced ? Number(env.REC_AIM_MS ?? 400) : 0,
  /** `rec.pause()` waits only for the viewer; a test run skips it. */
  pauses: paced,
  /** Delay between typed characters. */
  typeDelay: (pacedDelayMs: number) => (paced ? pacedDelayMs : 0),
  /** Rehearsal and test: page width in CSS pixels; height at 16:9. Video fills the screen. */
  pageWidth: Number(env.REC_PAGE_WIDTH ?? 1440),
};

/** Page size of the headless modes (rehearsal, test): 16:9, like the output video. */
export const pageSize = {
  width: settings.pageWidth,
  height: Math.round((settings.pageWidth * 9) / 16),
};
