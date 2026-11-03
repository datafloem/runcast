# Runcast

Runcast turns a walk-through of your web app into a **finished demo
video**, and the same walk-through also runs as an **automated end-to-end
test**.

You describe the video to your AI assistant (Claude Code, Codex, Antigravity
or another tool). The assistant writes a short script that drives a real
Chrome browser through your app. The kit then records it with a smooth cursor
and a calm, zooming camera, and renders an MP4. If you want them, you also get
captions, opening and closing title cards, blurred private fields and a
voice-over. The kit can upload the result to YouTube too.

You need no video editing and no screen-recording app. You don't click through
the app yourself.

---

## Contents

- [What you get](#what-you-get)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install the plugin](#install-the-plugin)
- [Your first video, step by step](#your-first-video-step-by-step)
- [Everyday commands](#everyday-commands)
- [What is added to your project](#what-is-added-to-your-project)
- [Updating and removing](#updating-and-removing)
- [Troubleshooting](#troubleshooting)
- [Glossary](#glossary)
- [This repository](#this-repository)
- [Contributing](#contributing)

---

## What you get

- **A 1920×1080 MP4** of your app in a framed browser window. A drawn cursor
  moves at a human pace and shows a ripple on each click. The camera zooms in
  gently where the action is and holds still otherwise.
- **Optional extras**, each chosen when you plan the video:
  - captions at the bottom, one short message per step;
  - an opening card and a closing card with your logo and brand colour;
  - blur on fields the viewer must not read, such as e-mail addresses or
    server names;
  - a voice-over from ElevenLabs, timed so that each sentence plays while its
    step is on screen;
  - a 3D cube turn when the video moves to another part of the app, in place
    of the wait while the page loads.
- **An end-to-end test** made from the same script. It runs headless (no
  window) in seconds and works in CI.
- **YouTube upload** with a title, description, chapters and privacy setting
  that you approve before anything is published.

## How it works

You mostly talk to your AI assistant. The plugin gives it four **skills**:
instructions it follows for each job.

| You say                            | Skill              | What the assistant does                                                                                                           |
| ---------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| "Set up recordings for this app"   | `runcast-setup`    | Installs the kit, reads your app's code (pages, forms, sign-in, brand) and writes the project's recording files and a login test  |
| "Plan a new demo video"            | `runcast-plan`     | Interviews you a few questions at a time (goal, audience, length, which screens, which data) and writes the agreed plan as a text |
| "Write the test for that scenario" | `runcast-scenario` | Turns the approved plan into a Playwright script and checks that it passes                                                        |
| "Upload the video to YouTube"      | `runcast-publish`  | Guides you through Google's one-time setup, drafts the title and description, and uploads after your yes                          |

Under the hood:

1. **A scenario is a Playwright script.** [Playwright](https://playwright.dev)
   is a browser-automation library. A scenario is a list of **steps**, for
   example "sign in", "create a customer" and "add an order". Each step does
   its work and checks the result.
2. **The same scenario runs in three modes:**
   - **test:** headless and as fast as possible, to check that the app works;
   - **rehearsal:** headless at video pace, to measure how long each step
     takes;
   - **video:** a visible Chrome window that is screen-recorded with ffmpeg
     and then rendered into the final MP4.
3. **The kit is installed once per computer**, not into each project. The
   first setup builds a shared **runtime** in `~/.cache/runcast/`: the
   kit plus Playwright, a few hundred MB. Each project gets only a small
   **recording folder** (default `tests/recording/`) with its own files and a
   link named `.kit` that points at the runtime. Your `package.json` is not
   touched.

## Requirements

| What                  | Why                                          | How to check / install                                                                              |
| --------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Node.js 22.18+**    | Runs the kit (TypeScript runs directly)      | `node --version`; install from [nodejs.org](https://nodejs.org)                                     |
| **Google Chrome**     | The browser that is driven and recorded      | Install from [google.com/chrome](https://www.google.com/chrome/). On ARM Linux, see Troubleshooting |
| **ffmpeg**            | Screen capture, rendering and voice-over     | macOS: `brew install ffmpeg` · Debian/Ubuntu: `sudo apt install ffmpeg`                             |
| **Xvfb** (Linux only) | A virtual screen on machines with no display | `sudo apt install xvfb`                                                                             |
| **Your app running**  | The kit opens it in the browser              | Start your dev server as usual (for example `npm run dev`)                                          |
| **A test account**    | For the sign-in step                         | A user name and password for your app. They go in a local file, never in the chat                   |

Platforms:

- **macOS:** everything works. The first video asks for **Screen Recording**
  permission for the app that runs the command (your terminal or AI app):
  System Settings > Privacy & Security > Screen Recording.
- **Linux:** everything works. Without a screen (servers, CI, containers) the
  kit starts a virtual display by itself.
- **Windows:** tests and rehearsals work; video recording is not supported
  yet.

After setup you can always run `node tests/recording/.kit/cli.ts doctor`. It
lists what is installed and what is missing.

Optional:

- an **ElevenLabs** account for the voice-over (an API key, or the ElevenLabs
  website by hand);
- a **Google account with a YouTube channel** for uploads.

## Install the plugin

Install it once in each AI tool you use. The plugin is published from
[github.com/datafloem/runcast](https://github.com/datafloem/runcast).

### Claude Code

In Claude Code, add the Datafloem marketplace and install the plugin from it:

```text
/plugin marketplace add datafloem/runcast
/plugin install runcast@datafloem
```

### Codex

Add the marketplace:

```bash
codex plugin marketplace add datafloem/runcast
```

Then open the Codex app, go to the **Plugins** directory and install
**Runcast**.

### Antigravity

Clone this repository and install the plugin folder from it:

```bash
git clone https://github.com/datafloem/runcast.git
agy plugin install ./runcast/plugins/runcast
```

### Other tools (Cursor, Copilot, ...)

These tools have no plugin system the kit supports, so you copy the plugin
folder and run setup by hand:

1. Copy `plugins/runcast/` from this repository into your project, for
   example as `tools/runcast/`.
2. From your project's root folder, run:

   ```bash
   node tools/runcast/skills/runcast-setup/kit/cli.ts setup --skills .claude/skills,.agents/skills
   ```

   `--skills` copies the four skills into the folders where most AI tools
   look for them. Then continue with step 1 below. Setup is already done, so
   the assistant only studies the app.

## Your first video, step by step

Open your app's project in your AI tool and follow these steps. In each one
you either type a request to the assistant or run a command.

### 1. Set up recordings

Tell your assistant:

> Set up recordings for this app.

The assistant:

- builds the runtime the first time. This downloads Playwright, takes a few
  minutes and happens once per kit version. It tells you before it starts;
- creates the recording folder (default `tests/recording/`);
- reads your code to find the sign-in page, the main screens and forms, and
  your logo and brand colour;
- writes a login helper, a login step and a login scenario, and fills in
  `PROJECT.md`, a map of your app that later scenarios use.

It asks you only for what it cannot find in the code, such as the dev URL.

### 2. Add your test account

Copy the example settings file and fill in the account:

```bash
cp tests/recording/.env.example tests/recording/.env.local
```

Open `tests/recording/.env.local` and set `APP_USERNAME` and `APP_PASSWORD`.
The file is ignored by git. Never paste passwords into the chat.

### 3. Check that it works

Start your app, then run the login scenario as a test:

```bash
node tests/recording/.kit/cli.ts test login
```

It should end with `1 passed`. If it fails, tell your assistant. It reads the
error report and fixes the selectors, the instructions that find buttons and
fields.

### 4. Plan the video

Tell your assistant:

> Plan a new demo video.

It interviews you one topic at a time and suggests an answer for each
question:

- what the video shows, who watches it, and how long it should be;
- the language of on-screen messages;
- captions, title cards, blurred fields, voice-over, cube transitions;
- which records to use: existing data, or new records created during the
  video (and their form values);
- the flow, screen by screen, and from which step the recording starts.
  Sign-in can happen off camera.

The plan is saved as `tests/recording/scenarios/<name>.md`, so your team can
read and approve it.

### 5. Write the scenario

When the plan is approved, the assistant writes
`tests/recording/scenarios/<name>.spec.ts` and any missing steps. It runs the
scenario as a test first, and it asks before running anything that writes to
your app's data.

### 6. Record the video

```bash
node tests/recording/.kit/cli.ts video <name>
```

A Chrome window opens and runs through the flow by itself. **Don't touch the
mouse and keep other windows off it** while it records. Then the kit renders
the result:

```text
tests/recording/videos/<name>.mp4
```

To change captions, title cards or the camera without recording again:

```bash
node tests/recording/.kit/cli.ts render <name>
```

### 7. Add a voice-over (optional)

If you chose a voice-over in step 4, the assistant writes one sentence or two
per step, sized to how long each step really takes. Then it makes the audio,
in one of three ways:

- **with an ElevenLabs API key** (put it in `.env.local`, not in the chat):
  `node tests/recording/.kit/cli.ts narration generate <name>`;
- **by hand** in the ElevenLabs website, one file per step;
- **as a single take** in the ElevenLabs website, which the kit then cuts
  into steps.

Record the video again (step 6) and the voice is mixed in at the right
moments.

### 8. Publish to YouTube (optional)

Tell your assistant:

> Upload the video to YouTube.

The first time, it walks you through Google's setup one step at a time:
creating a Google Cloud project, turning on the YouTube API and downloading a
small credentials file. You sign in yourself in your own browser. The
assistant drafts the title, description and tags for your approval, suggests
"unlisted" over "public", and uploads only after you say yes.

## Everyday commands

Run these from your project's root folder. If your recording folder is not
`tests/recording`, use your folder's path instead.

| Command                                                  | What it does                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| `node tests/recording/.kit/cli.ts doctor`                | Shows what is installed and what is missing                    |
| `node tests/recording/.kit/cli.ts test`                  | Runs every scenario as a fast headless test                    |
| `node tests/recording/.kit/cli.ts test <name>`           | Runs one scenario as a test                                    |
| `node tests/recording/.kit/cli.ts rehearsal <name>`      | Runs at video pace without recording, to check timing          |
| `node tests/recording/.kit/cli.ts video <name>`          | Records and renders `videos/<name>.mp4`                        |
| `node tests/recording/.kit/cli.ts render <name>`         | Renders the last recording again (new captions, cards, camera) |
| `node tests/recording/.kit/cli.ts narration plan <name>` | Shows how many words of voice-over fit each step               |
| `node tests/recording/.kit/cli.ts youtube check`         | Shows what is missing for YouTube uploads                      |

To record only part of a scenario, name the first and last step to record.
Earlier steps still run, quickly and off camera:

```bash
REC_FROM=3 node tests/recording/.kit/cli.ts video <name>
REC_FROM=3 REC_TO=3 node tests/recording/.kit/cli.ts test <name>
```

All settings are listed in `tests/recording/.env.example` and in the
[kit guide](plugins/runcast/skills/runcast-setup/kit/README.md#settings-envlocal).

## What is added to your project

Only the recording folder. Nothing else in your project changes.

```text
tests/recording/
  recording.config.ts   app name, URL, language, theme and brand for the videos
  PROJECT.md            the app's screens, forms and quirks (written by the assistant)
  AGENTS.md, CLAUDE.md  instructions for AI assistants working in this folder
  helpers/              how to do things on each screen (finding buttons and fields)
  steps/                reusable steps: sign in, create a customer, ...
  scenarios/            <name>.md (the plan), <name>.spec.ts (the script),
                        <name>.narration.json (voice-over), <name>.youtube.json
  .env.example          every setting, with comments (commit this)
  .env.local            your account and keys (git-ignored)
  .kit                  link to the shared runtime (git-ignored, made by setup)
  videos/ narration/ .results/   output (git-ignored)
```

Commit the recording folder. The ignored files stay on each person's
computer. After someone clones the project, setup recreates the `.kit` link
when they ask the assistant to set up recordings, or when they run the
plugin's `cli.ts setup` again.

## Updating and removing

**Update:** update the plugin in your AI tool, then ask the assistant to set
up recordings again (or run setup again). It builds the new runtime, re-links
`.kit`, and never overwrites your project's own files. The newest three
runtimes are kept and older ones are deleted.

**Remove from a project:** delete the recording folder.

**Remove from the computer:** delete `~/.cache/runcast/` and uninstall
the plugin in your AI tool. In Claude Code that is
`/plugin uninstall runcast@datafloem`.

## Troubleshooting

| Problem                                                | What to do                                                                                                                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.kit` is missing, or "is not set up: run setup first" | Run setup again (ask the assistant to set up recordings). This is normal after a fresh clone or a kit update                                                         |
| The video is black or shows the wrong screen           | macOS: allow Screen Recording for the app that runs the command, then restart that app. With several screens, set `REC_SCREEN` in `.env.local`                       |
| "Google Chrome not found"                              | Install Chrome. On ARM Linux (no Chrome build): set `REC_CHANNEL=chromium` and run `node tests/recording/.kit/node_modules/@playwright/test/cli.js install chromium` |
| A test fails to find a button or field                 | Tell the assistant; it reads `.results/<test>/error-context.md` and the screenshot, then fixes the helper                                                            |
| The first page load times out                          | Your dev server may still be compiling. Open the app once in a browser, or ask the assistant to raise that timeout in the helper                                     |
| The voice-over and the screen drift apart              | Run `rehearsal <name>`: it warns for each step that runs longer than its sentence. The assistant shortens the text or the step                                       |
| A scenario created data you don't want                 | Scenarios write to your real app. Each scenario's plan lists what it creates and what to delete before recording again                                               |

## Glossary

| Term                 | Meaning                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| **Scenario**         | One flow through the app, from start to finish: a plan (`.md`) and a script (`.spec.ts`)           |
| **Step**             | One reusable piece of a scenario, such as "sign in". It checks its own result                      |
| **Helper**           | The code that operates one screen: it finds the buttons and fields. Steps use helpers              |
| **Recording folder** | The folder in your project with the scenarios and settings (default `tests/recording/`)            |
| **Runtime**          | The kit plus Playwright, built once per computer in `~/.cache/runcast/` and shared by all projects |
| **Modes**            | `test` (fast, headless), `rehearsal` (video pace, headless), `video` (recorded)                    |
| **Skill**            | Instructions that tell the AI assistant how to do one job (set up, plan, write, publish)           |

## This repository

The repository is a plugin marketplace for Claude Code, Codex and
Antigravity:

```text
.claude-plugin/marketplace.json     Claude Code marketplace
.agents/plugins/marketplace.json    Codex marketplace
plugins/runcast/
  .claude-plugin/plugin.json        Claude Code manifest
  plugin.json                       Codex and Antigravity manifest
  skills/
    runcast-setup/                  the setup skill, and the kit itself in kit/
      kit/                          cli.ts, engine, video and voice-over scripts,
                                    project templates, Linux self-test
    runcast-plan/                   the planning interview
    runcast-scenario/               the rules for writing scenarios
    runcast-publish/                the YouTube upload
```

The kit is inside the setup skill because Antigravity installs only a
plugin's skills.

- **Full technical guide:** [kit README](plugins/runcast/skills/runcast-setup/kit/README.md)
  (modes, camera, voice-over, YouTube, all settings, limits).
- **Changing the kit:** read [AGENTS.md](AGENTS.md) first. The kit must stay
  app-agnostic: no app names, screens or URLs in it.

## Contributing

Bug reports, ideas and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md)
explains how to set up the repository, try a change against the sample app
and open a pull request. Report security problems privately, as described in
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Datafloem
