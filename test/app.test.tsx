import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { act } from "react"
import { testRender } from "@opentui/react/test-utils"
import { App } from "../src/App.tsx"
import type { Agent, AgentConfig, LaunchableConfig } from "../src/config.ts"
import type { Branch, Repo, Sync } from "../src/git.ts"
import { buildRows, COLORS, columnWidths, compileFilter, fit, isBoring, nameParts, type Row, scrollOffset, shortenStart, spreadEvenly } from "../src/rows.ts"
import { makeRepo, makeTemp, sh } from "./helpers.ts"

// Git finishes outside any act() scope, so React would warn about every status update.
const consoleError = console.error
console.error = (...args: unknown[]) => {
  if (!String(args[0]).includes("not wrapped in act")) consoleError(...args)
}

let dir: string
let cleanup: () => Promise<void>
// Tells React this environment supports act().
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let setup: Awaited<ReturnType<typeof testRender>> | undefined

beforeEach(async () => {
  ;({ dir, cleanup } = await makeTemp())
})
afterEach(async () => {
  await setup?.dispose()
  setup = undefined
  await cleanup()
})

/** Waits on real time: frames only change once real git subprocesses have finished. */
async function waitForFrame(predicate: (frame: string) => boolean): Promise<string> {
  const deadline = Date.now() + 10_000
  while (true) {
    await act(async () => {
      await Bun.sleep(20)
    })
    await setup!.flush()
    const frame = setup!.captureCharFrame()
    if (predicate(frame)) return frame
    if (Date.now() > deadline) throw new Error(`Timed out waiting for frame:\n${frame}`)
  }
}

async function press(run: () => void) {
  await act(async () => run())
  await setup!.flush()
}

test("renders repos with worktree and branch sub-rows, and folds them", async () => {
  const alpha = await makeRepo(join(dir, "alpha"))
  sh(alpha, "branch", "idle")
  sh(alpha, "worktree", "add", "-q", join(dir, "alpha-wt"), "-b", "wt-branch")
  await writeFile(join(dir, "alpha-wt", "new.txt"), "x")
  const beta = await makeRepo(join(dir, "group/beta"))
  await writeFile(join(beta, "file.txt"), "changed\n")

  setup = await testRender(<App root={dir} />, { width: 110, height: 16 })
  const frame = await waitForFrame((f) => f.includes("wt-branch") && f.includes("~1") && !f.includes("scanning"))

  expect(frame).toContain("2 repos")
  expect(frame).toContain("▾ alpha")
  expect(frame).toMatch(/├─ worktree \.\.\/alpha-wt\s+wt-branch\s+\?1/)
  expect(frame).toMatch(/└─ branch\s+idle\s+—/)
  expect(frame).toMatch(/group\/beta\s+main\s+~1/)
  // Repos with no extra worktrees or branches have no children, and the current
  // branch of the main checkout lives on the repo row rather than a sub-row.
  expect(frame).not.toMatch(/branch\s+main/)
  expect(frame).toContain(alpha) // detail line for the selected first row

  // Collapsing keeps the dirty worktree visible through the summary.
  await press(() => setup!.mockInput.pressKey("h"))
  let collapsed = setup.captureCharFrame()
  expect(collapsed).toContain("▸ alpha (2, 1 dirty)")
  expect(collapsed).not.toContain("wt-branch")

  await press(() => setup!.mockInput.pressKey("l"))
  await press(() => setup!.mockInput.pressKey("j"))
  await press(() => setup!.mockInput.pressKey("j"))
  expect(setup.captureCharFrame()).toContain("idle has no upstream")

  // Left from a child jumps to its repo first; a second press folds it.
  await press(() => setup!.mockInput.pressKey("h"))
  expect(setup.captureCharFrame()).toContain("idle")
  await press(() => setup!.mockInput.pressKey("h"))
  collapsed = setup.captureCharFrame()
  expect(collapsed).not.toContain("idle")
})

test("keeps the trunk on the repo row when the checkout is on another branch", async () => {
  const repo = await makeRepo(join(dir, "repo"))
  sh(repo, "checkout", "-qb", "feature")
  await writeFile(join(repo, "file.txt"), "changed\n")

  setup = await testRender(<App root={dir} />, { width: 110, height: 12 })
  const frame = await waitForFrame((f) => f.includes("feature") && !f.includes("scanning"))
  expect(frame).toMatch(/▾ repo\s+main\s+—/)
  expect(frame).toMatch(/└─ worktree \.\s+feature\s+~1/)
  expect(frame).toContain(`not checked out  ${repo}`)
})

