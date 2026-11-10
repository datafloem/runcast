// The runtime cache (~/.cache/runcast/<version>-<hash>/): which projects link
// to each runtime, and pruning old ones. Loaded by cli.ts with plain Node, so
// no imports of other kit modules.
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const MARKER = ".runtime.json";
const LINKS = ".links.json";

function readLinks(runtime: string): Array<string> {
  try {
    const links: unknown = JSON.parse(readFileSync(path.join(runtime, LINKS), "utf-8"));
    return Array.isArray(links) ? links.filter((l): l is string => typeof l === "string") : [];
  } catch {
    return [];
  }
}

/** Notes that the project's `.kit` link points at `runtime`, so pruning keeps it. */
export function registerLink(runtime: string, kitLink: string): void {
  const link = path.resolve(kitLink);
  const links = readLinks(runtime);
  if (links.includes(link)) return;
  writeFileSync(path.join(runtime, LINKS), JSON.stringify([...links, link], null, 2) + "\n");
}

/** The registered `.kit` links that still point at `runtime`. */
export function linksTo(runtime: string): Array<string> {
  let target: string;
  try {
    target = realpathSync(runtime);
  } catch {
    return [];
  }
  return readLinks(runtime).filter((link) => {
    try {
      return lstatSync(link).isSymbolicLink() && realpathSync(link) === target;
    } catch {
      return false;
    }
  });
}

function builtAt(runtime: string): number {
  return statSync(path.join(runtime, MARKER)).mtimeMs;
}

/**
 * Keeps `current`, the newest `keep - 1` other runtimes, and every runtime a
 * project's `.kit` still links to; removes the rest.
 */
export function pruneRuntimes(home: string, current: string, keep: number): void {
  const all = readdirSync(home)
    .map((name) => path.join(home, name))
    .filter((dir) => dir !== current && existsSync(path.join(dir, MARKER)))
    // By build time (the marker), not the folder's: registering a link
    // writes into the folder.
    .sort((a, b) => builtAt(b) - builtAt(a));
  for (const old of all.slice(Math.max(0, keep - 1))) {
    if (linksTo(old).length > 0) continue;
    rmSync(old, { recursive: true, force: true });
  }
}
