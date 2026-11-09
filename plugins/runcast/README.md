# Runcast

Runcast turns a walk-through of your web app into a **finished demo video**,
and the same walk-through runs as an **automated end-to-end test**.

Describe the video you want to your AI assistant. It plans the video with you,
then writes a short Playwright scenario that drives a real Chrome browser
through your app. Runcast records the screen with a smooth cursor and a calm,
zooming camera, and renders an MP4: landscape, or vertical for YouTube Shorts
and Instagram Reels. You can add captions, title cards, blurred
private fields, cube transitions between steps and a voice-over, and upload the
result to YouTube. You don't edit video, use a screen recorder or click
through the app yourself.

## Skills

| Skill              | What it does                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `runcast-setup`    | Adds Runcast to a project: studies the app, writes the login helper, a first scenario and `PROJECT.md`      |
| `runcast-plan`     | Interviews you about a new video (goal, audience, format, flow, captions, voice-over) and writes the plan   |
| `runcast-scenario` | Writes or fixes a scenario that runs as a fast test or is recorded as a video                               |
| `runcast-publish`  | Walks you through the one-time Google setup and uploads a rendered video to YouTube, after you approve it  |

Try: *"Set up Runcast for this app"*, then *"Plan a 60-second demo of creating
an order"*.

## Requirements

- Node 22.18 or newer, and Google Chrome (or Playwright's Chromium).
- `ffmpeg` for video and voice-over. On macOS, the app that runs the command
  needs the Screen Recording permission. On Linux, Runcast uses Xvfb when
  there is no screen. On Windows, it records the signed-in desktop.
- Video recording runs on macOS, Linux and Windows 10/11. Test and rehearsal
  runs work anywhere, CI included.

## What Runcast installs, sends and stores

Runcast has no telemetry and no server of its own. Everything below runs on
your computer, only when you or your assistant run the command named.

**Installs (`setup`)**

- Copies the kit to a versioned folder, `~/.cache/runcast/<version>-<hash>/`
  (or `REC_KIT_HOME`), and runs `npm ci --omit=dev` there. That downloads
  three pinned packages and their dependencies from the npm registry:
  `@playwright/test`, `@napi-rs/canvas` and `@types/node`. Your project
  installs nothing. Runcast keeps the newest few runtime folders there and
  removes older ones.
- Creates the recording folder in your project (default `tests/recording/`)
  from templates, links `tests/recording/.kit` to the runtime and adds `.kit`
  to that folder's `.gitignore`.
- Downloads nothing else. If you choose Playwright's Chromium instead of
  Chrome, you run Playwright's own install command, which downloads it.

**Connects to**

- **Your app**, at the base URL in `recording.config.ts`, in the browser that
  Playwright drives, signed in with the test account you put in
  `tests/recording/.env.local`.
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
  output and test reports.
- `.captures/<scenario>/`: the latest video recording of each scenario (the
  screen recording, its event log and step times), kept until that scenario
  is recorded again. Each render also writes `render-report.json` there (how
  each step was fitted to its voice-over, and where it starts in the video),
  and `render --check` one picture per step to `check/`. `render --draft`
  and `--steps` write `videos/<name>.draft.mp4` and
  `videos/<name>.steps-<a>-<b>.mp4`.

**Records**

- In video mode only, with ffmpeg: on macOS the screen, cropped to the
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
