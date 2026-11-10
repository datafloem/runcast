---
name: runcast-scene
description: Designs an animated scene for a Runcast video — an HTML animation (a concept, an architecture, the real-world context of a feature: what the app itself cannot show) in <recording folder>/scenes/<name>/, recorded like the app and joined to it with a transition, or rendered alone as an MP4 or GIF for an article or website. Writes the scene, shows the user a preview and a contact sheet of its beats, and changes it until they approve. Use when a video plan needs a scene, or someone asks for an explainer animation for a demo video.
---

# Designing a scene

A scene is a short animation the app cannot show by itself: how an order
moves through the system, what happens on the customer's side, the idea
behind a feature. It is a plain web page in the recording folder,
`scenes/<name>/index.html` (default folder `tests/recording/`), that Runcast
records in a headless browser tab exactly like the app, so it gets the same
frame, camera look, captions and voice-over, and joins the app's footage with
a transition. The scenario plays it with `scene({ name })` (see the
`runcast-scenario` skill); `scene render` makes it a video or GIF of its own.

The kit's example is `example/index.html` next to this file (a made-up
customers and orders app, three beats). Start from a copy of it.

## The contract

The page must keep these rules; the kit checks the first two before it
records and fails with the list of problems:

1. **`window.runcastScene = { duration, beats, start }`**:
   - `duration`: the scene's length in ms (from `start()`).
   - `beats`: `[{ id, at }]` in time order, `at` in ms from `start()`, ids
     unique words (`customer`, `order`, `invoice`). Each beat becomes a step
     in the video named `<step id>.<beat id>` (e.g. `order-flow.invoice`),
     so a narration segment can speak over one beat.
   - `start()`: plays the scene once from the beginning.
2. **Opened with `?record`, nothing moves until `start()`**: no autoplay, no
   loop, no controls, no hover effects. Opened without it (a person looking
   at the file), it may play in a loop.
3. **Each beat ends on a settled frame** before the next beat's `at` (and the
   last before `duration`): everything of that beat has arrived and stands
   still. The renderer holds that frame while a longer voice-over finishes,
   and `scene preview` shows exactly that frame per beat.
4. **Deterministic**: the same frames on every run. No `Math.random()`
   without a fixed seed, no dates, clocks or time-of-day logic, nothing
   fetched. Time comes only from CSS animations or timers started by
   `start()`.
5. **Local files only**: everything in the scene's folder (images, fonts,
   scripts). No CDN, no network: the page is opened as a `file://` page.
6. **No sound.**
7. **The brand from the kit**: read `var(--runcast-brand)` (the accent
   colour from `recording.config.ts`) and `var(--runcast-logo)` (a CSS
   `url(...)` of the logo, or `none`) with a fallback, e.g.
   `var(--runcast-brand, #2f6feb)`. Never hard-code the app's colours twice.

## Layout and look

- **The page size is the video's page:** 1440×810 CSS pixels in landscape
  (`REC_PAGE_SIZE`), 540×960 for `format: "vertical"`, drawn at 2× for
  detail. Size everything in `vw` / `vh` (or check both sizes) so nothing is
  cut off; keep a margin of about 5% on every side.
- **One idea per beat, few words:** a title of at most six words, short labels
  (two to four words), large type (titles ≥ 3vw, labels ≥ 1.2vw). The viewer
  also hears the voice-over: the scene shows, it does not explain in text.
- **Calm motion:** elements come in (fade, rise, grow) over 400–800 ms with an
  ease-out and then stay. No flashing, no endless loops in `?record`, no
  camera shake. What came in earlier stays visible so the picture builds up.
- **Pacing:** about 1.5–2.5 s per beat without narration; with a voice-over
  the beat holds for its sentence, so the motion can stay short. A whole
  scene is usually 4–10 s.
- **Light and dark:** the video frames the page on a dark background; a light
  scene reads well. Follow the app's own look where it helps recognition.
- Use the app's real names for things (as in `PROJECT.md`), with made-up
  records (people, orders, amounts): never real customer data.

## Making it, step by step

1. Agree what the scene is for (plan skill, scenes phase): its purpose, how
   long, the beats in order, the look. Write that in the scenario text.
2. Copy `example/index.html` to `<recording folder>/scenes/<name>/index.html`
   (a short kebab-case name) and change the content, the beats and the
   timings. Keep the `?record` switch and `window.runcastScene`.
3. Preview it:

   ```bash
   node tests/recording/.kit/cli.ts scene preview <name>
   ```

   It records the scene alone and writes the contact sheet of its beats,
   `.captures/scene-<name>/check/sheet.png` (one tile per beat: the settled
   frame at its end), and a draft video, `videos/scene-<name>.draft.mp4`.
   Look at the sheet yourself first: every beat settled, nothing cut off,
   text readable at that size. Fix and preview again.
4. Show the user the sheet (and the draft) and ask for approval. Change what
   they ask for and preview again; continue only after they approve.
5. The scenario plays it with `scene({ id, name, title, transition })` (the
   `runcast-scenario` skill). Narration segments can target its beats:
   `{ "step": "<step id>.<beat id>", ... }`.

On its own, for an article or a website:

```bash
node tests/recording/.kit/cli.ts scene render <name> --gif
```

writes `videos/scene-<name>.mp4` and, with `--gif`, `videos/scene-<name>.gif`
(960 px wide, 15 fps). It records again only when the scene's files changed
since the last recording.

## When it does not work

- "does not keep the scene contract": the message lists each problem (a
  missing `start()`, beats out of order, a beat after the end). Fix the page.
- A beat's tile shows the next beat already coming in, or the previous one
  still moving: the motion is longer than the gap; shorten it or move `at`.
- Nothing moves in the draft: `start()` must start the motion (e.g. add a
  class that the animations hang on), and the page must not wait for a
  click.
