// Runcast's command line. One entry point for every AI tool (Claude
// Code, Codex and Antigravity plugins, or a copied folder) and for people:
//
//   node <kit>/cli.ts setup [--dir tests/recording] [--name "My App"] [--base-url URL] [--skills a,b]
//   node <recording folder>/.kit/cli.ts <command> [args]
//
// Commands (after setup, run them through the project's .kit link):
//   setup                    prepare the runtime, create the recording folder, link .kit
//   doctor                   what is installed, what is missing
//   test [args]              headless end-to-end run (Playwright args, e.g. a scenario name)
//   rehearsal [args]         the video's pace and timing, headless, not recorded
//   video [args]             record and render MP4s
//   render [scenario]        render the last capture again
//   narration <cmd> <name>   voice-over tools (plan, generate, measure, script, split)
//   youtube <cmd> [name]     YouTube upload (check, auth, upload)
//
// The runtime is the kit plus its npm dependencies, in a versioned cache
// (REC_KIT_HOME, default ~/.cache/runcast). Projects keep only their own
// recording folder; its .kit link (gitignored) points at the runtime.
//
// Plain Node 22.18+, no dependencies.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// The kit lives inside the runcast-setup skill (skills/runcast-setup/kit/),
// so tools that install only a plugin's skills (Antigravity) still ship it.
const KIT = import.meta.dirname;
const SKILLS = path.resolve(KIT, "..", "..");
const HAS_SKILLS = existsSync(path.join(SKILLS, "runcast-setup", "SKILL.md"));
const RUNTIME_MARKER = ".runtime.json";
const RUNTIME_HOME = path.resolve(
  process.env.REC_KIT_HOME ?? path.join(homedir(), ".cache", "runcast"),
);
const KEEP_RUNTIMES = 3;

const [command = "help", ...rest] = process.argv.slice(2);
const { options: args, rest: passThrough } = parseArgs(rest);
const projectDir = path.resolve(
  args.dir ??
    process.env.REC_PROJECT ??
    path.join(process.cwd(), "tests", "recording"),
);

switch (command) {
  case "setup":
    setup();
    break;
  case "doctor":
    doctor();
    break;
  case "test":
    playwright("test", passThrough);
    break;
  case "rehearsal":
    playwright("rehearsal", passThrough);
    break;
  case "video":
    script(["scripts", "video", "run.ts"], passThrough);
    break;
  case "render":
    script(["scripts", "video", "render.ts"], ["render", ...passThrough]);
    break;
  case "narration":
    script(["scripts", "narration.ts"], passThrough);
    break;
  case "youtube":
    script(["scripts", "youtube.ts"], passThrough);
    break;
  default:
    console.log(
      readFileSync(import.meta.filename, "utf-8")
        .split("\n")
        .slice(0, 18)
        .join("\n"),
    );
    process.exit(command === "help" ? 0 : 1);
}

// --- setup ---------------------------------------------------------------------

function setup(): void {
  const runtime = ensureRuntime();
  scaffold(runtime);
  link(runtime);
  if (args.skills) copySkills(runtime, args.skills.split(",").filter(Boolean));
  console.log("");
  doctor();
}

