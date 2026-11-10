// The edges of a voice-over clip. Given the next segment's text as context,
// ElevenLabs sometimes starts saying it at the end of a clip: after a pause,
// a few tens of ms of the next word, cut off by the end of the file. Played
// as is, that is a click and a fragment of a word between two clips. The
// render leaves that out and fades every clip in and out, so a clip never
// starts or stops on a click.
//
// Pure functions and ffmpeg, no kit imports: plain Node runs this file.
import { execFileSync } from "node:child_process";

/** Fade at the start of every clip (a clip can start right on a sound). */
export const VOICE_FADE_IN_MS = 10;
/** Fade at the end of every clip. */
export const VOICE_FADE_OUT_MS = 30;

/** Level frames are this long. */
const FRAME_MS = 10;
/** A stray start is at most this long... */
const MAX_TAIL_MS = 250;
/** ...comes after at least this much quiet... */
const MIN_PAUSE_MS = 200;
/** ...and reaches the end of the clip (within this). */
const END_SLACK_MS = 30;
/** Dips shorter than this inside the stray start are part of it. */
const MAX_DIP_MS = 50;
/** Quiet kept after the speech when the stray start is cut. */
const KEEP_AFTER_MS = 80;
/** "Quiet" is 40 dB under the loudest frame (as `narration split`). */
const QUIET = 0.01;

/**
 * Where a clip should end (ms) when it ends on a stray start: a short sound
 * after a pause that runs up to the end of the clip. Null when the clip
 * ends otherwise. `levels` are RMS levels of 10 ms frames.
 */
export function strayTailMs(levels: Array<number>): number | null {
  const n = levels.length;
  if (n === 0) return null;
  const floor = Math.max(...levels) * QUIET;
  const loud = levels.map((level) => level > floor);
  const last = loud.lastIndexOf(true);
  if (last < 0 || (n - 1 - last) * FRAME_MS > END_SLACK_MS) return null;

  // Back over the sound to its start, across short dips.
  let start = last;
  let quiet = 0;
  for (let i = last - 1; i >= 0; i--) {
    if (loud[i]) {
      start = i;
      quiet = 0;
    } else if (++quiet * FRAME_MS >= MAX_DIP_MS) {
      break;
    }
  }
  if ((last - start + 1) * FRAME_MS > MAX_TAIL_MS) return null;

  // The pause before it, back to where the speech ends.
  let speechEnd = start - 1;
  while (speechEnd >= 0 && !loud[speechEnd]) speechEnd--;
  if (speechEnd < 0) return null;
  const pause = start - speechEnd - 1;
  if (pause * FRAME_MS < MIN_PAUSE_MS) return null;
  return Math.min(speechEnd + 1 + KEEP_AFTER_MS / FRAME_MS, start) * FRAME_MS;
}

/** How much of a clip file to play (ms): all of it, or up to a stray start. */
export function clipEndMs(file: string): number {
  const rate = 44100;
  const pcm = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-ac", "1", "-ar", String(rate), "-f", "s16le", "pipe:1"],
    { maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"] },
  );
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const frame = (rate * FRAME_MS) / 1000;
  const levels: Array<number> = [];
  for (let i = 0; i < samples.length; i += frame) {
    const to = Math.min(samples.length, i + frame);
    let sum = 0;
    for (let j = i; j < to; j++) sum += samples[j] * samples[j];
    levels.push(Math.sqrt(sum / (to - i)));
  }
  const lengthMs = Math.round((samples.length / rate) * 1000);
  return strayTailMs(levels) ?? lengthMs;
}

/**
 * The ffmpeg filter that places one clip (input `inputIndex`) at `at` ms
 * of the video as `[label]`: played up to `endMs` of the file, faded in and
 * out. A clip that started before the video (a --steps range) is trimmed
 * at its start instead of delayed.
 */
export function voiceClipFilter(
  clip: { at: number; endMs: number },
  inputIndex: number,
  label: string,
): string {
  const s = (ms: number) => (ms / 1000).toFixed(3);
  const from = Math.max(0, -clip.at);
  const length = clip.endMs - from;
  const fadeOut = Math.min(VOICE_FADE_OUT_MS, length / 2);
  const chain = [
    `atrim=start=${s(from)}:end=${s(clip.endMs)}`,
    "asetpts=PTS-STARTPTS",
    `afade=t=in:st=0:d=${s(Math.min(VOICE_FADE_IN_MS, length / 2))}`,
    `afade=t=out:st=${s(length - fadeOut)}:d=${s(fadeOut)}`,
    ...(clip.at > 0 ? [`adelay=${Math.round(clip.at)}:all=1`] : []),
  ];
  return `[${inputIndex}:a]${chain.join(",")}[${label}]`;
}
