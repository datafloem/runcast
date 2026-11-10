# Runcast

Turns Playwright flows through a web app into **finished demo videos** and,
from the same code, **end-to-end tests**. No video editing: the app's tab in
a headless Chrome is recorded while a virtual cursor works at a person's
pace (nothing opens on screen, so the computer stays free), then the kit
renders an MP4 with a calm camera, a drawn cursor with click ripples, a
framed 1920×1080 layout (or 1080×1920 for YouTube Shorts and Instagram
Reels), and optionally captions, title cards, blurred fields and an
ElevenLabs voice-over fitted to the steps when rendering.

It is app-agnostic. An app adds a **recording folder** (default
`tests/recording/`) with its own config, helpers, steps, scenarios and
`PROJECT.md`; AI assistants plan and write scenarios with the kit's skills.

> **AI assistants:** if the project has no `recording.config.ts` yet, follow
> the `runcast-setup` skill.

## Contents

| Path                                | What                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `cli.ts`                            | The one command line: `setup`, `doctor`, `test`, `rehearsal`, `video`, `render`, `scene`, `narration`, `youtube` |
| `core/`                             | The engine: `rec` (cursor, capture, modes), `scenario()`, project and Playwright config                 |
| `scripts/video/`                    | Recording run (`run.ts`), renderer (`render.ts`), camera (`timeline.ts`)                                |
| `scripts/scene.ts`                  | A scene alone: `scene preview` (draft + beats sheet) and `scene render` (MP4, GIF)                      |
| `scripts/narration.ts`              | Voice-over tools: plan, generate (ElevenLabs), measure, single-take script and split                    |
| `scripts/youtube.ts`                | YouTube upload: sign-in (OAuth) and resumable upload with metadata                                      |
| `templates/project/`                | The recording folder a project starts from                                                              |
| `test/linux/`                       | Self-test on Linux in a container                                                                       |
| `../../` (`skills/` in the runtime) | AI skills: `runcast-setup`, `runcast-plan`, `runcast-scenario`, `runcast-scene`, `runcast-publish`      |

## Requirements

- Node 22.18+ (runs TypeScript directly) and Google Chrome (or Playwright's
  Chromium with `REC_CHANNEL=chromium`). Playwright and canvas come with the
  kit's runtime; the project installs nothing.
- Video mode and the narration tools: `ffmpeg` (`brew install ffmpeg`,
  `apt install ffmpeg`, `winget install Gyan.FFmpeg`). Video records a
  headless Chrome tab (`REC_CAPTURE=tab`, the default): no permission, no
  display, the same on macOS, Linux, Windows and CI.
- Screen capture (`REC_CAPTURE=screen`, only for flows that must show real OS
  dialogs) records a visible Chrome window with ffmpeg instead:
  - **macOS:** Screen Recording permission for the app that runs the command
    (System Settings > Privacy & Security > Screen Recording).
  - **Linux:** `xvfb` too (e.g. `apt install ffmpeg xvfb`). Without a
    screen (CI, servers, containers) the kit starts an Xvfb display of
    `REC_XVFB_SIZE` (default 1920x1080) itself, at `REC_XVFB_SCALE` (1, or
    2 for Retina-sharp video at four times the pixels); with a desktop session it
    records `DISPLAY` (X11; under Wayland run it with `xvfb-run`). On ARM
    Linux there is no Google Chrome: `REC_CHANNEL=chromium` and
    `node <recording folder>/.kit/node_modules/@playwright/test/cli.js install chromium`.
  - **Windows 10/11:** ffmpeg 6 or newer.
    Screen capture records the page area of the main screen with ffmpeg's `ddagrab`
    (Desktop Duplication, physical pixels, so display scaling is fine) and
    falls back to `gdigrab` when that can't start; `REC_WIN_GRABBER` picks
    one. Keep the desktop signed in and unlocked while it records.
- Test and rehearsal modes run anywhere, CI included.

## Adding it to a project

Install the plugin (see the repository's README for Claude Code, Codex and
Antigravity), or copy the plugin folder (`plugins/runcast/`) somewhere
and use its `skills/runcast-setup/kit/cli.ts`. Then ask your AI assistant to **set up recordings** (the
`runcast-setup` skill), or run setup yourself from the project root:

```bash
node <plugin>/skills/runcast-setup/kit/cli.ts setup --dir tests/recording --name "My App" --base-url http://localhost:3000
```

