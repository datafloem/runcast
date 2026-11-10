---
name: runcast-setup
description: Sets up Runcast in a web app project, or refreshes it — installs the kit, studies the app's code (routes, forms, labels, sign-in, start-up state, brand) and writes the project's recording.config.ts, login helper and step, a login scenario and PROJECT.md (screen map, known forms, selectors, known behaviours, helper and step catalogs), then verifies it with a test run. Use when someone adds Runcast to a project, says "set up recordings / demo videos / e2e recordings for this app", when PROJECT.md is missing or stale, or when the login or app structure changed.
---

# Setting up Runcast in a project

Runcast is app-agnostic: it records Playwright flows into demo
videos and runs them as tests. It comes as a plugin (Claude Code, Codex,
Antigravity) or as a copied folder (other tools); either way its runtime (the kit plus Playwright
and canvas) lives in a shared cache, not in the project. Each app
adds a **recording folder** (default `tests/recording/`) with what is specific
to it. This skill creates and maintains that folder. When it is done, the
`runcast-plan` and `runcast-scenario` skills can work on the app.

Talk with the user in their language; write code, comments and `PROJECT.md`
in English.

## 1. Install

1. **Find the kit's CLI**, `kit/cli.ts`:
   - as a plugin (Claude Code, Codex, Antigravity): in this skill's own folder,
     next to this `SKILL.md` (`<skill folder>/kit/cli.ts`); in Claude Code also
     `${CLAUDE_PLUGIN_ROOT}/skills/runcast-setup/kit/cli.ts`;
   - as a copied folder: wherever the user put the plugin (e.g.
     `tools/runcast/skills/runcast-setup/kit/cli.ts`); if there is
     none, ask the user to install the plugin or say where to copy it from;
   - in a project already set up: `<recording folder>/.kit/cli.ts` (skills
     copied with `--skills` have no `kit/` folder; use this one).
2. **Run setup** from the project root (it changes nothing outside the
   recording folder and the shared cache):
   `node <kit>/cli.ts setup --dir <recording folder> --name "<App>" --base-url <url>`.
   Ask only for what you cannot find: the recording folder (suggest
   `tests/recording`) and, if the dev URL is not in the code, the URL.
   - The first run builds the runtime in `~/.cache/runcast/` and
     installs Playwright and canvas there (a few hundred MB, once per kit
     version). Tell the user before running it.
   - It creates the recording folder from templates (existing files are
     kept), links `<recording folder>/.kit` to the runtime and adds `.kit` to
     the folder's `.gitignore`.
   - Without the plugin (copied folder), add
     `--skills .claude/skills,.agents/skills` so the user's AI tools find the
     skills.
3. **Doctor:** setup ends with `doctor` (also
   `node <recording folder>/.kit/cli.ts doctor`): Node 22.18+, ffmpeg (video,
   narration; Windows: `winget install Gyan.FFmpeg`), Xvfb on Linux without a
   screen (only for `REC_CAPTURE=screen`), Google Chrome (or
   `REC_CHANNEL=chromium`), `.env.local`. Ask before installing anything
   system-wide.

Run setup again after a kit update, or when `.kit` is missing (a fresh clone):
it relinks the runtime and never overwrites the project's own files.

## 2. Study the app

Read the code; ask the user only for what the code cannot tell. Note what you
find, it becomes `PROJECT.md`:

- **Stack and run:** framework, router, UI and form libraries; the dev command
  and URL (package.json scripts, the bundler config); how the backend is
  reached (proxy, mock server, VPN...).
- **Routes:** the route table or path constants → the screen map: areas, the
  records they hold, list pages and add/edit pages. Which screens need an
  admin.
- **Labels:** where UI texts live (i18n files) and in which locale tests should
  run; scenarios find controls by those labels.
- **Selectors:** what stable hooks the app has (`data-testid`, field `name`s,
  its own attributes, link targets).
