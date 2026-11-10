// The app a recording folder belongs to. Every project that uses the kit has
// one `recording.config.ts` in its recording folder (default tests/recording):
//
//   import { defineProject, loadProjectEnv } from "./kit.ts";
//   loadProjectEnv(import.meta.dirname);
//   export default defineProject({ dir: import.meta.dirname, name: "My app", baseURL: "..." });
//
// Kept free of other kit imports: the scripts load it with plain Node.
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface ProjectConfig {
  /** The recording folder: where recording.config.ts, scenarios/ and .env.local live. */
  dir: string;
  /** The app's name, for logs. */
  name: string;
  /** Where the app runs, e.g. http://localhost:5173. */
  baseURL: string;
  /** Browser locale. Scenarios find controls by their labels in it. Default "en-US". */
  locale?: string;
  /** The browser's prefers-color-scheme. */
  colorScheme?: "light" | "dark";
  /**
   * localStorage entries written before the first page load, as raw strings
   * (e.g. a theme the app reads on start).
   */
  localStorage?: Record<string, string>;
  /** The video's look. */
  brand?: {
    /** Accent colour (hex): background glow and click ripples. Default #f97316. */
    color?: string;
    /** Logo on the title cards, relative to `dir` (SVG or PNG). None: cards without a logo. */
    logo?: string;
  };
}

export function defineProject(config: ProjectConfig): ProjectConfig {
  return config;
}

/** Loads `<dir>/.env.local` (gitignored settings and secrets) into process.env. */
export function loadProjectEnv(dir: string): void {
  const file = path.join(dir, ".env.local");
  if (existsSync(file)) process.loadEnvFile(file);
}

/** The recording folder: REC_PROJECT, else tests/recording under the working directory. */
export function projectDir(): string {
  const dir = path.resolve(process.env.REC_PROJECT ?? "tests/recording");
  if (!existsSync(path.join(dir, "recording.config.ts"))) {
    throw new Error(
      `No recording.config.ts in ${dir}. Run from the repository root or set REC_PROJECT to the recording folder.`,
    );
  }
  return dir;
}

/** Imports the project's recording.config.ts (which also loads its .env.local). */
export async function loadProject(dir = projectDir()): Promise<ProjectConfig> {
  const url = pathToFileURL(path.join(dir, "recording.config.ts")).href;
  const module = (await import(url)) as { default: ProjectConfig };
  return module.default;
}

/** How to run the kit's CLI for a project, for messages: `node <dir>/.kit/cli.ts`. */
export function kitCommand(dir: string): string {
  const rel = path.relative(process.cwd(), dir) || ".";
  return `node ${path.join(rel, ".kit", "cli.ts")}`;
}

/**
 * Where a scenario's video recording lives: <recording folder>/.captures/<scenario>/
 * (capture/ with the screen recording and events.json, steps.json, and what
 * the renderer writes next to them). Outside .results, which Playwright
 * empties at the start of every run: a recording stays until the same
 * scenario is recorded again.
 */
export function captureRootFor(dir: string, scenario: string): string {
  return path.join(dir, ".captures", scenario);
}

/**
 * Every capture folder (one with events.json) of a recording folder, newest
 * first: .captures/<scenario>/capture, and .results/<test>/capture from
 * before recordings moved there.
 */
export function findCaptures(dir: string): Array<string> {
  const under = (root: string) =>
    existsSync(root)
      ? readdirSync(root).map((name) => path.join(root, name, "capture"))
      : [];
  return [...under(path.join(dir, ".captures")), ...under(path.join(dir, ".results"))]
    .filter((capture) => existsSync(path.join(capture, "events.json")))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}
