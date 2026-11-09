// The shape of the finished video. Kept free of other kit imports: the
// renderer loads it with plain Node.

/**
 * - "landscape" (default): 16:9, 1920x1080, for YouTube, websites, slides.
 * - "vertical": 9:16, 1080x1920. The page itself is 9:16 (a narrow window in
 *   video mode, 480x854 in test and rehearsal), so the app shows its mobile
 *   layout. For apps that have one.
 * - "vertical-crop": 9:16 from a landscape recording: the camera shows a 9:16
 *   slice of the desktop page and follows the action.
 * - "vertical-fit": 9:16 with the whole landscape recording across the middle,
 *   captions and cards in the space around it.
 *
 * REC_FORMAT overrides a scenario's format, when recording and when rendering
 * (e.g. a Short from a landscape capture: REC_FORMAT=vertical-crop).
 */
export type VideoFormat =
  | "landscape"
  | "vertical"
  | "vertical-crop"
  | "vertical-fit";

export const VIDEO_FORMATS: ReadonlyArray<VideoFormat> = [
  "landscape",
  "vertical",
  "vertical-crop",
  "vertical-fit",
];

/** Page size of a "vertical" scenario in test and rehearsal (CSS pixels, 9:16). */
export const VERTICAL_PAGE = { width: 480, height: 854 };

export function isVideoFormat(value: unknown): value is VideoFormat {
  return VIDEO_FORMATS.includes(value as VideoFormat);
}

/** REC_FORMAT when set, else the scenario's own format, else "landscape". */
export function resolveFormat(own?: string): VideoFormat {
  const setting = process.env.REC_FORMAT;
  const value = setting !== undefined && setting !== "" ? setting : own;
  if (value === undefined) return "landscape";
  if (!isVideoFormat(value)) {
    throw new Error(
      `Unknown video format "${value}"${setting ? " (REC_FORMAT)" : ""}. Use one of: ${VIDEO_FORMATS.join(", ")}.`,
    );
  }
  return value;
}

/** Only "vertical" records a 9:16 page; the other formats record the desktop page. */
export function recordsVertically(format: VideoFormat): boolean {
  return format === "vertical";
}

export function isVerticalOutput(format: VideoFormat): boolean {
  return format !== "landscape";
}
