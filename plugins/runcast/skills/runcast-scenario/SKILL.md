---
name: runcast-scenario
description: Writes or fixes a recording scenario with Runcast — a Playwright flow through a web app that runs as a fast end-to-end test or is recorded into a finished demo video (headless tab capture, virtual cursor, calm camera, captions, title cards, voice-over). Use when asked to add, change or debug a recording scenario, a demo video flow, a step or helper, or anything in the project's recording folder (default tests/recording/).
---

# Writing a recording scenario

A scenario walks through one flow of the app from start to finish, either as a
test (headless, fast) or as a demo video (the app's tab in a headless Chrome is
recorded and the kit renders a finished MP4 with camera moves, a drawn cursor, optional
captions, title cards and voice-over). The goal is a video that looks hand-made
and, from the same code, a reliable end-to-end test.

This file holds the rules for **writing** scenarios. The kit's guide is
`.kit/README.md` in the recording folder; the app-specific knowledge is in
the project's `PROJECT.md`.

## Find your way first

- **Recording folder**: the folder with `recording.config.ts` (default
  `tests/recording/`). Its `.kit` link points at the kit's runtime; if it is
  missing (a fresh clone), run the kit's `setup` (runcast-setup skill).
  Commands below use `node tests/recording/.kit/cli.ts`; use the project's
  own folder if it differs.
- **`PROJECT.md`** in the recording folder: the app's screens and records, known
  forms, selector conventions, known behaviours (quirks), and the catalogs of
  existing **helpers** and **steps**. Read it before writing anything. If it
  is missing, run the `runcast-setup` skill first.
- **Scenario text** `scenarios/<name>.md`: steps, durations, on-screen
  messages, settings. The test is that text in code; the two stay in sync. If a
  new scenario has no text yet, write it with the user using the
  `runcast-plan` skill, then come back here.
- **The app's own code**: confirm labels, field names and attributes there;
  never guess a selector.

## Layers

Code has three layers; each job is written **once**, in the lowest layer that
fits:

| Layer    | Where                      | What                                                                                             | Example                                                    |
| -------- | -------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Scenario | `scenarios/<name>.spec.ts` | The order of steps and scenario-specific values (names, on-screen messages). No other code       | `steps.login(...)`, `steps.createCustomer({ name, note })` |
| Step     | `steps/`                   | A reusable unit of work: does one thing and checks its result with `expect`. Shared by scenarios | `login()`, `createCustomer()`, `addOrder()`                |
| Helper   | `helpers/`                 | One screen operation; selectors and the app's quirks live here                                   | `pickOption`, `fillCustomerForm`, `openCustomer`           |

Below them is the kit (`.kit/core/`, read-only): `rec` (cursor, capture, modes),
`scenario()` (runs the steps), `mode` (video / rehearsal / test). Project code
imports the kit only through the recording folder's `kit.ts`.

A scenario looks like this:

```ts
import { scenario, test } from "../kit.ts";
import * as steps from "../steps/index.ts";

const env = (name: string, fallback = "") => process.env[name] ?? fallback;

test(
  "demo: first order",
  scenario({
    require: ["APP_USERNAME", "APP_PASSWORD"],
    steps: [
      steps.login({ note: "Sign in" }),
      steps.createCustomer({
        name: env("DEMO_CUSTOMER", "Northwind Traders"),
        email: env("DEMO_CUSTOMER_EMAIL", "orders@northwind.example"),
        note: "A new customer",
      }),
      // ...
      steps.hold({ note: "Done" }),
    ],
  }),
);
```

`scenario()` numbers every step, starts the recording at the right step and
shows each step separately in the Playwright report.

- **Start step:** `REC_FROM=<number or id>` starts the recording at that step;
  the ones before run fast and silently first (and create what later steps
  need). `REC_TO` stops after a step. So never delete login or setup steps to
  keep them out of the video: use `REC_FROM`. If a scenario is always recorded
  from the same step, make it the default with `scenario({ recordFrom: "<id>" })`;
  `REC_FROM` still wins.
