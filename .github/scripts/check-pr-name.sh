#!/usr/bin/env bash
# Checks a pull request's branch name and title (see CONTRIBUTING.md).
# usage: BRANCH=<head branch> TITLE=<pull request title> bash check-pr-name.sh
set -uo pipefail

TYPES="feat|fix|docs|refactor|perf|test|build|ci|chore|revert"
status=0

# Branch: <type>/<lowercase-words-with-hyphens>, or a Dependabot branch.
if [[ "$BRANCH" =~ ^dependabot/ ]]; then
  :
elif [[ ! "$BRANCH" =~ ^($TYPES)/[a-z0-9][a-z0-9._-]*$ ]]; then
  echo "::error::Branch \"$BRANCH\" should look like feat/fade-transition: one of $TYPES, a slash, then lowercase words with hyphens."
  status=1
fi

# Title: Conventional Commits, it becomes the commit message on main.
if [[ ! "$TITLE" =~ ^($TYPES)(\([a-z0-9._-]+\))?!?:\ [^[:space:]].* ]]; then
  echo "::error::Title \"$TITLE\" should look like \"fix: keep the cursor on screen\": one of $TYPES, an optional (scope), an optional !, a colon and a summary."
  status=1
fi

[[ $status -eq 0 ]] && echo "Branch and title are fine: $BRANCH / $TITLE"
exit $status