test("b hides boring repos and shows them again", async () => {
  await makeRepo(join(dir, "quiet"))
  const busy = await makeRepo(join(dir, "busy"))
  await writeFile(join(busy, "file.txt"), "changed\n")

  setup = await testRender(<App root={dir} />, { width: 110, height: 12 })
  await waitForFrame((f) => f.includes("2 repos") && !f.includes("scanning") && !f.includes("loading"))

  await press(() => setup!.mockInput.pressKey("b"))
  const hidden = setup.captureCharFrame()
  expect(hidden).toContain("2 repos (1 boring hidden)")
  expect(hidden).toContain("busy")
  expect(hidden).not.toContain("quiet")

  await press(() => setup!.mockInput.pressKey("b"))
  const shown = setup.captureCharFrame()
  expect(shown).toContain("quiet")
  expect(shown).not.toContain("hidden")
})

test("says so when every repo is hidden, rather than claiming none exist", async () => {
  await makeRepo(join(dir, "quiet"))
  setup = await testRender(<App root={dir} />, { width: 110, height: 12 })
  await waitForFrame((f) => f.includes("✓") && !f.includes("scanning"))

  await press(() => setup!.mockInput.pressKey("b"))
  const frame = setup.captureCharFrame()
  expect(frame).toContain("Press b to show boring repos")
  expect(frame).not.toContain("No git repositories")
})

test("sync states use the same text and colours on checkouts and branches", () => {
  const sync = (overrides: Partial<Sync>): Sync => ({ upstream: "origin/x", gone: false, ahead: 0, behind: 0, ...overrides })
  const rowsFor = (s: Sync) => {
    const status = { kind: "ok", branch: "main", oid: "abc", staged: 0, modified: 0, untracked: 0, conflicted: 0, sync: s } as const
    const repo: Repo = {
      path: "/r/a",
      branch: "main",
      statusPath: "/r/a",
      status,
      worktrees: [],
      branches: [{ name: "x", worktreePath: null, sync: s }],
    }
    const [repoRow, branchRow] = buildRows([repo], "/r", new Set())
    // Status is only ever about changes, whatever the sync state.
    expect(repoRow!.status).toEqual({ text: "✓", color: COLORS.ok })
    expect(branchRow!.status).toEqual({ text: "" })
    return { checkout: repoRow!.sync, branch: branchRow!.sync }
  }

  const inSync = { text: "✓", color: COLORS.ok }
  expect(rowsFor(sync({}))).toEqual({ checkout: inSync, branch: inSync })
  const none = { text: "—", color: COLORS.dim }
  expect(rowsFor(sync({ upstream: null }))).toEqual({ checkout: none, branch: none })
  const gone = { text: "✗", color: COLORS.bad }
  expect(rowsFor(sync({ gone: true }))).toEqual({ checkout: gone, branch: gone })
  const arrows = { text: "↑2 ↓1", color: COLORS.info }
  expect(rowsFor(sync({ ahead: 2, behind: 1 }))).toEqual({ checkout: arrows, branch: arrows })
})

test("the detail line puts sync problems into words", () => {
  const detailsFor = (sync: Sync, kind: "ok" | "idle" = "ok") => {
    const status =
      kind === "idle"
        ? ({ kind, sync } as const)
        : ({ kind, branch: "main", oid: "abc", staged: 0, modified: 0, untracked: 0, conflicted: 0, sync } as const)
    const repo: Repo = {
      path: "/r/a",
      branch: "main",
      statusPath: "/r/a",
      status,
      worktrees: [],
      branches: [{ name: "x", worktreePath: null, sync }],
    }
    const [repoRow, branchRow] = buildRows([repo], "/r", new Set())
    return [repoRow!.detail.text, branchRow!.detail.text]
  }
  const sync = { upstream: "origin/x", gone: false, ahead: 0, behind: 0 }

  expect(detailsFor(sync)).toEqual(["/r/a", "x → origin/x"])
  expect(detailsFor({ ...sync, upstream: null })).toEqual(["/r/a", "x has no upstream"])
  expect(detailsFor({ ...sync, gone: true })).toEqual(["upstream gone  /r/a", "x → origin/x (gone)"])
  expect(detailsFor(sync, "idle")[0]).toBe("not checked out  /r/a")
  expect(detailsFor({ ...sync, gone: true }, "idle")[0]).toBe("not checked out, upstream gone  /r/a")
})

test("a trunk that isn't checked out has a blank status and shows its sync state", () => {
  const repo: Repo = {
    path: "/r/a",
    branch: "main",
    statusPath: "/r/a",
    status: { kind: "idle", sync: { upstream: "origin/main", gone: false, ahead: 0, behind: 3 } },
    worktrees: [],
    branches: [],
  }
  const [row] = buildRows([repo], "/r", new Set())
  expect(row!.status).toEqual({ text: "" })
  expect(row!.sync).toEqual({ text: "↓3", color: COLORS.info })
})

