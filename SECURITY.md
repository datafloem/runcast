# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for a security problem.

Report it privately through GitHub:
[Security > Report a vulnerability](https://github.com/datafloem/runcast/security/advisories/new).
Only the maintainers can see the report.

Include:

- what the problem is and what an attacker could do with it,
- the steps or a small example that shows it,
- the Runcast version (`version` in `plugins/runcast/plugin.json`) and your
  operating system.

We aim to confirm the report within a week and keep you updated until it is
fixed. Once a fix is released, we publish an advisory and credit you unless
you'd rather stay anonymous.

## Supported versions

Only the latest release gets security fixes.

## Scope

Things worth reporting include:

- the kit leaking credentials from `.env.local`, OAuth tokens or the YouTube
  client secret into logs, videos, screenshots or files that are committed by
  default,
- the setup or runtime writing outside the project folder and
  `~/.cache/runcast/`,
- a skill that tells an AI assistant to do something unsafe.

Private data showing up in a video because a scenario didn't blur it is a
scenario problem, not a kit vulnerability. If the blur feature itself fails,
open a normal bug report.
