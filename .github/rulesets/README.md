# GitHub rulesets

The repository's rules on GitHub, kept here so they are reviewed like code.
GitHub doesn't read these files by itself: a maintainer imports them in
**Settings > Rules > Rulesets > New ruleset > Import a ruleset**. After you
change a rule in GitHub, export it from the same page and replace the file here.

| File                | Applies to   | What it does                                                                                                                                                                                       |
| ------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.json`         | `main`       | Changes go through a pull request with 1 approval and resolved conversations; a new push dismisses earlier approvals; the `check` job must pass; squash merge only; no force-push, no deletion. |
| `release-tags.json` | `v*` tags    | Only admins can create, move or delete release tags.                                                                                                                                               |

Repository admins can bypass `main.json` **only through a pull request**:
they can merge their own pull request without a second approval, but they
can't push to `main` directly either. Remove the bypass once there is more
than one maintainer.

`integration_id` 15368 is GitHub Actions, so only the Actions job named
`check` (`.github/workflows/check.yml`) satisfies the status check.