test("isBoring flags only repos with nothing to act on", () => {
  const quiet = { upstream: "origin/main", gone: false, ahead: 0, behind: 0 }
  const clean = { kind: "ok", branch: "main", oid: "abc", staged: 0, modified: 0, untracked: 0, conflicted: 0, sync: quiet } as const
  const repo = (overrides: Partial<Repo>): Repo => ({
    path: "/r", branch: "main", statusPath: "/r", status: clean, worktrees: [], branches: [], ...overrides,
  })
  const branch = (sync: Partial<Branch["sync"]>): Branch => ({
    name: "x", worktreePath: null, sync: { ...quiet, ...sync },
  })

  expect(isBoring(repo({}))).toBe(true)
  expect(isBoring(repo({ status: { ...clean, sync: { ...quiet, upstream: null } } }))).toBe(true)
  expect(isBoring(repo({ branches: [branch({ upstream: null })] }))).toBe(true)
  expect(isBoring(repo({ status: { kind: "bare" } }))).toBe(true)

  expect(isBoring(repo({ status: { ...clean, untracked: 1 } }))).toBe(false)
  expect(isBoring(repo({ status: { ...clean, branch: null } }))).toBe(false)
  expect(isBoring(repo({ status: { ...clean, sync: { ...quiet, ahead: 1 } } }))).toBe(false)
  expect(isBoring(repo({ status: { ...clean, sync: { ...quiet, gone: true } } }))).toBe(false)
  expect(isBoring(repo({ status: { kind: "idle", sync: { ...quiet, behind: 1 } } }))).toBe(false)
  expect(isBoring(repo({ status: { kind: "loading" } }))).toBe(false)
  expect(isBoring(repo({ status: { kind: "error", message: "x" } }))).toBe(false)
  expect(isBoring(repo({ worktrees: [{ path: "/w", branch: "w", status: clean }] }))).toBe(false)
  expect(isBoring(repo({ branches: [branch({ behind: 1 })] }))).toBe(false)
  expect(isBoring(repo({ branches: [branch({ gone: true })] }))).toBe(false)
})

describe("filter", () => {
  async function renderRepos() {
    await makeRepo(join(dir, "group/quiet-api"))
    const busy = await makeRepo(join(dir, "group/busy-api"))
    await writeFile(join(busy, "file.txt"), "changed\n")
    await makeRepo(join(dir, "other/web"))
    setup = await testRender(<App root={dir} />, { width: 110, height: 12 })
    await waitForFrame((f) => f.includes("3 repos") && !f.includes("scanning") && !f.includes("loading"))
  }
  const type = (text: string) => press(() => setup!.mockInput.typeText(text))
  /** A lone Esc is held briefly in case it starts an escape sequence, so wait on real time. */
  async function pressEscapeUntil(predicate: (frame: string) => boolean) {
    await press(() => setup!.mockInput.pressEscape())
    return waitForFrame(predicate)
  }

  test("narrows as you type, and letters reach the input instead of acting as keys", async () => {
    await renderRepos()
    await press(() => setup!.mockInput.pressKey("/"))
    expect(setup!.captureCharFrame()).toContain("string or regexp")

    // Contains q, b and r, which would quit, hide boring repos and refresh.
    await type("qui")
    let frame = setup!.captureCharFrame()
    expect(frame).toContain(`3 repos (1 match "qui")`)
    expect(frame).toContain("group/quiet-api")
    expect(frame).not.toContain("other/web")

    await press(() => setup!.mockInput.pressEnter())
    frame = setup!.captureCharFrame()
    expect(frame).toContain("/ filter")
    expect(frame).toContain(`1 match "qui"`)

    // Reopening edits the same text, and the "/" that opened it isn't inserted.
    await press(() => setup!.mockInput.pressKey("/"))
    await press(() => setup!.mockInput.pressBackspace())
    expect(setup!.captureCharFrame()).toContain(`match "qu"`)
  })

  test("accepts a regexp and falls back to a literal string", async () => {
    await renderRepos()
    await press(() => setup!.mockInput.pressKey("/"))
    await type("^GROUP/.*api$")
    let frame = setup!.captureCharFrame()
    expect(frame).toContain("2 match")
    expect(frame).not.toContain("other/web")

    await pressEscapeUntil((f) => !f.includes("match"))
    await press(() => setup!.mockInput.pressKey("/"))
    await type("c++")
    frame = setup!.captureCharFrame()
    expect(frame).toContain(`No repos match "c++"`)
  })

  test("respects boring mode", async () => {
    await renderRepos()
    await press(() => setup!.mockInput.pressKey("b"))
    await press(() => setup!.mockInput.pressKey("/"))
    await type("api")
    await press(() => setup!.mockInput.pressEnter())
    let frame = setup!.captureCharFrame()
    expect(frame).toContain(`3 repos (2 match "api", 1 boring hidden)`)
    expect(frame).toContain("group/busy-api")
    expect(frame).not.toContain("group/quiet-api")

    await press(() => setup!.mockInput.pressKey("b"))
    frame = setup!.captureCharFrame()
    expect(frame).toContain("group/quiet-api")
    expect(frame).toContain("group/busy-api")
  })

  test("Esc clears it, both while typing and after", async () => {
    await renderRepos()
    await press(() => setup!.mockInput.pressKey("/"))
    await type("web")
    const frame = await pressEscapeUntil((f) => !f.includes("match"))
    expect(frame).toContain("group/busy-api")
    expect(frame).toContain("/ filter")

    await press(() => setup!.mockInput.pressKey("/"))
    await type("web")
    await press(() => setup!.mockInput.pressEnter())
    expect(setup!.captureCharFrame()).not.toContain("group/busy-api")
    await pressEscapeUntil((f) => f.includes("group/busy-api"))
  })
})