Setup:

1. builds the **runtime** once per kit version: the kit, its skills and its
   npm dependencies in `~/.cache/runcast/<version>-<hash>/`
   (`REC_KIT_HOME` moves it);
2. creates the **recording folder** from `templates/project/`, keeping files
   that exist;
3. links `<recording folder>/.kit` to the runtime and adds `.kit` to the
   folder's `.gitignore`;
4. runs `doctor`: what is installed, what is missing.

Without the plugin, add `--skills .claude/skills,.agents/skills` to copy the
skills where Claude Code, Codex and other Agent Skills tools find them.

The AI then reads the app's code and fills in `recording.config.ts`, the login
helper and step, and `PROJECT.md` (screen map, forms, selectors, known
behaviours), and runs the login scenario. Plan the first video with "plan a
new demo video" (`runcast-plan`).

Everything else runs through the link: `node tests/recording/.kit/cli.ts <command>`.
A project may add npm scripts for these, but needs none.

### Updating the kit

Update the plugin (or replace the copied folder) and run `setup` again: it
builds the new runtime, relinks `.kit`, keeps the newest three runtimes and
every runtime another project's `.kit` still links to (listed in the
runtime's `.links.json`), and never overwrites the project's own files. After a fresh clone of a project,
`setup` restores the `.kit` link.

What changes for existing projects when they update to the version with
tab capture:

- **Video records a headless tab** (`REC_CAPTURE=tab`): the page is
  `REC_PAGE_SIZE` (1920×1080, drawn at `REC_SCALE` 1.5) instead of the
  screen's size, in tests too.
  Set `REC_CAPTURE=screen` to keep recording the screen.
- **Browser dialogs are accepted by default** in every mode (Playwright used
  to dismiss them when nothing listened). A test that relied on a dismissed
  `confirm()` sets `scenario({ dialogs: "dismiss" })` or
  `rec.onDialog({ accept: false })` before the action; a step that listens
  for dialogs itself (`page.on("dialog")`) still answers them itself.
- **`steps.scene`**: add `scene` to the `export { hold } from "../kit.ts"`
  line of `steps/index.ts` (new projects have it). Scenes are now added when
  rendering, not played during the take (`live: true` keeps playing them);
  a take recorded before this renders as it was.
