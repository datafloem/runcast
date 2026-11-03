# GitHub rulesets

The repository's rules on GitHub, kept here so they are reviewed like code.
GitHub doesn't read these files by itself: a maintainer imports them in
**Settings > Rules > Rulesets > New ruleset > Import a ruleset**. After you
change a rule in GitHub, export it from the same page and replace the file here.

| File        | Applies to | What it does                                                                                                                                                                                                                                  |
| ----------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.json` | `main`     | Changes go through a pull request with 1 approval and resolved conversations; a new push dismisses earlier approvals; the `check` job must pass; code quality must report no errors; squash merge only; no force-push, no deletion. |
| `tags.json` | all tags   | Only admins can create, move or delete tags.                                                                                                                                                                                                  |

Repository admins can bypass `main.json` **only through a pull request**:
they can merge their own pull request without a second approval, but they
can't push to `main` directly either. Remove the bypass once there is more
than one maintainer. Admins bypass `tags.json` always, so they can tag
releases.

`integration_id` 15368 is GitHub Actions, so only the Actions job named
`check` (`.github/workflows/check.yml`) satisfies the status check. On pull
requests the job also checks the branch name and the title
(`.github/scripts/check-pr-name.sh`). A ruleset can't do that for pull
requests from forks.

The `code_quality` rule needs GitHub Code Quality turned on first:
**Settings > Code security > Code quality**. Without it, import the ruleset
without that rule.