- **Off camera (optional):** if the scenario text marks a step in the middle
  "off camera", pass `offCamera: true` to it (`steps.importOrders({ offCamera: true })`).
  It runs fast and silently, as the steps before `REC_FROM` do, and its time
  is cut out of the video; the video goes on with the next step after a short
  cross-fade. For long waits (an import, a report being built) and repeated
  work the viewer need not watch. It has no note, caption or voice-over.
  Pausing inside a step is not possible: split the step where the video
  should stop and start again. Tests run off-camera steps as usual.
- **Where the viewer looks (`show`):** the scenario text's "Focus" column
  becomes a step's `show: "<CSS selector>"` when the step's result is
  something to look at rather than click (`steps.login({ show: '[data-testid="stats"]' })`,
  `steps.hold({ ms: 3000, show: "main .cards" })`). The camera frames that
  element once the step is done (on `hold`: during the hold) until the next
  action, tightly: it fills the frame (with about 24 px around it, at most
  3×), in landscape and in `vertical-crop`. Pick the element that carries the
  message (one card, the new row, a total), not a whole page area: a wide
  element cannot be zoomed. The selector is checked in every mode, so a wrong
  one fails the test. In a helper, `await rec.show(locator, { ms, transition })`
  does the same at any point.
- **Show transitions (optional):** how the camera reaches a shown element.
  The scenario text's "Show transitions" becomes
  `scenario({ showTransition: "slide" })` (`pan` default, `slide`, `fade`,
  `cube`, `cut`); a step that differs passes
  `show: { target: "<selector>", transition: "cube" }`. Unlike a step's
  `transition: "cube"`, which hides the step, these only change how the view
  changes between two shown areas; the page keeps playing.
- **App sound (optional):** if the scenario text says "App sound: yes", pass
  `appAudio: { volume, duckTo }` (defaults 1 and 0.3). The app's own sound
  (always captured with the tab, never on the speakers) is mixed under the
  voice-over, lowered to `duckTo` while it speaks, and silent where the video
  holds a frame. The recording runs at the viewer's pace and loading waits
  are cut, never sped up. Try without it: `REC_APP_AUDIO=0 node tests/recording/.kit/cli.ts render <name>`.
  Sound the app plays without a click (autoplay) is allowed in video mode.
- **Captions (optional):** if the scenario text says "Captions: yes", pass
  `captions: true`; the renderer shows each step's `note` at the bottom while
  the step lasts. Try without re-recording:
  `REC_CAPTIONS=1 node tests/recording/.kit/cli.ts render <name>` (`0` = off).
- **Format (optional):** if the scenario text has "Format" other than
  landscape, pass `format: "vertical" | "vertical-crop" | "vertical-fit"`.
  The video is then 1080×1920 (`videos/<name>-vertical.mp4`).
  - `"vertical"` makes the page 9:16 before the first page load, in every mode
    (540×960), so the app runs in its **mobile layout**:
    navigation may sit behind a menu button, tables may become cards, some
    controls may be hidden. Write and check the helpers against that layout
    (run `test <name>` and look at the failure screenshots); if a helper must
    work in both layouts, branch on what is visible, not on the format.
  - `"vertical-crop"` and `"vertical-fit"` record the desktop page as usual;
    only the render changes. Crop shows a 9:16 slice that follows the
    action, so keep related actions close together on the page.
  - Try another vertical layout from a landscape recording without recording
    again: `REC_FORMAT=vertical-crop node tests/recording/.kit/cli.ts render <name>`.
    `"vertical"` needs a new `video` run (the page itself changes).
- **Title cards (optional):** if the text has "Cards", pass
  `intro: { title, subtitle?, durationMs? }` and/or `outro: { ... }`. The intro
  comes before the recording (brand background, logo, title, then a cross-fade
  into the first frame); the outro fades in over the last frame. Defaults 3 s /
  4 s; a narration segment `intro` / `outro` is spoken over its card and
  stretches it. Cards are drawn only when rendering; never draw them in the page.