- **Coming from 0.1.x:** since 0.2.0 every step factory takes `show` (the
  camera's focus). A project step that has its own `show` option no longer
  type-checks; rename it (e.g. `options: StepOptions & { browse?: string[] }`)
  or leave the kit's out (`Omit<StepOptions, "show"> & { show?: string[] }`).
- **Page size:** the default page is now 1920×1080 at 1.5 (a 2880×1620
  video); set `REC_PAGE_WIDTH` / `REC_SCALE` to match an old screen, e.g.
  `REC_PAGE_WIDTH=1800` and `REC_SCALE=1.68` (`doctor` prints the values
  from the newest screen recording).

## Project layout

```
tests/recording/
  recording.config.ts   app name, base URL, locale, start-up localStorage, colour scheme, brand
  playwright.config.ts  definePlaywrightConfig(project), nothing else
  kit.ts                re-exports the kit (and Playwright types) from .kit
  .kit                  link to the kit's runtime, made by setup (gitignored)
  PROJECT.md            what scenarios need to know about the app
  AGENTS.md, CLAUDE.md  entry point for AI assistants
  helpers/              screen operations (selectors, the app's quirks)
  steps/                reusable steps that check their result
  scenarios/            <name>.md (text), <name>.spec.ts (test), <name>.narration.json
  .env.local            settings and secrets (gitignored); .env.example lists them
  .captures/            latest video recording per scenario (gitignored)
  .results/ videos/ narration/   output (gitignored)
```

`recording.config.ts`:

```ts
import { defineProject, loadProjectEnv } from "./.kit/core/project.ts";

loadProjectEnv(import.meta.dirname); // .env.local first

export default defineProject({
  dir: import.meta.dirname,
  name: "My App",
  baseURL: process.env.APP_BASE_URL ?? "http://localhost:3000",
  locale: "en-US", // scenarios find controls by labels in this locale
  localStorage: { theme: JSON.stringify("dark") }, // written before the first page load
  colorScheme: "dark",
  brand: { color: "#f97316", logo: "../../public/logo.svg" }, // logo relative to this folder
});
```

The CLI takes the recording folder from `--dir`, else `REC_PROJECT`, else
`tests/recording` under the working directory.

## Modes

| Mode      | Command                                      | What                                                                                    |
| --------- | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| Video     | `node tests/recording/.kit/cli.ts video`     | Records the app's tab in a headless Chrome, then checks the take (`render --check`); `--render` (or `REC_RENDER=full`) renders `videos/<scenario>.mp4` right away. Any OS and CI |
| Rehearsal | `node tests/recording/.kit/cli.ts rehearsal` | The video's pace, headless and not recorded. Measures step lengths before the first video |
| Test      | `node tests/recording/.kit/cli.ts test`      | Headless, Playwright's own clicks, no pauses. Any OS and CI; HTML report in `.report/`  |

`REC_MODE` selects the mode (the CLI sets it). Scenarios, steps and
helpers are the same in all modes; only `rec` behaves differently.

Add a scenario name to run one: `node tests/recording/.kit/cli.ts test login`.

## Video

1. A headless Chrome runs the scenario with the page at a fixed size,
   `REC_PAGE_SIZE` (default 1920×1080; format `"vertical"`: 540×960), drawn
   at `REC_SCALE` (default 1.5, so 2880×1620 video pixels for the camera to
   zoom into; a vertical page gives 810×1440, `REC_SCALE=2` makes it
   1080×1920). A second tab, the kit's recorder (`core/recorder.html`, a local
   page), records the app's tab with Chrome's own tab capture at up to 30 fps
   (`.captures/<scenario>/capture/screen.mp4`, or `.webm`); nothing opens on
   screen and the real cursor is never in it. Tests and rehearsals use the
   same page sizes. With `REC_CAPTURE=screen` Chrome instead fills the
   screen's usable area (format `"vertical"`: its full height, as wide as
   makes the page 9:16) and ffmpeg records that area at screen resolution
   (`capture/screen.mkv`). A virtual cursor moves inside the page, and every click,
   keystroke, hover and navigation is logged (`capture/events.json`).
   Recording runs fast: viewer pauses and cursor rests are cut short, cursor
   moves run three times faster and typing at 40 ms per character, each
   logged with its natural length, which the renderer plays them at
   (`REC_RECORD_PACE=natural` records at the viewer's pace).
2. `video` ends with `render --check` (below): one picture per step and the
   narration fit, in seconds, so a take that needs redoing costs no render.
   It prints the render command; `video --render` (or `REC_RENDER=full`)
   renders right away. The renderer produces the MP4:
   - **Camera:** calm. Actions on the same page without a long pause form a
     scene, framed once and held. Clustered actions get a gentle zoom (at most
     1.5×); spread-out or short scenes stay full view. `rec.show(locator)`, or
     a step's `show: "<selector>"`, frames an element without touching it
     (what the step wants the viewer to see) tightly, filling the frame (at
     most 3×), until the next action. The camera gets there by a `pan`
     (default), `slide`, `fade`, `cube` or `cut`: `scenario({ showTransition })`,
     or `show: { target, transition }` on one step. Tuning:
     `defaultCameraOptions` in `scripts/video/timeline.ts`.
   - **Cursor:** a drawn arrow, a ripple in the brand colour on clicks.
   - **Look:** 1920×1080, dark background with a brand glow, rounded framed
     page with a shadow.
   - **Format (optional):** `scenario({ format })` picks the video's shape:
     - `"landscape"` (default): 1920×1080, for YouTube, websites, slides.
     - `"vertical"`: 1080×1920. The page itself is 9:16 in every mode
       (540×960; a narrow window with screen capture), so the app shows its
       mobile layout. For apps that have one.
     - `"vertical-crop"`: 1080×1920 from a desktop recording. The camera
       shows a 9:16 slice of the page and follows the action.
     - `"vertical-fit"`: 1080×1920 with the whole desktop recording across
       the middle; captions and cards in the space around it.

     Vertical videos go to `videos/<scenario>-vertical.mp4`, so a landscape
     render is kept. Captions sit above the bottom fifth, which Shorts and
     Reels cover with their own title and buttons. One landscape recording
     gives both: `REC_FORMAT=vertical-crop node tests/recording/.kit/cli.ts render <scenario>`.
   - **Captions (optional):** `scenario({ captions: true })` shows each step's
     message while it lasts.
   - **App sound (optional):** `scenario({ appAudio: { volume, duckTo } })`
     mixes the app's own sound (games, media) under the voice-over: `volume`
     0–1 (default 1), lowered to `duckTo` of it (default 0.3) while a voice
     clip plays, with 200 ms ramps. Tab capture always records the tab's
     sound (kept off the speakers while recording); only 1:1 stretches of the video play it,
     held frames are silent and every join fades over 100 ms. The recording
     runs at the viewer's pace (sound cannot be stretched) and loading waits
     fitted to narration are cut, never sped up. `REC_APP_AUDIO=0/1`
     overrides the scenario.
   - **Title cards (optional):** `scenario({ intro: { title, subtitle }, outro: { ... } })`
     adds an opening card (cross-fades into the recording) and a closing card
     (fades in over the last frame) with the brand logo. Defaults 3 s / 4 s.
   - **Blur (optional):** `scenario({ blur: ['[name="email"]'] })` blurs
     matching fields in every mode once they hold a value: empty fields stay
     readable, the blur starts with the first typed character and covers
     prefilled values on later screens.
   - **Cube transition (optional):** a step created with
     `transition: "cube"` (every step factory takes it) is replaced in the
     video by a 3D cube turning from the page as the step starts to the page
     as the next one starts. Meant for steps that only move elsewhere, such as
     opening another area while it loads. The step lasts at least 1.2 s in
     video and rehearsal; tests ignore it.
   - **Voice-over:** fitted to the steps here, not while recording (see
     Voice-over).
   - **Scenes (optional):** `steps.scene({ name, transition, back })` shows an
     animation the AI designed (`scenes/<name>/index.html`, the
     `runcast-scene` skill) like the app: same frame and captions, reached
     by `transition` and left by `back` (each `fade` (default), `slide`,
     `cube`, `cut` or `lift`; `back` defaults to `transition`), no cursor
     over it; in `vertical-crop` it is shown whole, fitted across the
     middle, not cropped. **Scenes are added when rendering:** the take
     only checks the scene's contract in a page the video never shows and
     leaves a placeholder of its length, taking no recording time.
     `render` records the scene on its own into `.captures/scene-<name>/`
     when that recording is missing, the scene's files changed (a hash of
     its folder) or the page size differs, and uses the scene's current
     length and beats; so after changing or swapping a scene you only
     render again. A scene that opens the video, or follows another scene,
     starts straight on it (less than 0.6 s of app between them is
     dropped). Rehearsal counts the scene's length without playing it.
     `scene({ name, live: true })` plays it on the stage tab during the
     take instead (the earlier behaviour); takes recorded that way render
     as before. The page keeps a small contract
     (`window.runcastScene = { duration, beats: [{ id, at }], start() }`,
     no autoplay with `?record`, deterministic, local files, brand from
     `--runcast-brand` / `--runcast-logo`). Each beat is a step
     `<step id>.<beat id>` for the voice-over; a longer voice holds the
     beat's last frame and the scene is never shortened. Test mode checks
     the contract. On its own: `node tests/recording/.kit/cli.ts scene preview <name>`
     (a draft and a contact sheet of the beats, `.captures/scene-<name>/check/sheet.png`)
     and `scene render <name> [--gif] [--bare]` (`videos/scene-<name>.mp4`, a
     960 px GIF; `--bare`: the scene alone, without the video's background
     and frame, for articles and websites). Scene and stage pages cannot
     reach the network: the kit blocks every request they make.