/** The kit with its dependencies in the cache; built once per kit version and content. */
function ensureRuntime(): string {
  if (existsSync(path.join(KIT, RUNTIME_MARKER))) return KIT; // already running from it
  const pkg = JSON.parse(
    readFileSync(path.join(KIT, "package.json"), "utf-8"),
  ) as {
    version: string;
  };
  const id = `${pkg.version}-${hashTree(HAS_SKILLS ? [SKILLS] : [KIT]).slice(0, 10)}`;
  const runtime = path.join(RUNTIME_HOME, id);
  if (existsSync(path.join(runtime, RUNTIME_MARKER))) {
    console.log(`Runtime: ${runtime} (ready)`);
    return runtime;
  }

  console.log(`Runtime: building ${runtime}`);
  rmSync(runtime, { recursive: true, force: true });
  mkdirSync(runtime, { recursive: true });
  for (const entry of readdirSync(KIT)) {
    if (entry === "node_modules") continue;
    cpSync(path.join(KIT, entry), path.join(runtime, entry), {
      recursive: true,
    });
  }
  // The skills without the kit itself (the runtime root already is the kit).
  if (HAS_SKILLS)
    cpSync(SKILLS, path.join(runtime, "skills"), {
      recursive: true,
      filter: (source) =>
        source !== KIT && !source.startsWith(`${KIT}${path.sep}`),
    });

  console.log(
    "Installing dependencies (Playwright, canvas) once for this version...",
  );
  const ci = existsSync(path.join(runtime, "package-lock.json"));
  const npm = spawnSync(
    "npm",
    [
      ci ? "ci" : "install",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
    ],
    { cwd: runtime, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (npm.status !== 0) fail(`npm failed in ${runtime}`);
  writeFileSync(
    path.join(runtime, RUNTIME_MARKER),
    `${JSON.stringify({ id, builtAt: new Date().toISOString(), from: KIT }, null, 2)}\n`,
  );
  pruneRuntimes(runtime);
  return runtime;
}

/** Keeps the newest few runtimes; older ones are no longer linked by anyone up to date. */
function pruneRuntimes(current: string): void {
  const all = readdirSync(RUNTIME_HOME)
    .map((name) => path.join(RUNTIME_HOME, name))
    .filter(
      (dir) => dir !== current && existsSync(path.join(dir, RUNTIME_MARKER)),
    )
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const old of all.slice(KEEP_RUNTIMES - 1))
    rmSync(old, { recursive: true, force: true });
}

/** Creates the recording folder from the templates; existing files are kept. */
function scaffold(runtime: string): void {
  const templates = path.join(runtime, "templates", "project");
  const root = process.cwd();
  const values: Record<string, string> = {
    APP_NAME: args.name ?? packageName(root) ?? path.basename(root),
    BASE_URL: args["base-url"] ?? "http://localhost:3000",
    KIT: "./.kit",
    DIR: rel(projectDir),
  };
  console.log(`Recording folder: ${rel(projectDir)}`);
  for (const file of walk(templates)) {
    const target = path.join(
      projectDir,
      path.relative(templates, file).replace(/\.tmpl$/, ""),
    );
    if (existsSync(target) && !args.force) continue;
    mkdirSync(path.dirname(target), { recursive: true });
    const text = readFileSync(file, "utf-8").replace(
      /\{\{([A-Z_]+)\}\}/g,
      (match: string, key: string) => values[key] ?? match,
    );
    writeFileSync(target, text);
    console.log(`  created  ${rel(target)}`);
  }
}

/** Points <recording folder>/.kit at the runtime and keeps it out of git. */
function link(runtime: string): void {
  const kitLink = path.join(projectDir, ".kit");
  let current: string | null = null;
  try {
    current = lstatSync(kitLink).isSymbolicLink()
      ? readlinkSync(kitLink)
      : "not-a-link";
  } catch {
    current = null;
  }
  if (current === "not-a-link") {
    fail(
      `${rel(kitLink)} exists and is not a link; remove it and run setup again.`,
    );
  }
  if (current !== runtime) {
    // unlinkSync, not rmSync: Node 24's rmSync refuses a link to a directory.
    if (current !== null) unlinkSync(kitLink);
    symlinkSync(
      runtime,
      kitLink,
      process.platform === "win32" ? "junction" : "dir",
    );
    console.log(`  linked   ${rel(kitLink)} -> ${runtime}`);
  }
  const ignore = path.join(projectDir, ".gitignore");
  const lines = existsSync(ignore)
    ? readFileSync(ignore, "utf-8").split("\n")
    : [];
  if (
    !lines.some((line) => line.trim() === ".kit" || line.trim() === ".kit/")
  ) {
    appendFileSync(
      ignore,
      `${lines.length && lines.at(-1) !== "" ? "\n" : ""}# Runcast runtime link\n.kit\n`,
    );
  }
}

/** Copy mode (tools without the plugin): skills into the folders those tools read. */
function copySkills(runtime: string, dirs: Array<string>): void {
  const source = path.join(runtime, "skills");
  for (const dir of dirs) {
    for (const skill of readdirSync(source)) {
      const target = path.join(process.cwd(), dir, skill);
      rmSync(target, { recursive: true, force: true });
      cpSync(path.join(source, skill), target, { recursive: true });
    }
    console.log(`  skills   ${dir}/`);
  }
}

// --- doctor ----------------------------------------------------------------------

function doctor(): void {
  const runtime = linkedRuntime();
  const check = (ok: boolean, label: string, fix: string) =>
    console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : `  →  ${fix}`}`);
  check(
    Number(process.versions.node.split(".")[0]) >= 23 ||
      (process.versions.node.startsWith("22.") &&
        Number(process.versions.node.split(".")[1]) >= 18),
    `Node ${process.versions.node}`,
    "Node 22.18 or newer",
  );
  check(
    existsSync(path.join(projectDir, "recording.config.ts")),
    `Recording folder ${rel(projectDir)}`,
    "run setup",
  );
  check(runtime !== null, "Runtime linked (.kit)", "run setup");
  check(
    has("ffmpeg", ["-version"]),
    "ffmpeg (video, narration)",
    installHint("ffmpeg"),
  );
  if (process.platform === "linux") {
    check(
      Boolean(process.env.DISPLAY) || has("Xvfb", ["-help"]),
      "Display or Xvfb (video on Linux)",
      installHint("xvfb"),
    );
  }
  const channel = process.env.REC_CHANNEL ?? "chrome";
  if (channel === "chrome") {
    check(
      chromeInstalled(),
      "Google Chrome",
      "install Chrome, or set REC_CHANNEL=chromium and run: node .kit/node_modules/@playwright/test/cli.js install chromium",
    );
  }
  check(
    existsSync(path.join(projectDir, ".env.local")),
    ".env.local (account, keys)",
    `copy ${rel(path.join(projectDir, ".env.example"))} to .env.local`,
  );
  if (process.platform === "darwin") {
    console.log(
      "  macOS video needs Screen Recording permission for the app that runs the command (asked on first recording).",
    );
  }
}

// --- running -----------------------------------------------------------------------

function linkedRuntime(): string | null {
  try {
    const real = realpathSync(path.join(projectDir, ".kit"));
    return existsSync(path.join(real, RUNTIME_MARKER)) ? real : null;
  } catch {
    return null;
  }
}

function requireRuntime(): string {
  const runtime = linkedRuntime();
  if (!runtime)
    fail(`${rel(projectDir)} is not set up: run setup first (it links .kit).`);
  return runtime;
}

function playwright(mode: "test" | "rehearsal", extra: Array<string>): never {
  const runtime = requireRuntime();
  const cli = path.join(
    runtime,
    "node_modules",
    "@playwright",
    "test",
    "cli.js",
  );
  run(process.execPath, [cli, "test", "-c", projectDir, ...extra], {
    REC_MODE: mode,
  });
}

function script(parts: Array<string>, extra: Array<string>): never {
  const runtime = requireRuntime();
  run(process.execPath, [path.join(runtime, ...parts), ...extra], {});
}

function run(
  file: string,
  argv: Array<string>,
  env: Record<string, string>,
): never {
  const result = spawnSync(file, argv, {
    stdio: "inherit",
    env: { ...process.env, REC_PROJECT: projectDir, ...env },
  });
  process.exit(result.status ?? 1);
}

// --- helpers -----------------------------------------------------------------------

/** The kit's own options; everything else passes through to the command. */
function parseArgs(list: Array<string>): {
  options: Record<string, string | undefined>;
  rest: Array<string>;
} {
  const known = new Set(["dir", "name", "base-url", "skills", "force"]);
  const options: Record<string, string | undefined> = {};
  const rest: Array<string> = [];
  for (let i = 0; i < list.length; i++) {
    const arg = list[i] ?? "";
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    const key = match?.[1];
    if (!match || !key || !known.has(key)) {
      rest.push(arg);
      continue;
    }
    const inline = match.at(2);
    if (inline !== undefined) options[key] = inline;
    else if (key === "force") options[key] = "true";
    else options[key] = list[++i];
  }
  return { options, rest };
}

function hashTree(roots: Array<string>): string {
  const hash = createHash("sha256");
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const file of walk(root).sort()) {
      if (file.includes(`${path.sep}node_modules${path.sep}`)) continue;
      hash.update(path.relative(root, file));
      hash.update(readFileSync(file));
    }
  }
  return hash.digest("hex");
}

function walk(folder: string): Array<string> {
  return readdirSync(folder).flatMap((name) => {
    if (name === "node_modules" || name === ".git") return [];
    const file = path.join(folder, name);
    return statSync(file).isDirectory() ? walk(file) : [file];
  });
}

function packageName(root: string): string | undefined {
  try {
    return (
      JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8")) as {
        name?: string;
      }
    ).name;
  } catch {
    return undefined;
  }
}

function has(cmd: string, argv: Array<string>): boolean {
  try {
    execFileSync(cmd, argv, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function chromeInstalled(): boolean {
  if (process.platform === "darwin") {
    return (
      existsSync("/Applications/Google Chrome.app") ||
      existsSync(path.join(homedir(), "Applications", "Google Chrome.app"))
    );
  }
  if (process.platform === "linux")
    return (
      has("google-chrome", ["--version"]) ||
      has("google-chrome-stable", ["--version"])
    );
  return true; // Windows: let Playwright report it
}

function installHint(tool: string): string {
  if (process.platform === "darwin") return `brew install ${tool}`;
  if (process.platform === "linux") return `apt install ${tool}`;
  return `install ${tool}`;
}

function rel(file: string): string {
  return path.relative(process.cwd(), file) || ".";
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