describe("opening lazygit", () => {
  async function renderWith(result: string | null = null) {
    const opened: string[] = []
    const open = async (_renderer: unknown, path: string) => {
      opened.push(path)
      return result
    }
    setup = await testRender(<App root={dir} openInLazygit={open} />, { width: 110, height: 14 })
    await waitForFrame((f) => !f.includes("scanning") && !f.includes("loading"))
    return opened
  }

  test("each row kind opens its own folder, with Enter or o", async () => {
    const repo = await makeRepo(join(dir, "repo"))
    const linked = join(dir, "repo-wt")
    sh(repo, "worktree", "add", "-q", linked, "-b", "wt")
    sh(repo, "branch", "idle")
    const opened = await renderWith()

    await press(() => setup!.mockInput.pressEnter())
    await press(() => setup!.mockInput.pressKey("j"))
    await press(() => setup!.mockInput.pressKey("o"))
    await press(() => setup!.mockInput.pressKey("j"))
    await press(() => setup!.mockInput.pressEnter())
    expect(opened).toEqual([repo, linked, repo])
  })

  test("a repo row opens the linked worktree holding the trunk", async () => {
    const repo = await makeRepo(join(dir, "repo"))
    sh(repo, "checkout", "-qb", "feature")
    const linked = join(dir, "trunk-wt")
    sh(repo, "worktree", "add", "-q", linked, "main")
    const opened = await renderWith()

    await press(() => setup!.mockInput.pressKey("o"))
    expect(opened).toEqual([linked])
  })

  test("doesn't open a broken repo or a missing worktree", async () => {
    await mkdir(join(dir, "broken/.git"), { recursive: true })
    const opened = await renderWith()
    await waitForFrame((f) => f.includes("✗ error"))
    await press(() => setup!.mockInput.pressKey("o"))
    expect(opened).toEqual([])
  })

  test("Enter in the filter input doesn't open anything, and Space still folds", async () => {
    const repo = await makeRepo(join(dir, "repo"))
    sh(repo, "branch", "idle")
    const opened = await renderWith()

    await press(() => setup!.mockInput.pressKey("/"))
    await press(() => setup!.mockInput.typeText("repo"))
    await press(() => setup!.mockInput.pressEnter())
    expect(opened).toEqual([])

    await press(() => setup!.mockInput.pressKey(" "))
    expect(setup!.captureCharFrame()).toContain("▸ repo")
    await press(() => setup!.mockInput.pressKey(" "))
    expect(setup!.captureCharFrame()).toContain("▾ repo")
  })

  test("refreshes afterwards, and shows a failure until the next key", async () => {
    const repo = await makeRepo(join(dir, "repo"))
    await renderWith("lazygit exited with code 1")
    await writeFile(join(repo, "file.txt"), "changed\n")

    await press(() => setup!.mockInput.pressKey("o"))
    const frame = await waitForFrame((f) => f.includes("~1"))
    expect(frame).toContain("lazygit exited with code 1")

    await press(() => setup!.mockInput.pressKey("j"))
    expect(setup!.captureCharFrame()).not.toContain("lazygit exited")
  })
})