3. Re-render without recording again: `node tests/recording/.kit/cli.ts render <scenario>`.
   Actions the camera does not show (a vertical crop too narrow for a
   scene) are printed as "Out of frame" and listed in `render-report.json`.
   - `--check`: no video. Each step's last frame, drawn as the video shows
     it, goes to `.captures/<scenario>/check/NN-<id>.png` and into one contact
     sheet, `check/sheet.png`, in seconds; the narration fit table is
     printed. Look here first.
   - `--draft`: half size, quick encode, to `videos/<name>.draft.mp4`.
   - `--steps 3-5` (or `--steps 4`): only those recorded steps, with their
     voice-over, no cards, to `videos/<name>.steps-3-5.mp4` (or the draft
     file with `--draft`).
   - Vertical videos keep their `-vertical` in these names:
     `videos/<name>-vertical.draft.mp4`, `videos/<name>-vertical.steps-3-5.mp4`.

While a tab is recorded you can go on using the computer: nothing of it
reaches the video. Screen capture is different: keep other windows off
Chrome and the mouse away from it; with several screens the window opens on
the main one, and `REC_SCREEN` picks the screen ffmpeg records.

## Starting from a step

Steps are numbered. `REC_FROM` / `REC_TO` (number or id) record only part of
a scenario; earlier steps run quickly and silently before the recording:

```bash
REC_FROM=7 node tests/recording/.kit/cli.ts video demo
REC_FROM=8 REC_TO=8 node tests/recording/.kit/cli.ts test demo   # try one step
```

A step in the middle can stay out of the video: `offCamera: true` (every step
factory takes it) runs it fast and silently, as before `REC_FROM`, and cuts
its time out; the video goes on with the next step after a short cross-fade.
For long waits and repeated work. Tests run it as usual.

Each step's time and message go to `steps.json`: in video mode next to the
recording, `.captures/<scenario>/`, which Playwright leaves alone (it empties
`.results/` on every run), so a recording stays until that scenario is
recorded again; rehearsals write `.results/<test>/steps.json`.

## Voice-over

A narration file next to the scenario, `scenarios/<name>.narration.json`, has
one text segment per recorded step (example:
`skills/runcast-plan/narration.example.json` in the runtime). It never changes
the recording: the renderer fits it, so a changed text needs new audio and a
new render, never a new recording. Each segment starts with its step; a voice
longer than its step (plus `gapMs`) holds the step's last frame; a step longer
than its voice loses time from its loading waits (each keeps at least 0.6 s,
sped up at most 4×, beyond that its middle is cut with a cross-fade), and what
is left is silence. Pauses, cursor moves and typing are never shortened.
`scenario({ compressWaits: false })` keeps real waiting time
(`REC_COMPRESS_WAITS=0/1` overrides it when rendering). The AI writes the text
to fit each step's word budget.

1. Steps' own lengths (writes to the backend): record once,
   `node tests/recording/.kit/cli.ts video <name>`, or, before any video,
   `node tests/recording/.kit/cli.ts rehearsal <name>`.
2. Fit report and word budgets: `node tests/recording/.kit/cli.ts narration plan <name>`
   (from the newest video, else the newest rehearsal).
3. Audio, one of:
   - **By command:** `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` in
     `.env.local`, then `node tests/recording/.kit/cli.ts narration generate <name>` (only changed
     segments; `--force` all, `--only=<step>` one).
   - **By hand:** save each segment as `narration/<name>/<NN>-<step id>.mp3`,
     then `node tests/recording/.kit/cli.ts narration measure <name>`.
   - **Single take** (voices the API cannot use, e.g. library voices on a free
     plan): `node tests/recording/.kit/cli.ts narration script <name>` writes
     `narration/<name>/full-text.txt`; generate it in the ElevenLabs web app
     with **Eleven Multilingual v2**, save `narration/<name>/full.mp3`, then
     `node tests/recording/.kit/cli.ts narration split <name>`.
4. Each audio command prints the voice's measured speaking rate; put it in
   the file's `wordsPerMinute` if it differs, so later budgets fit.
5. Check: `node tests/recording/.kit/cli.ts render <name> --check`. It
   prints a fit table per step (natural length, voice, frame held, wait
   shortened, silence left), also in `.captures/<name>/render-report.json`,
   and draws each step's last frame into `check/sheet.png`. Lengthen
   segments with long silence, shorten ones that hold a frame for long, then
   `render <name>` for the video.

Segments with step `intro` / `outro` are spoken over the title cards.

## Publishing to YouTube

Ask your AI assistant to upload a video (the `runcast-publish` skill): it
guides the one-time Google Cloud setup and drafts the metadata. By hand:

1. In Google Cloud: a project, **YouTube Data API v3** enabled, an OAuth
   consent screen (External; your account as a test user), and an OAuth
   client of type **Desktop app**. Save its JSON as
   `<recording folder>/.youtube/client_secret.json` (gitignored).
2. `node tests/recording/.kit/cli.ts youtube auth`: sign in in the browser once; the refresh token
   goes to `.youtube/token.json`. Apps left in Testing status must sign in
   again every 7 days.
