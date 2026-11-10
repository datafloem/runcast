# Runcast

Runcast turns a walk-through of your web app into a **finished demo video**,
and the same walk-through runs as an **automated end-to-end test**.

Describe the video you want to your AI assistant. It plans the video with you,
then writes a short Playwright scenario that drives a real Chrome browser
through your app. Runcast records the app's tab in a hidden browser (you keep
using your computer meanwhile), adds a smooth cursor and a calm, zooming
camera, and renders an MP4: landscape, or vertical for YouTube Shorts
and Instagram Reels. You can add captions, title cards, blurred
private fields, cube transitions between steps, animated scenes your assistant
designs, the app's own sound and a voice-over, and upload the result to
YouTube. You don't edit video, use a screen recorder or click
through the app yourself.

## Skills

| Skill              | What it does                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `runcast-setup`    | Adds Runcast to a project: studies the app, writes the login helper, a first scenario and `PROJECT.md`      |
| `runcast-plan`     | Interviews you about a new video (goal, audience, format, flow, captions, voice-over) and writes the plan   |
| `runcast-scenario` | Writes or fixes a scenario that runs as a fast test or is recorded as a video                               |
| `runcast-scene`    | Designs an animated scene (a concept, an architecture) for a video, previews it and changes it until you approve it |
| `runcast-publish`  | Walks you through the one-time Google setup and uploads a rendered video to YouTube, after you approve it  |

Try: *"Set up Runcast for this app"*, then *"Plan a 60-second demo of creating
an order"*.

## Requirements