describe("launching an agent", () => {
  const claude = { name: "claude", command: "claude --continue" }
  const codex = { name: "codex", command: "codex" }

  async function renderWith(config: Partial<AgentConfig>, result: string | null = null) {
    const launched: Array<{ agent: string; path: string }> = []
    const saved: string[] = []
    const launchService = {
      load: async () => ({ agents: [claude, codex], defaultAgent: null, error: null, ...config }),
      loadLaunchables: async () => ({ launchables: [], error: null }),
      saveDefault: async (name: string) => {
        saved.push(name)
      },
      run: async (_renderer: unknown, agent: Agent, path: string) => {
        launched.push({ agent: agent.name, path })
        return result
      },
    }
    setup = await testRender(<App root={dir} launchService={launchService} />, { width: 110, height: 16 })
    await waitForFrame((f) => !f.includes("scanning") && !f.includes("loading"))
    return { launched, saved }
  }
  const key = (name: string, modifiers?: { shift?: boolean }) => press(() => setup!.mockInput.pressKey(name, modifiers))

  test("a runs the default agent in the highlighted row's folder, without asking", async () => {
    const repo = await makeRepo(join(dir, "repo"))
    const linked = join(dir, "repo-wt")
    sh(repo, "worktree", "add", "-q", linked, "-b", "wt")
    const { launched } = await renderWith({ defaultAgent: "codex" })

    await key("a")
    await waitForFrame(() => launched.length === 1)
    await key("j")
    await key("a")
    await waitForFrame(() => launched.length === 2)
    expect(launched).toEqual([
      { agent: "codex", path: repo },
      { agent: "codex", path: linked },
    ])
    expect(setup!.captureCharFrame()).not.toContain("Launch agent")
  })

  test("a asks when there's no default, and Enter launches the highlighted agent", async () => {
    const repo = await makeRepo(join(dir, "repo"))
    const { launched } = await renderWith({})

    await key("a")
    const frame = await waitForFrame((f) => f.includes("Launch agent"))
    expect(launched).toEqual([])
    expect(frame).toContain("claude --continue")
    expect(frame).toContain(repo.slice(-20))

    await key("j")
    await press(() => setup!.mockInput.pressEnter())
    await waitForFrame(() => launched.length === 1)
    expect(launched).toEqual([{ agent: "codex", path: repo }])
    expect(setup!.captureCharFrame()).not.toContain("Launch agent")
  })

  test("A always asks, starting on the default", async () => {
    const repo = await makeRepo(join(dir, "repo"))
    const { launched } = await renderWith({ defaultAgent: "codex" })

    await key("a", { shift: true })
    const frame = await waitForFrame((f) => f.includes("Launch agent"))
    expect(frame).toMatch(/codex\s+codex\s+default/)
    expect(launched).toEqual([])

    await press(() => setup!.mockInput.pressEnter())
    await waitForFrame(() => launched.length === 1)
    expect(launched).toEqual([{ agent: "codex", path: repo }])
  })

  test("the picker takes all keys until Esc closes it", async () => {
    await makeRepo(join(dir, "one"))
    await makeRepo(join(dir, "two"))
    const { launched } = await renderWith({})

    await key("a")
    await waitForFrame((f) => f.includes("Launch agent"))
    await key("b")
    await key("o")
    await key("q")
    await key("/")
    const open = setup!.captureCharFrame()
    expect(open).toContain("Launch agent")
    expect(open).not.toContain("boring hidden")
        expect(setup!.renderer.isDestroyed).toBe(false)
    expect(launched).toEqual([])

    await press(() => setup!.mockInput.pressEscape())
    await waitForFrame((f) => !f.includes("Launch agent"))
    expect(launched).toEqual([])
  })

  test("d saves the highlighted agent as the default", async () => {
    await makeRepo(join(dir, "repo"))
    const { saved, launched } = await renderWith({ defaultAgent: "claude" })

    await key("a", { shift: true })
    await waitForFrame((f) => f.includes("Launch agent"))
    await key("j")
    await key("d")
    expect(saved).toEqual(["codex"])
    const frame = setup!.captureCharFrame()
    expect(frame).toMatch(/codex\s+codex\s+default/)
    expect(frame).not.toMatch(/claude --continue\s+default/)
    expect(launched).toEqual([])
  })

  test("doesn't start on a broken row, or with no agents", async () => {
    await mkdir(join(dir, "broken/.git"), { recursive: true })
    const { launched } = await renderWith({ defaultAgent: "claude" })
    await waitForFrame((f) => f.includes("✗ error"))
    await key("a")
    await Bun.sleep(30)
    expect(launched).toEqual([])
    expect(setup!.captureCharFrame()).not.toContain("Launch agent")
  })

  test("with no agents at all, says where to add one", async () => {
    await makeRepo(join(dir, "repo"))
    await renderWith({ agents: [] })
    await key("a")
    const frame = await waitForFrame((f) => f.includes("No agents found"))
    expect(frame).toContain("[agents]")
  })

  test("a config problem is shown, and the picker still works", async () => {
    await makeRepo(join(dir, "repo"))
    await renderWith({ error: "config is broken" })
    await key("a")
    const frame = await waitForFrame((f) => f.includes("Launch agent"))
    expect(frame).toContain("config is broken")
  })

  test("refreshes afterwards, and shows a failure", async () => {
    const repo = await makeRepo(join(dir, "repo"))
    await renderWith({ defaultAgent: "claude" }, "claude exited with code 1")
    await writeFile(join(repo, "file.txt"), "changed\n")
    await key("a")
    const frame = await waitForFrame((f) => f.includes("~1"))
    expect(frame).toContain("claude exited with code 1")
  })
})

