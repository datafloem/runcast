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

## 0. Source code or live site

Look for the app's source in the workspace yourself (a web app's package or
build files, routes, pages); do not ask about it. If you find it, go on with
step 1 and study the code in step 2.

If you find none, say so ("I found no source code for a web app here") and
confirm that the user wants to record a live site (a customer's or partner's
app, say). The project's source is then **live site**, and:

1. **Address.** Ask for the URL a visitor opens, e.g. `https://app.example.com`
   or `https://example.com/app/`. The base URL is its origin plus any base
   path; a deeper path (a dashboard, the sign-in page) is the first page to
   explore. Ask whether it is the live site or a test environment, and for
   the app's name if the address or page title does not make it clear.
2. **Permission.** Always ask: "Are you allowed to record this site and
   publish videos of it?" Stop unless the answer is yes. Write who
   confirmed it, for which site, and the date in `PROJECT.md` > "Source".
3. **Folder.** Ask where the recording folder should go (no default for a
   live site), run setup with `--dir <that folder>` (step 1), then check the
   address with `node <folder>/.kit/cli.ts explore <first page> --no-session`.
   If it does not load (DNS, TLS, a VPN, a block page), tell the user what
   happened and ask for a working address.
4. **Sign-in.** The run above says whether the page landed on a sign-in page.
   - A sign-in a scenario can do (a username and password form): explore the
     sign-in page, write `helpers/auth.ts` from its controls, run
     `test login`, then `node <folder>/.kit/cli.ts session` and set
     `REC_SESSION=1` in `.env.local`.
   - A sign-in only a person can do (SSO, two-factor, a captcha; never try
     to get past one): delete `scenarios/login.spec.ts`, `helpers/auth.ts`,
     `steps/auth.ts` and their exports in `helpers/index.ts` and
     `steps/index.ts`, copy `.kit/templates/session/start.spec.ts.tmpl` to
     `scenarios/start.spec.ts`, and ask the user to run
     `node <folder>/.kit/cli.ts session --manual` ("a Chrome window opens;
     sign in, then close the window"). Then set `REC_SESSION=1` and run
     `test start`.
5. **Study the site** (instead of step 2's code reading):
   `node <folder>/.kit/cli.ts explore --crawl --mobile`, then fill
   `PROJECT.md` from `.explore/summary.md` and `.explore/pages/<page>/`
   (`page.json`: controls, links, hooks, storage keys, brand; `aria.yml`:
   the page's roles and names; `screenshot.png`). Explore is read-only and
   hides displayed data (table cells, data rows, record titles) as `…`;
   screenshots are not redacted, so do not paste them anywhere. Ask the user
   for what explore cannot show: roles, which records are safe to change,
   the demo account's limits. With the user's OK, make this run the
   baseline: `explore --accept`, and remind them to commit
   `explore/site.json`.

Then write the project layer (step 3) and verify (step 4) as for any app.

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
  shows whether the flow still works at 540×960.
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
4. Offer a short video check: `node <recording folder>/.kit/cli.ts video login --render`
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

For a live site, the routine is:

1. `node <folder>/.kit/cli.ts explore --diff`: explores every page in the
   baseline (`explore/site.json`) and lists what changed: pages gone or
   redirecting, controls added, removed or renamed, test hooks removed,
   headings and menu links changed. Show the user the list.
2. Fix the affected helpers and `PROJECT.md` sections, then run every
   scenario in test mode.
3. With the user's OK, `explore --accept` updates the baseline; the user
   commits it with the fixes. If `test` fails with "the saved session has
   expired", save it again (`session`, or `session --manual` by the user).
