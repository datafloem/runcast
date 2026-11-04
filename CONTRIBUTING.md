# Contributing to Runcast

Thanks for helping. This guide covers how to report a problem, how to set up
the repository, and how to open a pull request that can be merged quickly.

If you only want to *use* Runcast in your app, you don't need any of this:
install the plugin as the [README](README.md#install-the-plugin) explains.

## Contents

- [Ways to help](#ways-to-help)
- [Ground rules](#ground-rules)
- [Set up the repository](#set-up-the-repository)
- [Try your change](#try-your-change)
- [Open a pull request](#open-a-pull-request)
- [Review and merge](#review-and-merge)
- [Releases](#releases)
- [License](#license)

## Ways to help

- **Report a bug.** Open a [bug report](https://github.com/datafloem/runcast/issues/new/choose).
  Add the command you ran, the full output and the output of
  `node <recording folder>/.kit/cli.ts doctor`. Leave out passwords, tokens
  and your app's private data.
- **Suggest a feature.** Open a feature request and describe the video or test
  you want to make, not only the option you have in mind.
- **Fix something.** Small fixes (typos, docs, an obvious bug) can go straight
  to a pull request. For a new feature, a new setting or a change to the
  public API (`core/index.ts`), open an issue first so we can agree on the
  approach before you write code.
- **Security problems** must not go in a public issue. See
  [SECURITY.md](SECURITY.md).

## Ground rules

These keep the kit usable in every project. Pull requests that break them are
sent back. [AGENTS.md](AGENTS.md) has the full list. It is written for AI
assistants, but it applies to people too.

1. **The kit is app-agnostic.** Nothing in the plugin may name a real app, its
   screens, labels, URLs, colours or accounts. Examples in skills, READMEs,
   templates and code comments use one made-up app with customers and orders
   (`createCustomer`, `addOrder`, `[name="email"]`). A workaround for one
   app's quirk belongs in that app's recording folder (`helpers/`,
   `PROJECT.md`), not in the kit.
2. **Projects install nothing.** Commands in skills and docs must work in a
   project without its own dependencies. Run tools through
   `<recording folder>/.kit/cli.ts` (for example `test --list`), never a bare
   `npx playwright`.
3. **The public API is `core/index.ts`.** Every project imports the kit
   through it. Renaming or removing an export breaks every project, so it
   needs an issue first and a note in the pull request.
4. **Docs change with behaviour.** If you change what the kit does, update
   the skills, the [kit README](plugins/runcast/skills/runcast-setup/kit/README.md),
   the root [README](README.md) and the templates in the same pull request.
   If the change downloads, contacts or writes something new, add it to
   "What Runcast installs, sends and stores" in the
   [plugin README](plugins/runcast/README.md). That README is the Claude
   directory listing, and the directory's security scan rejects behaviour it
   doesn't disclose.
5. **One plugin for every tool.** Keep `plugins/runcast/.claude-plugin/plugin.json`
   (Claude Code) and `plugins/runcast/plugin.json` (Codex and Antigravity) in
   step. The CI check compares them.
6. **English only**, in code, comments, docs and commit messages.

## Set up the repository

You need Node 22.18 or newer, Git and, for video mode, `ffmpeg`. See the
[requirements](README.md#requirements).

1. Fork the repository on GitHub and clone your fork:

   ```bash
   git clone git@github.com:<your-user>/runcast.git
   cd runcast
   ```

2. Install the kit's development dependencies once:

   ```bash
   npm --prefix plugins/runcast/skills/runcast-setup/kit install
   ```

3. Run the same checks as CI:

   ```bash
   node plugins/runcast/skills/runcast-setup/kit/node_modules/typescript/bin/tsc -p plugins/runcast/skills/runcast-setup/kit --noEmit
   ```

   ```bash
   node .github/scripts/check-plugin.mjs
   ```

   The first command typechecks the kit. The second checks that the
   manifests, marketplaces and skills agree with each other (names, versions,
   skill front matter, no bare `npx playwright`) and that the plugin folder
   meets the Claude directory's file rules (a README of 40+ words, no OS
   system files, text files under 256 KiB).

Where things are:

| Path                                        | What it is                                            |
| ------------------------------------------- | ----------------------------------------------------- |
| `plugins/runcast/skills/runcast-setup/kit/` | The kit: `cli.ts`, engine, video and voice-over code  |
| `plugins/runcast/skills/*/SKILL.md`         | The skills the AI assistant follows                   |
| `kit/templates/project/`                    | Files copied into a project by `setup` (`.tmpl`)      |
| `kit/test/linux/`                           | Linux self-test with a small sample app               |
| `.github/`                                  | CI, issue and pull request templates, GitHub rulesets |

## Try your change

Typechecking is not enough for a change that affects recording. Run the kit
against the sample app in `kit/test/linux/site` (a login page and a home page)
in a scratch folder outside the repository.

In one terminal, start the sample app:

```bash
node plugins/runcast/skills/runcast-setup/kit/test/linux/serve.ts plugins/runcast/skills/runcast-setup/kit/test/linux/site 4173
```

In another terminal, set up a scratch project with your copy of the kit and
run its login scenario:

```bash
mkdir -p /tmp/runcast-scratch && cd /tmp/runcast-scratch
```

```bash
node <path to your clone>/plugins/runcast/skills/runcast-setup/kit/cli.ts setup --dir tests/recording --name "Sample App" --base-url http://localhost:4173
```

```bash
printf 'APP_USERNAME=demo\nAPP_PASSWORD=demo-password\n' > tests/recording/.env.local
```

On Windows, run these in Git Bash, or create `tests/recording/.env.local`
with those two lines in an editor. The **Windows** workflow in CI runs the
same setup, test and rehearsal on every pull request that changes the plugin,
plus a video smoke test whose output you can download from the run.

```bash
node tests/recording/.kit/cli.ts test
```

Then try `rehearsal` and, if you changed the video or camera code, `video`.
Every time the kit changes, `setup` builds a new runtime in
`~/.cache/runcast/`, so run `setup` again after each edit.

To test the skills in your AI tool, install the plugin from your clone
instead of GitHub. For Claude Code:

```text
/plugin marketplace add <path to your clone>
/plugin install runcast@datafloem
```

**Linux self-test (optional).** Only run it when you change Linux-specific
code: Xvfb, x11grab or the Linux setup. It needs Docker. See the
[kit README](plugins/runcast/skills/runcast-setup/kit/README.md#self-test-on-linux).
CI runs it on pull requests that touch those files.

## Open a pull request

1. **Create a branch** from an up-to-date `main`. The name is
   `<type>/<short-description>`: a type from the list in step 3, a slash,
   then lowercase words with hyphens. Examples: `fix/blur-on-scroll`,
   `feat/fade-transition`, `docs/codex-install`. CI checks the name, so
   `my-branch` or `Feature/Fade` fail.
2. **Keep it focused.** One topic per pull request. A refactor and a feature
   are two pull requests.
3. **Write commits in [Conventional Commits](https://www.conventionalcommits.org/) style:**
   `type: short summary in the imperative`, with an optional scope:
   `fix(render): ...`. Types: `feat`, `fix`, `docs`, `refactor`, `perf`,
   `test`, `build`, `ci`, `chore`, `revert`. Add `!` after the type
   for a breaking change (`feat!: rename rec.say to rec.caption`) and explain
   it in the body.
4. **Run the checks** from [Set up the repository](#set-up-the-repository)
   and try the change as described above.
5. **Push to your fork and open the pull request** against `datafloem/runcast:main`.
   The title follows the same Conventional Commits style, because it becomes
   the commit message on `main`. CI checks it, and checks it again when you
   rename the pull request.
6. **Fill in the template.** Say what changed, why, and how you tested it.
   For a visible change (camera, cursor, captions, title cards, transitions),
   attach a short clip or a few frames.
7. **Mark it as a draft** if it isn't ready for review yet.

Don't bump the plugin version in a pull request. Maintainers do that when they
release.

## Review and merge

- The **check** job must pass: it checks the branch name and the title,
  typechecks the kit and runs `check-plugin.mjs`.
- CodeQL code scanning must find no high or critical security alerts and
  no error-level alerts.
- A maintainer reviews every pull request. New pushes dismiss earlier
  approvals, and all review conversations must be resolved before merging.
- Pull requests are **squash-merged**, so `main` has one commit per pull
  request and a straight history. You don't need to squash your own commits.
- If `main` moved on and your branch conflicts, rebase it on `main` or merge
  `main` into it. Force-pushing your own branch is fine.

We try to give a first answer within a week. If a pull request goes quiet for
a month after review comments, we may close it. You can reopen it any time.

## Releases

Maintainers only:

1. Bump `version` in `plugins/runcast/.claude-plugin/plugin.json`,
   `plugins/runcast/plugin.json` and `kit/package.json` together. Users get a
   new runtime for each version.
2. Merge to `main`, then tag the release commit `vX.Y.Z` and create a GitHub
   release with the notable changes. Only admins can create, move or delete
   tags.

## License

Runcast is [MIT licensed](LICENSE). By opening a pull request you agree that
your contribution is released under the same license.