describe("the launch dialog", () => {
  const code = { name: "code", key: "c", command: "code ." }
  const xpo = { name: "xpo", key: "x", command: "xpo board" }
  const shiftedCode = { name: "cursor", key: "C", command: "cursor ." }

  async function renderWith(config: Partial<LaunchableConfig>, result: string | null = null) {
    const launched: Array<{ name: string; path: string }> = []
    const launchService = {
      load: async () => ({ agents: [], defaultAgent: null, error: null }),
      loadLaunchables: async () => ({ launchables: [code, xpo, shiftedCode], error: null, ...config }),
      saveDefault: async () => {},
      run: async (_renderer: unknown, item: Agent, path: string) => {
        launched.push({ name: item.name, path })
        return result
      },
    }
    setup = await testRender(<App root={dir} launchService={launchService} />, { width: 110, height: 16 })
    await waitForFrame((f) => !f.includes("scanning") && !f.includes("loading"))
    return launched
  }
  const key = (name: string, modifiers?: { shift?: boolean }) => press(() => setup!.mockInput.pressKey(name, modifiers))
  const openDialog = async () => {
    await key("x")
    return waitForFrame((f) => f.includes("press a key"))
  }

  test("lists entries with their keys, and one keypress launches in the highlighted folder", async () => {
    const repo = await makeRepo(join(dir, "repo"))
    const linked = join(dir, "repo-wt")
    sh(repo, "worktree", "add", "-q", linked, "-b", "wt")
    const launched = await renderWith({})

    const frame = await openDialog()
    expect(frame).toMatch(/c\s+code\s+code \./)
    expect(frame).toMatch(/x\s+xpo\s+xpo board/)
    expect(launched).toEqual([])

    await key("c")
    await waitForFrame(() => launched.length === 1)
    expect(setup!.captureCharFrame()).not.toContain("press a key")

    await key("j")
    await openDialog()
    // The same key that opens the dialog can be an entry in it.
    await key("x")
    await waitForFrame(() => launched.length === 2)
    expect(launched).toEqual([
      { name: "code", path: repo },
      { name: "xpo", path: linked },
    ])
  })

  test("treats a shifted letter as its own key", async () => {
    await makeRepo(join(dir, "repo"))
    const launched = await renderWith({})
    await openDialog()
    await key("c", { shift: true })
    await waitForFrame(() => launched.length === 1)
    expect(launched[0]?.name).toBe("cursor")
  })

  test("ignores other keys until Esc closes it", async () => {
    await makeRepo(join(dir, "repo"))
    const launched = await renderWith({})
    await openDialog()
    await key("q")
    await key("b")
    await key("j")
    expect(setup!.captureCharFrame()).toContain("press a key")
    expect(setup!.renderer.isDestroyed).toBe(false)
    expect(setup!.captureCharFrame()).not.toContain("boring hidden")
    expect(launched).toEqual([])

    await press(() => setup!.mockInput.pressEscape())
    await waitForFrame((f) => !f.includes("press a key"))
    expect(launched).toEqual([])
  })

  test("shows a config problem, alongside any valid entries", async () => {
    await makeRepo(join(dir, "repo"))
    await renderWith({ error: "launchables.bad needs a command" })
    const frame = await openDialog()
    expect(frame).toContain("launchables.bad needs a command")
    expect(frame).toMatch(/c\s+code/)
  })

  test("doesn't open on a broken row", async () => {
    await mkdir(join(dir, "broken/.git"), { recursive: true })
    await renderWith({})
    await waitForFrame((f) => f.includes("✗ error"))
    await key("x")
    await Bun.sleep(30)
    expect(setup!.captureCharFrame()).not.toContain("press a key")
  })

  test("refreshes afterwards, and shows a failure", async () => {
    const repo = await makeRepo(join(dir, "repo"))
    await renderWith({}, "code exited with code 1")
    await writeFile(join(repo, "file.txt"), "changed\n")
    await openDialog()
    await key("c")
    const frame = await waitForFrame((f) => f.includes("~1"))
    expect(frame).toContain("code exited with code 1")
  })
})

test("compileFilter uses a regexp when valid and a literal otherwise", () => {
  expect(compileFilter("^api")("API-server")).toBe(true)
  expect(compileFilter("^api")("my-api")).toBe(false)
  expect(compileFilter("a.c")("abc")).toBe(true)
  expect(compileFilter("C++")("libc++")).toBe(true)
  expect(compileFilter("c++")("libc")).toBe(false)
  expect(compileFilter("[")("a[b")).toBe(true)
})

test("keys arriving before a redraw all count", async () => {
  for (const name of ["a", "b", "c", "d"]) await makeRepo(join(dir, name))
  setup = await testRender(<App root={dir} />, { width: 100, height: 14 })
  await waitForFrame((f) => f.includes("4 repos") && !f.includes("scanning") && !f.includes("loading"))

  // Inside one act() React doesn't re-render between the presses.
  await press(() => {
    setup!.mockInput.pressKey("j")
    setup!.mockInput.pressKey("j")
    setup!.mockInput.pressKey("j")
  })
  expect(setup.captureCharFrame()).toContain(join(dir, "d"))
})