3. Write `scenarios/<name>.youtube.json`:

   ```json
   {
     "title": "Create your first order in Example App",
     "description": "How to add a customer and place an order.",
     "tags": ["orders", "tutorial"],
     "categoryId": "28",
     "privacyStatus": "unlisted",
     "madeForKids": false,
     "language": "en",
     "thumbnailAt": 1.5
   }
   ```

4. `node tests/recording/.kit/cli.ts youtube upload <name>` uploads `videos/<name>.mp4` (else
   `videos/<name>-vertical.mp4`, or `video` in the file; a vertical video of
   at most 3 minutes becomes a Short), prints the link and stores it in the file as `result`. A
   second upload of the same scenario needs `--force`.

`node tests/recording/.kit/cli.ts youtube check` shows what is missing. YouTube allows about 100
uploads per day per Google Cloud project.

## Writing scenarios

Code has three layers; each job is written once:

| Layer    | Where                      | What                                                           |
| -------- | -------------------------- | -------------------------------------------------------------- |
| Scenario | `scenarios/<name>.spec.ts` | The order of steps and scenario-specific values. No other code |
| Step     | `steps/`                   | Reusable unit of work; checks its result                       |
| Helper   | `helpers/`                 | One screen operation; selectors live here                      |

```ts
import { scenario, test } from "../kit.ts";
import * as steps from "../steps/index.ts";

test(
  "demo: new customer",
  scenario({
    require: ["APP_USERNAME", "APP_PASSWORD"],
    steps: [
      steps.login({ note: "Sign in" }),
      steps.createCustomer({
        name: "Northwind Traders",
        email: "orders@northwind.example",
        note: "A new customer",
      }),
      steps.hold(),
    ],
  }),
);
```

Steps and helpers move through `rec`, never `page.click`:

- `rec.click`, `rec.hover`, `rec.doubleClick`, `rec.rightClick`,
  `rec.drag(from, to)`: the cursor travels there; the camera sees it.
- `spot(locator, x, y)`: a point inside an element (0–1), e.g. on a canvas.
- `rec.type`: clicks the field and types; `rec.typeSecret` for passwords,
  tokens and other secrets: set in the page (not through Playwright's
  keyboard, whose actions traces record), blurred on screen, and kept out
  of failure reports (`error-context.md`, traces). Secrets come from
  `.env.local`, never from the scenario's text.
- `rec.select(locator, label)`, `rec.pickDate(locator, "YYYY-MM-DD")`: a native
  select or date input (`datetime-local` takes `"YYYY-MM-DDTHH:MM"`; time,
  month and week inputs are refused with a message). The browser draws their lists outside the page, so
  in video and rehearsal the kit draws its own under the field (a list, a
  month grid; `core/native-ui.ts`) and the cursor clicks the entry; the
  value is set with Playwright. Test mode sets it directly. Never click a
  native select.
- `rec.chooseFiles(trigger, ["fixtures/orders.csv"], { transition })`: an
  upload through the app's file chooser. The click on `trigger` opens it; in
  video and rehearsal the **stage** (a second recorded tab of the same size)
  shows a file manager with the files, the cursor picks them and clicks
  Open, and the video goes back to the app (`transition`: `fade` default,
  `slide`, `cube`, `cut`, `lift`). Test mode sets the files directly.
- `rec.dropFiles(zone, ["fixtures/orders.csv"], { transition })`: a drag and
  drop from the desktop. The cursor grabs the files in the stage's file
  manager; the video draws their icon at the cursor while it carries them
  to the zone and goes back to the app with `transition` (default `lift`: the
  file manager shrinks and fades back, like a window going behind). The zone
  gets `dragenter`, `dragover` on the way and a `drop` with real `File`s.
  Test mode sends the three events. Relative paths are from the recording
  folder. With screen capture there is no stage: `chooseFiles` shows the
  click and sets the files, `dropFiles` carries the files from where the
  cursor is (no file manager, no icon).
- `rec.onStage(async (stage, mouse) => { ... }, transition)`: anything else
  the app's tab cannot show, played on the stage with its own cursor.