- **Forms:** how a page leads to its form component, its fields, the
  validation schema (required fields, limits), and where saving navigates.
  Describe this as a method (section "Finding a screen's form"), plus a table
  of the forms planned scenarios will need.
- **Sign-in:** the login path, fields, submit button, where it lands after
  sign-in, SSO or extra steps. Never ask for a password in the chat: the user
  writes it to `.env.local`.
- **Start-up state:** what the app reads on start from localStorage, cookies
  or the system (theme, language, onboarding flags, banners). Seed what makes
  videos consistent through `localStorage` / `colorScheme` in
  `recording.config.ts`; ask the user which theme the videos should use.
- **Mobile layout:** whether the app has a narrow-screen layout, for vertical
  videos (Shorts, Reels). Signs of one: a viewport meta tag, `max-width` /
  `min-width` media queries or responsive classes (Tailwind `sm:` / `md:`, a
  UI library's breakpoint props) on the main layout, a mobile menu or
  drawer component. Signs against: a fixed `min-width` on the page, wide
  tables and sidebars without breakpoints, a note that only desktop is
  supported. Write the verdict with its evidence: "yes", "partly" (which
  screens) or "no". If a scenario exists, a `REC_FORMAT=vertical` test run
  shows whether the flow still works at 480×854.
- **Brand:** the accent colour and a logo file for the title cards (look in
  `public/`, assets, the theme or CSS variables). Confirm with the user.
- **Quirks:** pagination, lazy-loaded lists, redirects after saving, slow first
  loads, menus that start collapsed... Add each to "Known behaviours" as you
  find it.

## 3. Write the project layer

- `recording.config.ts`: `name`, `baseURL` (from a setting with a default),
  `locale`, `localStorage`, `colorScheme`, `brand`.
- `helpers/auth.ts`: `openLogin` and `login` with confirmed selectors; solve
  sign-in quirks there.
- `steps/auth.ts`: the `login` step (reads the account settings; rename
  `APP_USERNAME` / `APP_PASSWORD` if the project prefers its own prefix, in
  `.env.example` too).
- `scenarios/login.spec.ts`: the login scenario, the setup's smoke test.
- `PROJECT.md`: fill every TODO section from step 2. Keep it factual and
  short; tables over prose. Helper and step catalogs list what exists.
- `AGENTS.md`: the template is generic; add the project's own rules if any
  (e.g. "the backend needs the VPN").
- `.env.example`: every setting the project uses, with a comment.
- If the project lints or typechecks its folders, make sure the recording
  folder and the kit are covered (or excluded on purpose).

## 4. Verify

1. Typecheck: the project's own TypeScript if it has one
   (`npx tsc -p <recording folder> --noEmit`), otherwise
   `npx --yes -p typescript@5 tsc -p <recording folder> --noEmit` (the project
   needs no TypeScript of its own). Run the project's linter and formatter on
   the new files.
2. `node <recording folder>/.kit/cli.ts test --list` lists the login scenario.
3. Ask the user to put the account in `.env.local` and to start the app,
   then run `node <recording folder>/.kit/cli.ts test login`. Fix selectors until it passes.
4. Offer a short video check: `node <recording folder>/.kit/cli.ts video login`
   (needs ffmpeg; it records a headless Chrome tab, so nothing opens and the
   user can keep working; with `REC_CAPTURE=screen` macOS needs Screen
   Recording permission, Linux xvfb without a screen, Windows an unlocked
   desktop). On Windows, use PowerShell equivalents for shell commands (for
   example `Copy-Item` instead of `cp`). Look at
   a frame of `videos/login.mp4` (e.g. with ffmpeg) to check theme and brand.

## 5. Hand over

Tell the user what was created and what remains (TODOs, missing helpers), and
that new videos start with the `runcast-plan` skill ("plan a new
demo video").

## Keeping it current

Run this skill again when the app's sign-in, routes or start-up state change,
or when `PROJECT.md` no longer matches the code: update the affected sections
and helpers, then repeat step 4.
