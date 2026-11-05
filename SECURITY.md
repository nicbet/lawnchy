# Security

## Reporting a vulnerability

Please don't open a public issue. Use [GitHub's private vulnerability reporting](https://github.com/nicbet/lawnchy/security/advisories/new) instead, with steps to reproduce if you can. This is a volunteer project, so there's no guaranteed response time, but reports are taken seriously.

Fixes go into the latest release only.

## Scanning repositories you don't trust

lawnchy runs `git status` and similar commands in every repository it finds, and git reads each repository's own configuration when it does. Some of that configuration can run programs, such as filters for files that have changed.

Here's what limits that risk:

- Git's `safe.directory` check refuses repositories owned by another user, and lawnchy shows these as `✗ error`.
- lawnchy turns off `core.fsmonitor`, which a repository could otherwise use to start a program just by being looked at.

These don't cover everything, particularly for a repository you own, such as one you unpacked from an archive. **Treat scanning a repository like running `git status` in it**, and don't point lawnchy at a folder containing repositories you don't trust. Opening a repository in lazygit carries the same risk.

## Your config file

Agents and launchables run through `sh` with your permissions, exactly as written in your config file. They only ever run when you press their key, and lawnchy never reads them from a scanned repository. An agent launched in a repository can also act on whatever that repository contains, so the same caution applies.