- `rec.onDialog({ accept, text })`: how a dialog opened by the next `rec`
  action is answered (it lapses, with a warning, if that action opens none);
  otherwise `scenario({ dialogs: "accept" | "dismiss" })` (default accept).
  A step that listens for dialogs itself (`page.once("dialog", ...)`) answers
  them itself, and the video draws its answer.
  The video holds the frame 1.5 s and draws the dialog (message, buttons)
  with the cursor clicking the answer; dialogs off camera add nothing.
- `scenario({ permissions })`: decided before the first page load, so a test
  never waits on a prompt: `["geolocation", ...]` allows them (Playwright's
  names), `{ geolocation: "allow", notifications: "block" }` picks each
  answer; a blocked request fails as Chrome fails it (location error 1,
  `"denied"`, `NotAllowedError`, `permissions.query` says `denied`). The
  kit wraps the APIs that make Chrome ask (geolocation, Notification,
  getUserMedia, clipboard reads; `core/permissions.ts`): the first request
  per permission and origin holds the frame 1.5 s on camera and the video
  draws Chrome's prompt ("<host> wants to", "Know your location", Allow
  while visiting the site / Allow this time / Never allow, or Block /
  Allow) with the cursor pressing the answer. Permissions the scenario does
  not name are left to the browser. Location needs a secure page
  (https or localhost), as in Chrome.
- `rec.download(target, { open, timeoutMs })`: clicks `target`, waits for
  the download (15 s) and returns the saved file's path, so the test can
  check what is in it: `.captures/<scenario>/downloads/` with the take, else
  the test's output folder (`.results/`, emptied by Playwright each run).
  On camera the video shows Chrome's download bubble at the top right (file
  icon, name, size, "Done", a tick) for about 3 s, while it goes on.
  `open: true` (or `{ ms }`, default 3000) then shows the file on the stage
  with `lift` both ways (`core/stage/file.html`): CSV/TSV as a table, text
  and JSON (pretty-printed) as text, images, PDF in Chrome's viewer, other
  files as their icon, name and size. Screen capture has no stage and skips
  `open` with a warning; test mode ignores it.
- `rec.pause(ms)`: time for the viewer to read (skipped in tests). Video
  mode records it short and holds the last frame; if the page still changes
  then (an animation, a video, a canvas) the pause is recorded in real time
  and a warning names the step.
- `rec.watch(ms)` (or `rec.pause(ms, { live: true })`): a pause while
  something moves on the page, always recorded in real time.
- `rec.show(locator, { ms, transition })`: points the camera at an element
  without touching it, until the next action (checks it is visible in tests).

Before every one of these, in every mode, `rec` scrolls the target into view
and checks that it can be shown: inside the visible page, not covered by
another element (a toast, a dialog, a sticky header), not animating in and
not moving. It waits up to 5 s for that, then fails the step naming the
problem ("covered by div.toast"), so a test run catches what would spoil the
video. Tests and rehearsals run at the video's page size (`REC_PAGE_SIZE`,
default 1920×1080; with screen capture, the newest landscape recording's,
printed at the start), so the app lays out as it will on camera.

The full rules are in the `runcast-scenario` skill (`skills/runcast-scenario/SKILL.md` in the runtime).

## Settings (`.env.local`)

