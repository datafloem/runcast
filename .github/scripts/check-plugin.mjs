// Checks that the plugin's manifests, marketplaces and skills agree.
// Run from the repository root: node .github/scripts/check-plugin.mjs
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const PLUGIN = "plugins/runcast";
const SKILLS = `${PLUGIN}/skills`;
const KIT = `${SKILLS}/runcast-setup/kit`;
const errors = [];

const fail = (message) => errors.push(message);
const json = (file) => {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, file), "utf-8"));
  } catch (error) {
    fail(`${file}: ${error.message}`);
    return {};
  }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Manifests: Claude Code and agent-plugins.org must describe the same plugin.
const claude = json(`${PLUGIN}/.claude-plugin/plugin.json`);
const agents = json(`${PLUGIN}/plugin.json`);
const kit = json(`${KIT}/package.json`);
for (const field of ["name", "version", "description", "author", "homepage", "repository", "license", "keywords"]) {
  if (!same(claude[field], agents[field])) {
    fail(`"${field}" differs between ${PLUGIN}/.claude-plugin/plugin.json and ${PLUGIN}/plugin.json`);
  }
}
if (kit.version !== claude.version) {
  fail(`${KIT}/package.json version ${kit.version} != plugin version ${claude.version}`);
}
if (kit.license !== claude.license) {
  fail(`${KIT}/package.json license ${kit.license} != plugin license ${claude.license}`);
}

// Marketplaces: same name, and both list this plugin at its folder.
const claudeMarket = json(".claude-plugin/marketplace.json");
const codexMarket = json(".agents/plugins/marketplace.json");
if (claudeMarket.name !== codexMarket.name) {
  fail(`marketplace names differ: "${claudeMarket.name}" vs "${codexMarket.name}"`);
}
const claudeEntry = claudeMarket.plugins?.find((p) => p.name === claude.name);
const codexEntry = codexMarket.plugins?.find((p) => p.name === claude.name);
if (!claudeEntry) fail(`.claude-plugin/marketplace.json does not list "${claude.name}"`);
else if (path.normalize(claudeEntry.source) !== path.normalize(`./${PLUGIN}`)) {
  fail(`.claude-plugin/marketplace.json source is ${claudeEntry.source}, expected ./${PLUGIN}`);
}
if (!codexEntry) fail(`.agents/plugins/marketplace.json does not list "${claude.name}"`);
else if (path.normalize(codexEntry.source?.path ?? "") !== path.normalize(`./${PLUGIN}`)) {
  fail(`.agents/plugins/marketplace.json path is ${codexEntry.source?.path}, expected ./${PLUGIN}`);
}

// Skills: each folder has a SKILL.md whose name matches the folder.
const skillDirs = readdirSync(path.join(ROOT, SKILLS)).filter((d) =>
  statSync(path.join(ROOT, SKILLS, d)).isDirectory(),
);
for (const dir of skillDirs) {
  const file = `${SKILLS}/${dir}/SKILL.md`;
  if (!existsSync(path.join(ROOT, file))) {
    fail(`${file} is missing`);
    continue;
  }
  const front = readFileSync(path.join(ROOT, file), "utf-8").match(/^---\n([\s\S]*?)\n---/);
  if (!front) {
    fail(`${file}: no front matter`);
    continue;
  }
  const name = front[1].match(/^name:\s*(.+)$/m)?.[1].trim();
  const description = front[1].match(/^description:\s*(.+)$/m)?.[1].trim();
  if (name !== dir) fail(`${file}: name "${name}" should be "${dir}"`);
  if (!description) fail(`${file}: description is missing`);
  if (!dir.startsWith(`${claude.name}-`)) fail(`${file}: skill folders start with "${claude.name}-"`);
}

// Docs and skills users follow: projects install nothing, so no bare
// "npx playwright". (AGENTS.md and CONTRIBUTING.md state the rule itself.)
const walk = (dir) =>
  readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.name === "node_modules" || entry.name.startsWith(".git")) return [];
    return entry.isDirectory() ? walk(rel) : [rel];
  });
const docs = [...walk(PLUGIN), "README.md"].filter((f) =>
  /\.(md|tmpl)$/.test(f),
);
for (const file of docs) {
  readFileSync(path.join(ROOT, file), "utf-8")
    .split("\n")
    .forEach((line, i) => {
      if (/\bnpx\s+playwright\b/.test(line)) {
        fail(`${file}:${i + 1}: use <recording folder>/.kit/cli.ts instead of "npx playwright"`);
      }
    });
}

if (errors.length) {
  console.error(`Plugin check failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  process.exit(1);
}
console.log(`Plugin check passed: ${claude.name} ${claude.version}, ${skillDirs.length} skills, ${docs.length} docs.`);
