import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { loadRepo, parseBranches, parseStatus, parseWorktrees } from "../src/git.ts"
import { findRepos } from "../src/scan.ts"
import { makeRepo, makeTemp, sh } from "./helpers.ts"

describe("parseStatus", () => {
  test("counts entries and reads the branch headers", () => {
    const status = parseStatus(
      [
        "# branch.oid 1234567890abcdef",
        "# branch.head main",
        "# branch.upstream origin/main",
        "# branch.ab +2 -3",
        "1 M. N... 100644 100644 100644 a b staged.txt",
        "1 .M N... 100644 100644 100644 a b modified.txt",
        "1 MM N... 100644 100644 100644 a b both.txt",
        "2 R. N... 100644 100644 100644 a b R100 new.txt\told.txt",
        "u UU N... 100644 100644 100644 100644 a b c conflict.txt",
        "? untracked.txt",
      ].join("\n"),
    )
    expect(status).toMatchObject({
      branch: "main",
      oid: "1234567",
      staged: 3,
      modified: 2,
      untracked: 1,
      conflicted: 1,
      sync: { upstream: "origin/main", gone: false, ahead: 2, behind: 3 },
    })
  })

  test("recognises detached HEAD and a repo with no commits", () => {
    expect(parseStatus("# branch.oid abcdef123\n# branch.head (detached)\n").branch).toBeNull()
    expect(parseStatus("# branch.oid (initial)\n# branch.head main\n")).toMatchObject({ oid: null, branch: "main" })
  })

  test("an upstream without ahead/behind counts is gone", () => {
    expect(parseStatus("# branch.head a\n# branch.upstream origin/a\n").sync.gone).toBe(true)
    expect(parseStatus("# branch.head a\n").sync.gone).toBe(false)
  })
})

test("parseWorktrees handles branch, detached, bare and prunable entries", () => {
  const output = [
    "worktree /repo", "HEAD aaa", "branch refs/heads/feature/x", "",
    "worktree /wt", "HEAD bbb", "detached", "prunable gitdir file points to non-existent location", "",
    "worktree /bare", "bare", "", "",
  ].join("\0")
  expect(parseWorktrees(output)).toEqual([
    { path: "/repo", branch: "feature/x", bare: false, prunable: false },
    { path: "/wt", branch: null, bare: false, prunable: true },
    { path: "/bare", branch: null, bare: true, prunable: false },
  ])
})

test("parseBranches reads tracking info and worktree paths", () => {
  const output = [
    "main\0origin/main\0\0/repo",
    "a\0origin/a\0ahead 1, behind 2\0",
    "b\0origin/b\0gone\0",
    "c\0\0\0",
  ].join("\n")
  expect(parseBranches(output)).toEqual([
    { name: "main", worktreePath: "/repo", sync: { upstream: "origin/main", gone: false, ahead: 0, behind: 0 } },
    { name: "a", worktreePath: null, sync: { upstream: "origin/a", gone: false, ahead: 1, behind: 2 } },
    { name: "b", worktreePath: null, sync: { upstream: "origin/b", gone: true, ahead: 0, behind: 0 } },
    { name: "c", worktreePath: null, sync: { upstream: null, gone: false, ahead: 0, behind: 0 } },
  ])
})

