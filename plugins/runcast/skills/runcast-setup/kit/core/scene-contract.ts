// The scene contract (runcast-scene skill), kept free of other kit imports:
// the scene command (scripts/scene.ts) loads it with plain Node.
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * What is wrong with a scene's `window.runcastScene`, as sentences; empty
 * when it keeps the contract: `duration` (ms, above 0), `beats` ([{ id, at }]
 * in time order, unique ids, within the duration) and `start()`. Runs in the
 * page too (page.evaluate), so it is self-contained.
 */
export function sceneProblems(declared: unknown): Array<string> {
  if (typeof declared !== "object" || declared === null) {
    return ["window.runcastScene is missing: set it to { duration, beats, start }."];
  }
  const scene = declared as { duration?: unknown; beats?: unknown; start?: unknown };
  const problems: Array<string> = [];
  const duration = scene.duration;
  const hasDuration = typeof duration === "number" && Number.isFinite(duration) && duration > 0;
  if (!hasDuration) problems.push("duration must be the scene's length in ms (a number above 0).");
  if (typeof scene.start !== "function") problems.push("start() is missing: the kit calls it to play the scene.");
  if (!Array.isArray(scene.beats)) {
    problems.push("beats must be a list of { id, at } (at: ms from start).");
    return problems;
  }
  const seen = new Set<string>();
  let last = -Infinity;
  let lastId = "";
  for (const beat of scene.beats as Array<{ id?: unknown; at?: unknown }>) {
    const id = beat?.id;
    const at = beat?.at;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) {
      problems.push(`beat id ${JSON.stringify(id)} must be a word (letters, digits, - or _).`);
      continue;
    }
    if (seen.has(id)) problems.push(`beat id "${id}" is used twice.`);
    seen.add(id);
    if (typeof at !== "number" || !Number.isFinite(at) || at < 0) {
      problems.push(`beat "${id}" needs at: its time in ms from start (0 or more).`);
      continue;
    }
    if (at < last) problems.push(`beats must be in time order: "${id}" (${at} ms) comes after "${lastId}" (${last} ms).`);
    if (hasDuration && at > (duration as number)) {
      problems.push(`beat "${id}" at ${at} ms is after the scene's end (${duration as number} ms).`);
    }
    last = at;
    lastId = id;
  }
  return problems;
}

/** The scene's file: <recording folder>/scenes/<name>/index.html. */
export function sceneFile(projectDir: string, name: string): string {
  return path.join(projectDir, "scenes", name, "index.html");
}

/** The brand as the CSS variables a scene reads. */
export function brandStyle(
  brand: { color?: string; logo?: string } | undefined,
  projectDir: string,
): string {
  const color = brand?.color ?? "#f97316";
  const logo = brand?.logo
    ? `url("${pathToFileURL(path.resolve(projectDir, brand.logo)).href}")`
    : "none";
  return `:root { --runcast-brand: ${color}; --runcast-logo: ${logo}; }`;
}