| Setting                                     | Default            | What                                                           |
| ------------------------------------------- | ------------------ | -------------------------------------------------------------- |
| `REC_MODE`                                  | `test`             | `video`, `rehearsal` or `test` (the CLI commands set it)       |
| `REC_PROJECT`                               | `tests/recording`  | The recording folder, when `--dir` is not given                |
| `REC_KIT_HOME`                              | `~/.cache/runcast` | Where setup builds the kit's runtime                           |
| `REC_FROM`, `REC_TO`                        | first, last        | Recording starts / ends at this step (number or id)            |
| `REC_NARRATION`                             | `1`                | `0` ignores the narration file (warnings and render)           |
| `REC_RECORD_PACE`                           | `fast`             | Video: `fast` records pauses, rests and cursor moves short and the render restores their pace; `natural` records at the viewer's pace |
| `REC_COMPRESS_WAITS`                        | scenario           | `1` / `0`: shorten loading waits to fit narration when rendering (scenario `compressWaits`, default on) |
| `REC_CAPTIONS`                              | scenario           | `1` / `0` turns captions on / off when rendering               |
| `REC_APP_AUDIO`                             | scenario           | `1` / `0`: the app's own sound in the video on / off (scenario `appAudio`; tab capture) |
| `REC_FORMAT`                                | scenario           | Overrides the scenario's video format (recording and rendering) |
| `REC_END_HOLD_MS`                           | `2000`             | How long the last frame stays (video, rehearsal)               |
| `REC_AIM_MS`                                | `400`              | Cursor rest on a target before clicking (video, rehearsal)     |
| `REC_CAPTURE`                               | `tab`              | Video: `tab` records the app's tab in a headless Chrome; `screen` records a visible window with ffmpeg (for real OS dialogs) |
| `REC_PAGE_SIZE`                             | `1920x1080`        | Landscape page size in CSS pixels, in every mode (vertical: 540x960). Screen capture: tests take the newest landscape recording's |
| `REC_PAGE_WIDTH`                            | —                  | Instead of `REC_PAGE_SIZE`: that width at 16:9                  |
| `REC_SCALE`                                 | `1.5`              | Tab capture: video pixels per CSS pixel, 1 to 3 (1.5: 2880x1620 for 1920x1080; 2 for sharp vertical videos) |
| `REC_VIDEO_FPS`, `REC_SCREEN`               | `30`, auto         | Output frame rate; screen capture: ffmpeg's screen index (macOS; Windows `ddagrab`: `0` = main screen) |
| `REC_WIN_GRABBER`                           | auto               | Screen capture on Windows: `ddagrab` or `gdigrab`; auto tries `ddagrab` first |
| `REC_CAPTURE_OFFSET`                        | `0,0`              | Screen capture: moves the recorded area by `x,y` screen pixels, when a window frame shifts the page |
| `REC_CHANNEL`                               | `chrome`           | Browser: `chrome` (Google Chrome) or `chromium` (Playwright's) |
| `REC_XVFB_SIZE`                             | `1920x1080`        | Screen capture on Linux without a screen: the Xvfb page area, in CSS pixels |
| `REC_XVFB_SCALE`                            | `1`                | Screen capture on Linux without a screen: `2` draws the page at 2x, like Retina |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | —                  | For `node tests/recording/.kit/cli.ts narration generate`      |

The project adds its own (account, base URL, scenario values).

## Self-test on Linux

`test/linux/` checks the kit on Linux in a container: a sample app, a fresh
install from the templates, a narration split with ffmpeg, test mode, then
video mode twice, recording a headless tab and recording the screen on Xvfb,
with captions, blur, title cards, a `show`, an off-camera step and a cube
transition. From the
Runcast repository root:

```bash
docker build -f plugins/runcast/skills/runcast-setup/kit/test/linux/Dockerfile -t runcast-linux plugins/runcast
docker run --rm -v "$PWD/kit-linux-out:/out" runcast-linux
```

It ends with "Linux self-test passed"; each video with three of its frames
(`screen/`, `tab/`) and the captures land in `kit-linux-out/`. The same script runs outside a container:
`APP_DIR=<empty folder> PLUGIN_DIR=<plugin folder> OUT=<folder> bash <plugin folder>/skills/runcast-setup/kit/test/linux/run.sh`.

## Limits

- Tab capture needs Google Chrome (or Chromium) with tab capture by title
  (`--auto-select-tab-capture-source-by-title`); if a Chrome update drops
  it, `REC_CAPTURE=screen` still records. It cannot record popups or new
  tabs the app opens, nor real OS dialogs. Heavy WebGL pages can lose frames
  in headless Chrome's software rendering.
- Screen capture runs on macOS (ffmpeg avfoundation), Linux (ffmpeg x11grab,
  Xvfb when there is no screen) and Windows 10/11 (ffmpeg ddagrab or
  gdigrab, main screen only). Windows support is new and checked in CI with
  test and rehearsal runs; a CI video run is a smoke test only. On Linux the
  Xvfb display records at 1x by default. `REC_XVFB_SCALE=2` gives Retina-sharp
  text (same layout, four times the pixels); on a 4-CPU VM it delivered about
  29 instead of 30 frames per second (the drawn cursor stays smooth, page
  content can stutter briefly), and rendering takes longer.
- Screen capture: Chrome opens on the main screen at 100% zoom. Format
  `"vertical"` records a window as tall as the screen: about 560×990
  CSS pixels on a laptop. A Retina or 4K screen gives a sharp 1080×1920
  video; a 1x screen is upscaled about two times. On Linux without a screen use
  `REC_XVFB_SCALE=2`.