describe("against real git", () => {
  let dir: string
  let cleanup: () => Promise<void>
  beforeEach(async () => {
    ;({ dir, cleanup } = await makeTemp())
  })
  afterEach(() => cleanup())

  test("findRepos finds .git folders only and stops descending at each one", async () => {
    const plain = await makeRepo(join(dir, "a/plain"))
    await makeRepo(join(plain, "sub/nested"))
    const sibling = await makeRepo(join(dir, "b/deep/sibling"))
    await makeRepo(join(dir, "node_modules/dep"))
    sh(plain, "worktree", "add", "-q", join(dir, "a/linked"), "-b", "linked")

    const found: string[] = []
    for await (const path of findRepos(dir)) found.push(path)
    expect(found.sort()).toEqual([plain, sibling].sort())
  })

  test("loadRepo reports main checkout, worktrees and uncovered branches", async () => {
    const repo = await makeRepo(join(dir, "repo"))
    sh(repo, "branch", "idle")
    const linked = join(dir, "linked")
    sh(repo, "worktree", "add", "-q", linked, "-b", "wt-branch")
    await writeFile(join(linked, "new.txt"), "x")
    await writeFile(join(repo, "file.txt"), "changed\n")

    const loaded = await loadRepo(repo)
    expect(loaded.status).toMatchObject({ kind: "ok", branch: "main", modified: 1, untracked: 0 })
    expect(loaded.worktrees).toHaveLength(1)
    expect(loaded.worktrees[0]).toMatchObject({
      path: linked,
      branch: "wt-branch",
      status: { kind: "ok", branch: "wt-branch", modified: 0, untracked: 1 },
    })
    // main and wt-branch are checked out, so they're on the repo and worktree rows.
    expect(loaded.branches.map((b) => b.name)).toEqual(["idle"])
  })

  test("reports upstream tracking from a real remote", async () => {
    const origin = await makeRepo(join(dir, "origin"))
    const clone = join(dir, "clone")
    sh(origin, "branch", "doomed")
    sh(dir, "clone", "-q", origin, clone)
    sh(clone, "branch", "behind-branch", "--track", "origin/main")
    sh(clone, "branch", "gone-branch", "--track", "origin/doomed")
    await writeFile(join(clone, "file.txt"), "two\n")
    sh(clone, "commit", "-qam", "local")
    sh(clone, "branch", "ahead-branch")
    sh(clone, "branch", "--set-upstream-to=origin/main", "ahead-branch")
    await writeFile(join(origin, "other.txt"), "x")
    sh(origin, "add", ".")
    sh(origin, "commit", "-qm", "remote")
    sh(origin, "branch", "-qD", "doomed")
    sh(clone, "fetch", "-q", "--prune")

    const loaded = await loadRepo(clone)
    expect(loaded.status).toMatchObject({ sync: { upstream: "origin/main", ahead: 1, behind: 1 } })
    const sync = (name: string) => loaded.branches.find((b) => b.name === name)?.sync
    expect(sync("ahead-branch")).toMatchObject({ ahead: 1, behind: 1 })
    expect(sync("behind-branch")).toMatchObject({ ahead: 0, behind: 1 })
    expect(sync("gone-branch")).toMatchObject({ gone: true })
  })

  describe("trunk", () => {
    test("stays on the repo row when the main checkout is on another branch", async () => {
      const origin = await makeRepo(join(dir, "origin"))
      const clone = join(dir, "clone")
      sh(dir, "clone", "-q", origin, clone)
      sh(clone, "checkout", "-qb", "feature")
      await writeFile(join(clone, "file.txt"), "changed\n")
      await writeFile(join(origin, "other.txt"), "x")
      sh(origin, "add", ".")
      sh(origin, "commit", "-qm", "remote")
      sh(clone, "fetch", "-q")

      const loaded = await loadRepo(clone)
      expect(loaded.branch).toBe("main")
      expect(loaded.status).toMatchObject({ kind: "idle", sync: { upstream: "origin/main", behind: 1 } })
      expect(loaded.worktrees).toHaveLength(1)
      expect(loaded.worktrees[0]).toMatchObject({
        path: clone,
        branch: "feature",
        status: { kind: "ok", modified: 1 },
      })
      expect(loaded.branches).toEqual([])
    })

    test("uses a linked worktree's status when one holds the trunk", async () => {
      const repo = await makeRepo(join(dir, "repo"))
      sh(repo, "checkout", "-qb", "feature")
      const linked = join(dir, "linked")
      sh(repo, "worktree", "add", "-q", linked, "main")
      await writeFile(join(linked, "new.txt"), "x")

      const loaded = await loadRepo(repo)
      expect(loaded.branch).toBe("main")
      expect(loaded.statusPath).toBe(linked)
      expect(loaded.status).toMatchObject({ kind: "ok", branch: "main", untracked: 1 })
      expect(loaded.worktrees.map((w) => w.branch)).toEqual(["feature"])
    })

    test("prefers main, then master, and lists the other as a branch", async () => {
      const repo = await makeRepo(join(dir, "repo"))
      sh(repo, "branch", "master")
      const both = await loadRepo(repo)
      expect(both.branch).toBe("main")
      expect(both.branches.map((b) => b.name)).toEqual(["master"])

      sh(repo, "branch", "-m", "main", "dev")
      const masterOnly = await loadRepo(repo)
      expect(masterOnly.branch).toBe("master")
      expect(masterOnly.status.kind).toBe("idle")
      expect(masterOnly.worktrees.map((w) => w.branch)).toEqual(["dev"])
    })

    test("falls back to the main checkout when neither exists", async () => {
      const repo = await makeRepo(join(dir, "repo"))
      sh(repo, "branch", "-m", "main", "develop")
      sh(repo, "branch", "other")

      const loaded = await loadRepo(repo)
      expect(loaded.branch).toBe("develop")
      expect(loaded.status).toMatchObject({ kind: "ok", branch: "develop" })
      expect(loaded.worktrees).toEqual([])
      expect(loaded.branches.map((b) => b.name)).toEqual(["other"])
    })

    test("in a bare-style repo, reads the trunk and lists HEAD's other branches", async () => {
      const origin = await makeRepo(join(dir, "origin"))
      sh(origin, "branch", "feature")
      const repo = join(dir, "repo")
      await mkdir(repo)
      sh(dir, "clone", "-q", "--bare", origin, join(repo, ".git"))

      const onTrunk = await loadRepo(repo)
      expect(onTrunk.status.kind).toBe("idle")
      expect(onTrunk.worktrees).toEqual([])
      expect(onTrunk.branches.map((b) => b.name)).toEqual(["feature"])

      sh(repo, "symbolic-ref", "HEAD", "refs/heads/feature")
      const onFeature = await loadRepo(repo)
      expect(onFeature.status.kind).toBe("idle")
      expect(onFeature.branches.map((b) => b.name)).toEqual(["feature"])
    })
  })

  test("doesn't run a repo's core.fsmonitor program", async () => {
    const repo = await makeRepo(join(dir, "repo"))
    const marker = join(dir, "fsmonitor-ran")
    const script = join(dir, "fsmonitor.sh")
    await writeFile(script, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 })
    sh(repo, "config", "core.fsmonitor", script)

    // Plain git does run it, so this test would notice if the protection stopped working.
    sh(repo, "status")
    expect(await Bun.file(marker).exists()).toBe(true)
    await rm(marker)

    expect((await loadRepo(repo)).status.kind).toBe("ok")
    expect(await Bun.file(marker).exists()).toBe(false)
  })

  test("a deleted worktree shows as missing without failing the repo", async () => {
    const repo = await makeRepo(join(dir, "repo"))
    const linked = join(dir, "linked")
    sh(repo, "worktree", "add", "-q", linked, "-b", "gone")
    await rm(linked, { recursive: true })

    const loaded = await loadRepo(repo)
    expect(loaded.status.kind).toBe("ok")
    expect(loaded.worktrees[0]?.status.kind).toBe("missing")
  })

  test("a broken .git inside another repo errors rather than reporting the parent", async () => {
    const parent = await makeRepo(join(dir, "parent"))
    const broken = join(parent, "broken")
    await mkdir(join(broken, ".git"), { recursive: true })

    const loaded = await loadRepo(broken)
    expect(loaded.status.kind).toBe("error")
    if (loaded.status.kind === "error") expect(loaded.status.message).toContain("not a git repository")
  })

  test("a repo with no commits and a repo with core.bare both load", async () => {
    const empty = join(dir, "empty")
    await mkdir(empty)
    sh(empty, "init", "-q", "-b", "main")
    expect((await loadRepo(empty)).status).toMatchObject({ kind: "ok", branch: "main", oid: null })

    const bareStyle = join(dir, "barestyle")
    await mkdir(bareStyle)
    sh(dir, "init", "-q", "--bare", "-b", "main", join(bareStyle, ".git"))
    expect((await loadRepo(bareStyle)).status.kind).toBe("bare")
  })
})