test("r picks up changes and keeps the selection on the same row", async () => {
  const one = await makeRepo(join(dir, "one"))
  await makeRepo(join(dir, "two"))
  setup = await testRender(<App root={dir} />, { width: 100, height: 12 })
  await waitForFrame((f) => f.includes("2 repos") && !f.includes("scanning") && !f.includes("loading"))

  await press(() => setup!.mockInput.pressKey("j"))
  await makeRepo(join(dir, "a-new-first"))
  await writeFile(join(one, "file.txt"), "changed\n")
  await press(() => setup!.mockInput.pressKey("r"))
  const frame = await waitForFrame((f) => f.includes("3 repos") && f.includes("~1") && !f.includes("scanning"))
  // "two" stays selected even though a new row sorted in above it.
  expect(frame).toContain(join(dir, "two"))
})

test("rules frame the list, and scrolling keeps the selection between them", async () => {
  for (const name of ["a", "b", "c", "d", "e"]) await makeRepo(join(dir, name))
  // Four rows of chrome plus four rules leave room for three repos.
  setup = await testRender(<App root={dir} />, { width: 80, height: 11 })
  await waitForFrame((f) => f.includes("5 repos") && !f.includes("scanning") && !f.includes("loading"))

  const lines = () => setup!.captureCharFrame().split("\n")
  const rule = "─".repeat(80)
  const expectRules = () => {
    expect(lines()[1]).toBe(rule)
    expect(lines()[3]).toBe(rule)
    expect(lines()[7]).toBe(rule)
    expect(lines()[9]).toBe(rule)
  }
  expectRules()
  expect(lines()[2]).toContain("REPOSITORY")
  expect(lines()[4]).toContain("a ")
  expect(lines()[6]).toContain("c ")

  for (let i = 0; i < 4; i++) await press(() => setup!.mockInput.pressKey("j"))
  expectRules()
  expect(lines()[6]).toContain("e ")
  expect(lines()[8]).toStartWith("  ")
  expect(lines()[8]).toContain("/e")
  expect(lines()[10]).toStartWith("  ↑↓←→ nav")
  expect(lines()[10]).toContain("q quit")
})

test("the title row shows the root folder, with the count at the far right", async () => {
  await makeRepo(join(dir, "a"))
  const width = dir.length + 40
  setup = await testRender(<App root={dir} />, { width, height: 10 })
  await waitForFrame((f) => f.includes("1 repo") && !f.includes("scanning") && !f.includes("loading"))

  const title = setup.captureCharFrame().split("\n")[0]!
  expect(title.startsWith(`  lawnchy  ${dir}  `)).toBe(true)
  expect(title.endsWith("  1 repo  ")).toBe(true)
  expect(title.length).toBe(width)
})

test("a narrow title row shortens the path but never the count", async () => {
  await makeRepo(join(dir, "a"))
  // Temp paths vary in length by OS, so size the terminal just too small for this one.
  const width = dir.length + 18
  setup = await testRender(<App root={dir} />, { width, height: 10 })
  await waitForFrame((f) => f.includes("1 repo") && !f.includes("scanning") && !f.includes("loading"))

  const title = setup.captureCharFrame().split("\n")[0]!
  expect(title).toMatch(/^  lawnchy  …\S+  1 repo  $/)
  expect(title.length).toBe(width)
  expect(dir.endsWith(title.slice("  lawnchy  …".length, -"  1 repo  ".length))).toBe(true)
})

test("the help line spreads its entries across the full width", async () => {
  for (const width of [100, 137, 180]) {
    await setup?.dispose()
    setup = await testRender(<App root={dir} />, { width, height: 12 })
    const frame = await waitForFrame((f) => f.includes("No git repositories"))
    const help = frame.split("\n")[11]!
    expect(help.length).toBe(width)
    expect(help.startsWith("  ↑↓←→ nav ")).toBe(true)
    expect(help.endsWith(" +add ~mod ?new !conflict  ")).toBe(true)

    const entries = ["⏎ lazygit", "a agent", "x run", "/ filter", "b boring", "r refresh", "q quit", "+add ~mod ?new !conflict"]
    let end = "  ↑↓←→ nav".length
    const gaps = entries.map((entry) => {
      const start = help.indexOf(entry, end)
      const gap = start - end
      end = start + entry.length
      return gap
    })
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(1)
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1)
  }
})

test("spreadEvenly shares spare width between gaps", () => {
  expect(spreadEvenly(["a", "b", "c"], 9)).toBe("a   b   c")
  expect(spreadEvenly(["a", "b", "c"], 10)).toBe("a    b   c")
  expect(spreadEvenly(["a", "b", "c"], 11)).toBe("a    b    c")
  expect(spreadEvenly(["aa", "bb"], 3)).toBe("aa bb")
  expect(spreadEvenly(["a b", "日本"], 10)).toBe("a b   日本")
  expect(spreadEvenly(["only"], 10)).toBe("only")
})

