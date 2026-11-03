<!--
Thanks for contributing! CI checks two names (see CONTRIBUTING.md):
- Branch: <type>/<lowercase-words>, for example fix/cursor-after-scroll.
- Title: Conventional Commits, for example "fix: keep the cursor on screen
  after a scroll". It becomes the commit message on main.
-->

## What and why

<!-- What does this change, and what problem does it solve? Link the issue: "Closes #123". -->

## How I tested it

<!-- Commands you ran and what you saw. For visible changes (camera, cursor,
captions, title cards, transitions), attach a short clip or a few frames. -->

- [ ] Typecheck passes (`tsc -p plugins/runcast/skills/runcast-setup/kit --noEmit`)
- [ ] `node .github/scripts/check-plugin.mjs` passes
- [ ] Ran the login scenario in a scratch project (`setup`, then `test`; `rehearsal` / `video` if recording changed)
- [ ] Linux self-test, only for Xvfb, x11grab or Linux setup changes

## Checklist

- [ ] No real app names, screens, URLs, colours or accounts. Examples use the made-up customers/orders app.
- [ ] Commands in docs and skills work in a project that installs nothing (`.kit/cli.ts`, no bare `npx playwright`).
- [ ] Skills, kit README, root README and templates are updated if behaviour changed.
- [ ] Anything new the kit downloads, contacts or writes is listed in `plugins/runcast/README.md`.
- [ ] No breaking change to `core/index.ts`, or it is explained below.
- [ ] The plugin version is not bumped (maintainers do this when releasing).

## Breaking changes

<!-- Delete this section if there are none. Otherwise say what projects must change. -->
