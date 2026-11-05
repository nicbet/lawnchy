# Contributing to lawnchy

Thanks for helping out. For anything bigger than a small fix, please open an issue first so we can agree on the approach.

## Setup

You'll need [Bun](https://bun.sh) 1.3.14 or newer and Git 2.36 or newer.

```bash
bun install
bun start ~/code     # run it against a folder of repos
bun run dev ~/code   # same, restarting on changes
make test            # typecheck and tests
make build           # compile dist/lawnchy
```

## How the code is organized

| File | Responsibility |
| --- | --- |
| `src/scan.ts` | Finds repositories under a directory |
| `src/git.ts` | Runs git, parses its output, and decides what each repo row and sub-row shows |
| `src/rows.ts` | Turns repos into display rows; pure functions for text, colors and layout |
| `src/useRepos.ts` | Streams scan and status results into React state |
| `src/App.tsx` | The UI and key handling |
| `src/config.ts` | Reads the config file, and saves the default agent |
| `src/handover.ts` | Hands the terminal to lazygit, agents and launchables, and takes it back |

## Guidelines

- **lawnchy only reads.** Commands that run automatically must never change a repository, take its locks or touch the network.
- **Every failure becomes a status.** One bad repo must never affect the others or crash the UI.
- **Test against real git.** `test/git.test.ts` builds real repositories in temp folders. Prefer that to mocking git's output when behavior depends on git.
- **Keep the terminal in mind.** Check your change in a real terminal, including a narrow window. Tests can't catch everything about how a screen looks.
- **Update the docs.** If you change a key, status or behavior, update `README.md` and add a line to `CHANGELOG.md`.

## Updating the demo

`docs/demo.gif` and `docs/screenshot.png` are recorded from fictional repos, so they contain nothing personal. If your change affects how the screen looks, regenerate them with [VHS](https://github.com/charmbracelet/vhs):

```bash
make build
docs/demo/setup.sh
vhs docs/demo/demo.tape
```

## Releasing

1. Update `version` in `package.json` and move the `CHANGELOG.md` entries under the new version.
2. Commit, then tag and push: `git tag v0.2.0 && git push origin main v0.2.0`.

The release workflow checks that the tag matches `package.json`, runs the tests, builds each platform's binary, and publishes a GitHub release.