test("shortenStart keeps the end of the text", () => {
  expect(shortenStart("/x/y", 10)).toBe("/x/y")
  expect(shortenStart("/long/path/name", 6)).toBe("…/name")
  expect(shortenStart("/long/path/name", 1)).toBe("")
})

test("shows an empty state", async () => {
  setup = await testRender(<App root={dir} />, { width: 80, height: 10 })
  const frame = await waitForFrame((f) => f.includes("No git repositories found"))
  expect(frame).toContain("0 repos")
})

test("fit pads and truncates to exact cell widths", () => {
  expect(fit("abc", 5)).toBe("abc  ")
  expect(fit("abcdef", 4)).toBe("abc…")
  expect(fit("日本語", 4)).toBe("日… ")
  expect(fit("x", 0)).toBe("")
})

test("scrollOffset keeps the selection visible and doesn't overscroll", () => {
  expect(scrollOffset(0, 3, 5, 20)).toBe(0)
  expect(scrollOffset(0, 7, 5, 20)).toBe(3)
  expect(scrollOffset(10, 4, 5, 20)).toBe(4)
  expect(scrollOffset(15, 2, 5, 3)).toBe(0)
})

test("colors a repo's path by segment, unless selected", async () => {
  await makeRepo(join(dir, "alpha"))
  await makeRepo(join(dir, "work/group/beta"))
  setup = await testRender(<App root={dir} />, { width: 110, height: 12 })
  await waitForFrame((f) => f.includes("work/group/beta") && !f.includes("loading") && !f.includes("scanning"))

  const spans = () => setup!.captureSpans().lines.flatMap((line) => line.spans)
  const fgOf = (span?: { fg: { toInts(): number[] } }) => span?.fg.toInts().slice(0, 3)
  const colorOf = (text: string) => fgOf(spans().find((s) => s.text.includes(text)))
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  // The unselected row's branch cell, which uses the default text color.
  const defaultColor = fgOf(spans().findLast((s) => s.text.includes("main")))

  expect(defaultColor).not.toEqual(rgb(COLORS.dim))
  expect(colorOf("alpha")).toEqual(rgb(COLORS.selectedFg))
  expect(colorOf("work/")).toEqual(rgb(COLORS.dim))
  expect(colorOf("group/")).toEqual(defaultColor)
  expect(colorOf("beta")).toEqual(rgb(COLORS.accent))

  await press(() => setup!.mockInput.pressKey("j"))
  expect(colorOf("alpha")).toEqual(rgb(COLORS.accent))
  expect(colorOf("work/group/beta")).toEqual(rgb(COLORS.selectedFg))
})

describe("nameParts", () => {
  const row = (kind: Row["kind"], name: string) => ({ kind, name, prefix: "", suffix: "" }) as Row

  test("splits a repo into parents, owner and name", () => {
    expect(nameParts(row("repo", "work/acme/tools/api"), 30)).toMatchObject({
      parent: "work/acme/",
      owner: "tools/",
      name: "api",
    })
  })

  test("treats the first of two segments as the owner", () => {
    expect(nameParts(row("repo", "acme/api"), 20)).toMatchObject({ parent: "", owner: "acme/", name: "api" })
  })

  test("treats a repo with no parent folder as all name", () => {
    expect(nameParts(row("repo", "sandbox"), 20)).toMatchObject({ parent: "", owner: "", name: "sandbox" })
  })

  test("leaves worktree names whole", () => {
    expect(nameParts(row("worktree", "../api-hotfix"), 20)).toMatchObject({
      parent: "",
      owner: "",
      name: "../api-hotfix",
    })
  })

  test("keeps the split in place when the name is truncated", () => {
    expect(nameParts(row("repo", "acme/some-long-name"), 10)).toMatchObject({ owner: "acme/", name: "some…" })
  })

  test("shows only owner text when truncation reaches the owner", () => {
    expect(nameParts(row("repo", "organization/api"), 8)).toMatchObject({ parent: "", owner: "organiz…", name: "" })
    expect(nameParts(row("repo", "acme/api"), 5)).toMatchObject({ parent: "", owner: "acme…", name: "" })
  })

  test("shows only parent text when truncation reaches the parents", () => {
    expect(nameParts(row("repo", "some-long-parent/acme/api"), 8)).toMatchObject({
      parent: "some-lo…",
      owner: "",
      name: "",
    })
  })

  test("keeps the total width constant", () => {
    const parts = nameParts({ ...row("repo", "work/acme/api"), prefix: "▸ ", suffix: " (2)" }, 20)
    expect(Bun.stringWidth(parts.prefix + parts.parent + parts.owner + parts.name + parts.suffix)).toBe(20)
  })
})

test("columnWidths fill the terminal when there's room", () => {
  const { name, branch, status, sync } = columnWidths(100)
  expect(name + branch + status + sync + 3).toBe(100)
})