- **Blur (optional):** if the text has "Blur", pass
  `blur: ['[name="email"]', ...]` (CSS selectors). Matching elements blur
  once they hold a value (an input's value, otherwise its text): an empty field
  stays readable, the blur starts with the first typed character and also
  covers prefilled values on later screens. Do not try to mask secrets at render time.
- **Transitions (optional):** if the text has "Transitions", pass
  `transition: "cube"` to that step (`steps.openOrders({ transition: "cube" })`).
  In the video the step is replaced by a cube that turns from the page as the
  step starts to the page as the next step starts; what the step does is not
  shown. So use it only on a step that moves somewhere else (opens another
  area, waits for a load), never on one whose clicks the viewer should follow;
  if a step does both, split it. In video and rehearsal the step lasts at
  least 1.2 s; test mode ignores it. It is stored in `steps.json` while
  recording, so adding or removing one needs a new `video` run, not only
  `render`.

## Modes

| Mode      | Command                                             | Notes                                                                                                                     |
| --------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| video     | `node tests/recording/.kit/cli.ts video <name>`     | Headless Chrome, the app's tab recorded by the kit's recorder tab, then the MP4. Any OS and CI; the user can keep working. `REC_CAPTURE=screen` records a visible window with ffmpeg instead (only for real OS dialogs; macOS needs Screen Recording permission, Linux Xvfb without a screen, Windows an unlocked desktop) |
| rehearsal | `node tests/recording/.kit/cli.ts rehearsal <name>` | The video's pace and timing, headless and not recorded. For measuring step lengths                                        |
| test      | `node tests/recording/.kit/cli.ts test <name>`      | Headless end-to-end, no pauses (the default mode)                                                                         |

In video mode the camera follows what `rec` logs:

- `rec.show(locator)` (or a step's `show`) frames an element without an
  action, as a scene of its own, until the next action or page change.
- With `vertical-crop` the camera follows: it frames every scene at least at
  zoom 1, and after a page change with nothing shown or clicked it looks at
  the top of the new page. Without `show`, a screen that is only looked at
  keeps the crop where the last click was: give such steps a `show`.
- The camera frames **scenes**, not single actions: actions on the same page
  without a pause longer than 3.5 s form one scene. It frames the scene once
  (all its actions, at most 1.5×) and holds until the scene ends. A scene that
  spans the page or lasts under 2 s gets no zoom.
- To show a region up close, do its work back to back; do not put a far-away
  click (e.g. the side menu) in between. `rec.hover` adds the hovered spot to
  the scene. Typed fields enter the frame with their box, other actions with
  the clicked point; for canvas points use `spot(locator, x, y)`.
- Camera tuning (how close, how early, how long) is `defaultCameraOptions` in
  `.kit/scripts/video/timeline.ts`. Never write video code in a scenario;
  propose new options for the kit
  repository if needed.
- Try effect changes without re-recording: `node tests/recording/.kit/cli.ts render <name>`.

## Narration and timing

Recording and narration are independent. Video mode records **fast** (viewer
pauses and cursor rests cut short, cursor moves three times faster, typing at
40 ms per character) and logs each of them with its natural length; the
renderer plays them back at a person's pace. `REC_RECORD_PACE=natural`
records at the viewer's pace, for apps that react differently to a fast
cursor (hover menus that open after a delay, debounced inputs).

If `scenarios/<name>.narration.json` exists (plan skill, phase 7), the
renderer fits it: each segment starts with its step; a voice longer than its
step + `gapMs` holds the step's last frame; a step longer than its voice loses
time from its loading waits, never from pauses, cursor moves or typing. The
render prints a fit table (`.captures/<name>/render-report.json`). A segment's
length is the measured audio (`durationMs`) when it is up to date, else an
estimate from the word count (then no audio is mixed in). `REC_NARRATION=0`
leaves the narration out.

`scenario({ compressWaits: false })` keeps the app's real waiting time (for
a video that must show how long something takes); a short voice then leaves
silence. `REC_COMPRESS_WAITS=0/1` overrides it when rendering.

When writing scenarios or steps:

- If you rename a step id, rename the `step` in the narration file too, or the
  segment no longer matches (a warning says so at run time).
- A changed narration text needs new audio and `render <name>`, not a new
  recording. Record again only when what the page shows must change.
- `node tests/recording/.kit/cli.ts narration plan <name>` reads each step's
  own length from the newest video (else the newest rehearsal).

## Checking a video

Look before you render, and render only what changed:

1. `node tests/recording/.kit/cli.ts render <name> --check`: no video, in
   seconds. Read `.captures/<name>/check/sheet.png` (each step's last frame,
   numbered, as the video shows it) and the printed fit table. Open a single
   `check/NN-<id>.png` only for a step that looks wrong.
2. Something looks wrong in one step: fix it, then
   `node tests/recording/.kit/cli.ts render <name> --draft --steps N` (half
   size, that step only, with its voice).
3. All good: `node tests/recording/.kit/cli.ts render <name>` for the final MP4.

"Out of frame" warnings name actions the camera cannot show (a vertical crop
too narrow for the scene): split the scene, `show` the area first, or pick
another format; this needs a render, not a new recording, unless the steps
change.

Narration text changed → `narration generate` (or `measure`) → `--check` →
`render`. Record again only when the page itself was wrong (a missing
element, a wrong record, a stray window).

## Core rules

0. **A scenario only orders steps.** For any job, look in the step catalog
   (`PROJECT.md`) first; if it is missing, write a new **step**, and if the step
   needs a screen operation that does not exist, a new **helper**. No local
   functions, selectors or `rec.click` in a scenario file. If a step or helper
   repeats another's work, merge them.
1. **Every interaction goes through `rec`:** `rec.click`, `rec.doubleClick`,
   `rec.rightClick`, `rec.hover`, `rec.drag(from, to)`, `rec.type`,
   `rec.typeSecret` (and `rec.show` to point the camera without touching). Never `page.click`, `locator.click` or `locator.fill`: the
   cursor would not go there, the camera would not see it and the pace breaks.
   Exception: the keyboard (`page.keyboard.type/press`).
2. **The on-screen message is the step's `note`.** `scenario()` marks each step
   and writes time and message to `steps.json` (video:
   `.captures/<name>/`, rehearsal: `.results/<test>/`). Never draw
   captions, cards or overlays in the page; everything added to the video is
   the renderer's job. Never call `rec.step` or `rec.start` inside steps.
3. **A step checks what it did.** End every step with `expect` on the result
   (new row, opened page, row count): steps are reused elsewhere and in test
   mode this is their value. Say in a comment where the step starts and ends;
   each step continues where the previous left off.
4. **Every scenario passes in all modes.** `rec.pause` is **for the viewer
   only** and skipped in test mode and before recording: never use it to wait
   for the app. Wait with `expect(...).toBeVisible()` / `toHaveCount()` /
   `toHaveURL()`. Mode-dependent code (`if (isTestMode)`) belongs in the kit,
   not in steps or scenarios.
   Every `rec` action first checks its target can be shown: on screen, not
   covered, not animating, not moving (waiting up to 5 s). A step that fails
   with "cannot be shown: it is covered by …" or "still animating" needs a
   wait in the helper (an `expect` that the toast or dialog is gone, or that
   the screen finished opening), never a `rec.pause`. Tests run at the newest
   video's page size, so fix such failures before recording.
5. **Pace for the viewer:** short stops on important screens with
   `rec.pause(ms)` and `rec.hover(...)` (1–3 s). Long waits make the video
   drag (the renderer shortens them only to fit a voice-over); hasty clicks
   cannot be followed.
6. **Changing values are settings.** Names, sources, conditions come from
   `.env.local`: `const env = (name, fallback = "") => process.env[name] ?? fallback`.
   Add every new setting to `.env.example` with an example and a comment.
   Required settings go in `require: [...]` (or `requireEnv(...)`), never
   `test.skip`: a skip hides the problem.
7. **Passwords and tokens never reach code, logs or `steps.json`.** Use
   `rec.typeSecret` for them.
8. **Scenarios usually write to a real backend.** In the file's top comment,
   say what it creates and what must be deleted before running it again.

## Selector order

Start from the most stable, using what the app offers (`PROJECT.md` >
"Selectors" lists this project's conventions):

1. A dedicated attribute: `data-testid`, or the app's own (e.g. `data-qa`).
2. Form field name: `[name="email"]`.
3. Link target: `a[href$="/customers/new"]`.
4. Role + label in the test locale: `getByRole("button", { name: "Save", exact: true })`.
5. A UI library's class names (e.g. a data grid's row class) as a last resort.

If two elements share a name (e.g. the page header's and the empty list's
"Add"), use `.first()` and say in a comment which one it is.

## Adding a helper

- Put it in the right module under `helpers/` (a new screen area gets a new
  file, exported from `helpers/index.ts`). Signature `(ui: Ui, ...)`; helpers
  that return a locator take `(page, ...)`.
- Confirm selectors in the app's code; follow the selector order.
- Solve the app's quirks (skipped screens, lazy lists, redirects) inside the
  helper with a short comment, so scenarios never need to know them. Record new
  quirks in `PROJECT.md` > "Known behaviours".
- Add a row to `PROJECT.md` > "Helper catalog".

If `rec` needs a new kind of cursor movement, add it to the kit
(`core/recorder.ts`, `virtual-mouse.ts`), not in the project: never edit files under
`.kit`. Propose the change to the user for the Runcast repository, kept
app-agnostic.

## Adding a step

```ts
// steps/<area>.ts
/** <What it does>. <Where it starts> → <where it ends>. */
export function createCustomer(
  options: StepOptions & { name: string; email?: string },
): Step {
  return {
    id: options.id ?? "create-customer",
    title: options.title ?? "New customer",
    note: options.note,
    transition: options.transition,
    show: options.show,
    offCamera: options.offCamera,
    run: async (ctx) => {
      await app.createCustomer(ctx, options.name, options.email); // screen work lives in a helper
      await expect(ctx.page.getByText(options.name).first()).toBeVisible(); // check
      ctx.state.customer = options.name;
    },
  };
}
```

- Scenario-specific values (names, messages) are options, never hard-coded.
- Pass `id`, `title`, `note`, `transition`, `show` and `offCamera` on from
  `StepOptions` as above; a step that drops one silently loses the
  scenario's setting. For an older step that does not pass them yet, a
  scenario can add them itself: `{ ...steps.openOrders(), offCamera: true }`;
  then update the step.
- Screen details (selectors, waits) go to the helper, not the step.
- Export it from `steps/index.ts` and add a row to `PROJECT.md` > "Step catalog".
- Steps share state through `ctx.state` (e.g. `customer`, `order`).
- A step that makes sense on its own (like login) gets a small scenario too
  (`scenarios/login.spec.ts`): its test and its example.
- A step that must open the page itself when it is the first step gives an
  `entry` (runs before recording).

## Applying the scenario text's decisions

The text's "Records" table says for each record **existing / new**, and
"Actions" lists what is shown without creating records. Apply directly:
existing → `steps.open*` / `select*` / `assign*`; new → `steps.create*` (write
the step first if missing). If a scenario must support both, choose with a
setting (`<PREFIX>_CUSTOMER_MODE=new|existing`) and write it in the text. Values
the AI filled in (e.g. descriptions) become the settings' defaults.

## Before finishing

1. From the repository root, typecheck the recording folder: the project's
   own TypeScript if it has one (`npx tsc -p <recording folder> --noEmit`),
   otherwise `npx --yes -p typescript@5 tsc -p <recording folder> --noEmit`.
   Run the project's linter and formatter on the recording folder.
2. `node tests/recording/.kit/cli.ts test --list` lists the scenario.
3. Test mode first (no capture, no window): `node tests/recording/.kit/cli.ts test <name>`.
   It must pass before any video. Use `REC_FROM` / `REC_TO` to watch only the
   changed steps. Runs write to the backend: **ask the user before running**,
   and clean up (or tell them what to clean up) afterwards.
4. On failure read `.results/<test>/error-context.md` and `test-failed-1.png`.
5. Add new settings to `.env.example`, the scenario to the README's scenario
   table, new helpers and steps to `PROJECT.md`. If a step changed in the test,
   update the scenario text (`.md`).
6. Check that the scenario file holds nothing but the step list.
