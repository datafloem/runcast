// Render progress (scripts/video/render.ts). Pure, no kit imports.

/** In a log (not a terminal), how often progress is printed. */
const LOG_EVERY_S = 10;

/**
 * What to print at video time `ms` (called once a second): on a terminal
 * one line rewritten in place; in a log (stdout not a terminal) a plain
 * line every LOG_EVERY_S seconds, else null, so a captured log is readable.
 */
export function progressText(
  terminal: boolean,
  scenario: string,
  ms: number,
  totalMs: number,
): string | null {
  const seconds = Math.round(ms / 1000);
  const text = `${scenario}: ${seconds} / ${(totalMs / 1000).toFixed(0)} s`;
  if (terminal) return `\r${text}`;
  return seconds % LOG_EVERY_S === 0 ? `${text}\n` : null;
}
