# AGENTS.md — Runcast repository

For AI assistants changing the kit. To use the kit in an app, install the
plugin there instead (README).

- The kit is **app-agnostic**: nothing here may name an app, its screens,
  labels, URLs, colours or accounts. App knowledge belongs in each project's
  recording folder (`recording.config.ts`, `helpers/`, `steps/`, `PROJECT.md`).
  Examples in skills, READMEs, templates and code comments use one made-up
  app (customers and orders: `createCustomer`, `addOrder`, `[name="email"]`),
  never a real product. No workarounds for one app's quirks in the kit:
  those belong in that project's helpers and `PROJECT.md`.
- Commands in skills and docs must work in a project that installs nothing:
  run tools through `<recording folder>/.kit/cli.ts` (e.g. `test --list`),
  never a bare `npx playwright`; typecheck with the project's TypeScript or
  `npx --yes -p typescript@5 tsc`.
- One plugin for every tool: `plugins/runcast/` with
  `.claude-plugin/plugin.json` (Claude Code) and `plugin.json` (Codex and
  Antigravity, agent-plugins.org schema). Keep their fields in step. Skills are
  plain Agent Skills (`SKILL.md`).
- The kit lives in `skills/runcast-setup/kit/` (below: `kit/`), not at the
  plugin root: Antigravity installs only `plugin.json` and `skills/`, so
  anything outside a skill folder is lost. `runcast-setup` finds the CLI in
  its own folder (`kit/cli.ts`), because Codex and Antigravity have no
  documented plugin-path variable in skill content. The other skills use the
  project's `.kit` link only.
- `kit/cli.ts` is the only entry point (no dependencies). `setup` copies the
  kit to the root of the runtime (`~/.cache/runcast/<version>-<hash>/`)
  and the skills, without the kit, to its `skills/`, installs
  `kit/package.json` there, and links the project's `.kit` to it. Every other
  command runs from the runtime.
- Projects reach the kit only through `.kit`: their `kit.ts`,
  `recording.config.ts` and `playwright.config.ts`. Keep `core/index.ts` the
  public API (it also re-exports Playwright types); changing an export breaks
  every project.
- `core/project.ts` and `core/narration.ts` are loaded by plain Node scripts:
  no imports of other kit modules there, `.ts` extensions on relative imports
  everywhere. `core/mode.ts` reads settings when imported, so nothing that runs
  before a project's `.env.local` is loaded may import it.
- Templates end in `.tmpl` and use `{{APP_NAME}}`, `{{BASE_URL}}`, `{{KIT}}`
  (`./.kit`) and `{{DIR}}` (the recording folder from the repository root).
- When behaviour changes, update the skills, `kit/README.md`, the root
  `README.md` (written for someone new to the kit) and the templates with it.
  `plugins/runcast/README.md` is the Claude directory listing: keep its
  "What Runcast installs, sends and stores" section exact. Anything the kit
  downloads, contacts or writes that isn't listed there fails the directory's
  security scan.
  Everything is in English.
- Releases: bump `version` in `.claude-plugin/plugin.json`, `plugin.json` and
  `kit/package.json` together (users get a new runtime per version).
- Check: `npm install` once in `kit/`, then
  `node plugins/runcast/skills/runcast-setup/kit/node_modules/typescript/bin/tsc -p plugins/runcast/skills/runcast-setup/kit --noEmit`,
  then `node .github/scripts/check-plugin.mjs` (manifests, marketplaces,
  skills; CI runs both); set up a scratch project with
  `node plugins/runcast/skills/runcast-setup/kit/cli.ts setup` and run
  its login scenario. The Linux self-test (`kit/test/linux/`, kit README >
  "Self-test on Linux") is optional: run it only for Linux-specific changes
  (Xvfb, x11grab, Linux setup), and only where Docker or a Linux machine is
  available.
- Pull requests follow [CONTRIBUTING.md](CONTRIBUTING.md): branch
  `<type>/<lowercase-words>`, Conventional Commits title (CI checks both),
  one topic each, no version bump (releases only), squash merge. GitHub
  rules live in `.github/rulesets/`.
