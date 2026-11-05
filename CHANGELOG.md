# Changelog

Notable changes to lawnchy. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Finds every git repository under a directory and shows each one's trunk, with other worktrees and branches as sub-rows
- Separate status and sync columns, covering working tree changes and upstream state
- Folding, keyboard navigation, and rescanning with `r`
- Filtering with `/`, by regular expression or plain string
- Hiding repos with nothing to act on with `b`
- Opening the highlighted row in lazygit with `Enter` or `o`
- Running a coding agent in the highlighted folder with `a`, or choosing one with `A`
- A launch dialog on `x`, with one-key launchers defined in the config file and a built-in terminal
- Configuration in `~/.config/lawnchy/config.toml`
- A message, terminal title and `LAWNCHY` environment variable while a launched program is running
- `--version` and `--help`
- `make build` and `make install` for a standalone binary
