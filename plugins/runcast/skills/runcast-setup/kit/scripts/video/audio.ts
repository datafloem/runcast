// The app's own sound in the render (ScenarioDefinition.appAudio): an ffmpeg
// filter that places the pieces of the recording's audio the time map lets
// play (timemap.ts audioPlan), fades their edges and lowers the level while
// the voice-over speaks.
//
// Pure functions, no kit imports: plain Node runs this file.
import type { AudioPiece } from "./timemap.ts";

/** Fade at every edge next to silence or a cut. */
export const AUDIO_FADE_MS = 100;
/** How long the level takes to go down before a voice clip and back up after it. */
export const DUCK_RAMP_MS = 200;

/** The plan for a video that starts `startMs` later (a --steps range): earlier sound is trimmed. */
export function shiftPlan(plan: Array<AudioPiece>, startMs: number): Array<AudioPiece> {
  return plan.flatMap((piece) => {
    const length = piece.fileTo - piece.fileFrom;
    const outFrom = piece.outFrom - startMs;
    if (outFrom + length <= 0) return [];
    if (outFrom >= 0) return [{ ...piece, outFrom }];
    return [{ ...piece, fileFrom: piece.fileFrom - outFrom, outFrom: 0, fadeIn: false }];
  });
}

/**
 * An ffmpeg filtergraph that turns input `inputIndex` (the recording's
 * audio, times as in the plan) into `[outLabel]`: each piece cut out, faded
 * where the plan says, placed at its video time; then the level `volume`,
 * down to `duckTo` of it during each clip (voice-over, video ms) with
 * DUCK_RAMP_MS ramps.
 */
export function appAudioFilter(
  plan: Array<AudioPiece>,
  clips: Array<{ at: number; ms: number }>,
  options: { volume: number; duckTo: number; inputIndex: number; outLabel: string },
): string {
  const s = (ms: number) => (ms / 1000).toFixed(3);
  const n = plan.length;
  const parts: Array<string> = [];
  if (n === 0) {
    // Nothing plays: silence, so the mix still has its input.
    parts.push(`[${options.inputIndex}:a]volume=0[${options.outLabel}]`);
    return parts.join(";");
  }
  parts.push(
    `[${options.inputIndex}:a]asetpts=PTS-STARTPTS,asplit=${n}${plan.map((_, i) => `[ap${i}]`).join("")}`,
  );
  plan.forEach((piece, i) => {
    const length = piece.fileTo - piece.fileFrom;
    const fade = Math.min(AUDIO_FADE_MS, length / 2);
    const chain = [
      `atrim=start=${s(piece.fileFrom)}:end=${s(piece.fileTo)}`,
      "asetpts=PTS-STARTPTS",
      ...(piece.fadeIn ? [`afade=t=in:st=0:d=${s(fade)}`] : []),
      ...(piece.fadeOut ? [`afade=t=out:st=${s(length - fade)}:d=${s(fade)}`] : []),
      `adelay=${Math.round(Math.max(0, piece.outFrom))}:all=1`,
    ];
    parts.push(`[ap${i}]${chain.join(",")}[aq${i}]`);
  });
  const joined = plan.map((_, i) => `[aq${i}]`).join("");
  const mix = n === 1 ? `${joined}anull` : `${joined}amix=inputs=${n}:normalize=0:duration=longest`;
  // The mix's frames can come out without timestamps; counted from the
  // samples again, the level below knows the time (else t is NaN: silence).
  parts.push(
    `${mix},asetpts=N/SR/TB,volume='${duckExpression(clips, options)}':eval=frame[${options.outLabel}]`,
  );
  return parts.join(";");
}

/** The level over time `t` (seconds) as an ffmpeg expression. */
function duckExpression(
  clips: Array<{ at: number; ms: number }>,
  { volume, duckTo }: { volume: number; duckTo: number },
): string {
  if (clips.length === 0 || duckTo >= 1) return volume.toFixed(3);
  const ramp = DUCK_RAMP_MS / 1000;
  // 0 outside a clip, 1 inside it, ramping before it starts and after it ends.
  // Numbers in parentheses: "t--0.2" (a ramp starting before 0 s) is not
  // an expression ffmpeg reads, and gives NaN.
  const n = (seconds: number) => `(${seconds.toFixed(3)})`;
  const inside = clips.map((clip) => {
    const down = (clip.at - DUCK_RAMP_MS) / 1000;
    const up = (clip.at + clip.ms + DUCK_RAMP_MS) / 1000;
    return `clip(min((t-${n(down)})/${ramp},(${n(up)}-t)/${ramp}),0,1)`;
  });
  const any = inside.reduce((all, one) => `max(${all},${one})`);
  return `${volume.toFixed(3)}*(1-${(1 - duckTo).toFixed(3)}*${any})`;
}