- Node 22.18 or newer, and Google Chrome (or Playwright's Chromium).
- `ffmpeg` for video and voice-over.
- Video, test and rehearsal runs work on macOS, Linux, Windows 10/11 and CI:
  video records a headless Chrome tab, with no permission and no screen.
- Optional screen capture (`REC_CAPTURE=screen`, for flows that must show
  real OS dialogs): on macOS the app that runs the command needs the Screen
  Recording permission; on Linux Runcast uses Xvfb when there is no screen;
  on Windows it records the signed-in desktop.

## What Runcast installs, sends and stores

Runcast has no telemetry and no server of its own. Everything below runs on
your computer, only when you or your assistant run the command named.

**Installs (`setup`)**

- Copies the kit to a versioned folder, `~/.cache/runcast/<version>-<hash>/`
  (or `REC_KIT_HOME`), and runs `npm ci --omit=dev` there. That downloads
  three pinned packages and their dependencies from the npm registry:
  `@playwright/test`, `@napi-rs/canvas` and `@types/node`. Your project
  installs nothing. Each runtime folder lists, in `.links.json`, the paths
  of the projects' `.kit` links that point at it. Runcast keeps the newest
  few runtime folders and any that a project still links to, and removes
  the others.
- Creates the recording folder in your project (default `tests/recording/`)
  from templates, links `tests/recording/.kit` to the runtime and adds `.kit`
  to that folder's `.gitignore`.
- Downloads nothing else. If you choose Playwright's Chromium instead of
  Chrome, you run Playwright's own install command, which downloads it.

**Connects to**

- **Your app**, at the base URL in `recording.config.ts`, in the browser that
  Playwright drives, signed in with the test account you put in
  `tests/recording/.env.local`.
- **The kit's own local pages**, in that same browser, in video mode and
  rehearsal (and, for scenes, `scene preview` / `scene render`, test runs,
  and `render` when a video's scene is new or changed): the recorder (`core/recorder.html` in the runtime folder, opened as
  a `file://` page) records the app's tab and hands the video to the kit
  inside the browser; the stage (`core/stage/*.html`: a blank page, a
  file manager listing the files a step uploads, and a viewer showing a file
  the app downloaded) is a second recorded tab,
  where scenes from your recording folder (`scenes/<name>/index.html`,
  opened as `file://` pages) play too. During a take a scene is only opened
  in an unrecorded page to read its length and beats. The kit blocks every
  network request from the stage and scene pages; the recorder loads nothing. Files a step
  uploads are read from your recording folder and handed to your app in the
  browser only; a downloaded file the scenario opens is read from where the
  kit saved it and handed to the viewer page in the browser only.
- **ElevenLabs** (`api.elevenlabs.io`), only when you run
  `narration generate`. It sends each voice-over line's text, plus the lines
  just before and after it, with your `ELEVENLABS_API_KEY` from `.env.local`,
  and saves the returned audio in `tests/recording/narration/`.
- **Google** (`accounts.google.com`, `oauth2.googleapis.com`,
  `www.googleapis.com`), only when you run `youtube auth` or
  `youtube upload`. You sign in to Google in your own browser; the kit
  receives the sign-in on `127.0.0.1` and uploads the video file, its title,
  description, tags and privacy setting, and a thumbnail frame to your
  channel. Nothing is uploaded until you approve the details.

**Stores, in your project's recording folder (all gitignored by the template)**

- `.env.local`: the test account and the optional ElevenLabs key.
- `.youtube/`: the Google OAuth client file you download and the refresh token
  that `youtube auth` writes.
- `videos/`, `narration/`, `.results/`, `.report/`: renders, audio, test
  output and test reports. A failed test or rehearsal keeps a screenshot, an
  error report (`error-context.md`) and a trace (screenshots and the action
  log, no page snapshots); a failed video take keeps no trace. Values typed
  with `rec.typeSecret` are never typed through Playwright's keyboard, are
  blurred on screen, and are emptied and replaced by `•••••` before a
  failure is written; password fields are emptied too.
- Files your app downloads in a scenario (`rec.download`): with the video
  recording in `.captures/<scenario>/downloads/` (replaced by the next
  recording of that scenario), in tests and rehearsals under `.results/`
  (emptied by Playwright on every run). The browser's own temporary copy is
  deleted.
- `scenes/<name>/`: the animated scenes your assistant writes for your
  videos (local files only; committed with your project if you wish).
- `.captures/<scenario>/`: the latest video recording of each scenario (the
  tab or screen recording, its event log and step times), kept until that scenario
  is recorded again. Each render also writes `render-report.json` there (how
  each step was fitted to its voice-over, and where it starts in the video),
  and `render --check` one picture per step to `check/`. `render --draft`
  and `--steps` write `videos/<name>.draft.mp4` and
  `videos/<name>.steps-<a>-<b>.mp4` (vertical videos:
  `videos/<name>-vertical.draft.mp4`, `videos/<name>-vertical.steps-<a>-<b>.mp4`). `scene preview <name>` records a scene
  alone to `.captures/scene-<name>/`, and so does `render` when a video
  shows a scene that is new or changed since its last recording (with a
  hash of the scene's files in `scene.json`); `scene render` writes
  `videos/scene-<name>.mp4` (and `.gif`).

**Records**

- In video mode, and when you run `scene preview` or `scene render` (a scene
  alone) or `render` records a new or changed scene: by default the app's
  tab (or the scene) in the headless browser,
  with Chrome's own tab capture (nothing else on your screen is recorded),
  picture and the tab's sound. While it records, the sound is kept off your
  speakers; before the recording starts (preparation steps) and after it
  stops, an app that plays sound can be heard. The sound goes into the video
  only when the scenario asks for it (`appAudio`). With
  `REC_CAPTURE=screen`, with ffmpeg: on macOS the screen, cropped to the
  browser's page area; on Linux the display (Xvfb when there is no screen),
  limited to the page area; on Windows the page area of the main screen
  (Desktop Duplication, or GDI as a fallback). The capture stays on your computer. Fields you
  list as private are blurred in the rendered video.

## Learn more

- Full guide: <https://github.com/datafloem/runcast#readme>
- Technical reference: [kit README](skills/runcast-setup/kit/README.md)
- Report a problem: <https://github.com/datafloem/runcast/issues>
- Security: <https://github.com/datafloem/runcast/security/advisories/new>

## License

MIT © Datafloem
