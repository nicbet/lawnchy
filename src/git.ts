import { dirname } from "node:path"

export interface Sync {
  /** Upstream ref name, or null when none is configured. */
  upstream: string | null
  /** An upstream is configured but its ref no longer exists. */
  gone: boolean
  ahead: number
  behind: number
}

export interface WorkingTreeStatus {
  kind: "ok"
  /** Null when HEAD is detached. */
  branch: string | null
  /** Abbreviated commit, or null in a repo with no commits yet. */
  oid: string | null
  staged: number
  modified: number
  untracked: number
  conflicted: number
  sync: Sync
}

export type CheckoutStatus =
  | WorkingTreeStatus
  | { kind: "loading" }
  | { kind: "bare" }
  | { kind: "missing" }
  /** A branch that isn't checked out, so only its upstream state exists. */
  | { kind: "idle"; sync: Sync }
  | { kind: "error"; message: string }

export interface Worktree {
  path: string
  branch: string | null
  status: CheckoutStatus
}

export interface Branch {
  name: string
  sync: Sync
  /** Where the branch is checked out, or null if nowhere. */
  worktreePath: string | null
}

export interface Repo {
  path: string
  /** The trunk, or the main checkout's branch in a repo with no trunk. */
  branch: string | null
  /** Where the repo row's status comes from; differs from `path` if a linked worktree holds the trunk. */
  statusPath: string
  status: CheckoutStatus
  /** Every checkout other than the one on the repo row. */
  worktrees: Worktree[]
  /** Local branches other than the trunk that aren't checked out anywhere. */
  branches: Branch[]
}

/** Assumed trunk names, in order of preference. */
const TRUNK_NAMES = ["main", "master"]

const MAX_CONCURRENT_GIT = 8
const GIT_TIMEOUT_MS = 30_000

let running = 0
const waiting: Array<() => void> = []

async function withGitSlot<T>(task: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_GIT) {
    await new Promise<void>((resolve) => waiting.push(resolve))
  } else {
    running++
  }
  try {
    return await task()
  } finally {
    const next = waiting.shift()
    if (next) next()
    else running--
  }
}

/** The environment without variables that would redirect git away from its working directory. */
export function cleanGitEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  // Set when launched from a git hook or alias.
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) {
    delete env[name]
  }
  return env
}

function gitEnv(cwd: string): Record<string, string | undefined> {
  // Stop discovery at `cwd`: a broken .git must error, not report the enclosing repo.
  return { ...cleanGitEnv(), GIT_CEILING_DIRECTORIES: dirname(cwd) }
}

async function git(cwd: string, args: string[]): Promise<string> {
  return withGitSlot(async () => {
    const proc = Bun.spawn(
      // Read-only observer: never take index.lock away from the user's own git commands,
      // and never start a repo-configured fsmonitor program just by looking at a repo.
      ["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-C", cwd, ...args],
      {
        env: gitEnv(cwd),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: GIT_TIMEOUT_MS,
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (proc.signalCode) throw new Error(`git ${args[0]} did not finish (${proc.signalCode})`)
    if (exitCode !== 0) {
      throw new Error(stderr.trim().split("\n")[0] || `git ${args[0]} exited with ${exitCode}`)
    }
    return stdout
  })
}

/** Parses `git status --porcelain=v2 --branch`. */
export function parseStatus(output: string): WorkingTreeStatus {
  const status: WorkingTreeStatus = {
    kind: "ok",
    branch: null,
    oid: null,
    staged: 0,
    modified: 0,
    untracked: 0,
    conflicted: 0,
    sync: { upstream: null, gone: false, ahead: 0, behind: 0 },
  }
  let hasCounts = false
  for (const line of output.split("\n")) {
    if (line.startsWith("# branch.oid ")) {
      const oid = line.slice("# branch.oid ".length)
      status.oid = oid === "(initial)" ? null : oid.slice(0, 7)
    } else if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length)
      status.branch = head === "(detached)" ? null : head
    } else if (line.startsWith("# branch.upstream ")) {
      status.sync.upstream = line.slice("# branch.upstream ".length)
    } else if (line.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/.exec(line)
      status.sync.ahead = Number(match?.[1] ?? 0)
      status.sync.behind = Number(match?.[2] ?? 0)
      hasCounts = true
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      if (line[2] !== ".") status.staged++
      if (line[3] !== ".") status.modified++
    } else if (line.startsWith("u ")) {
      status.conflicted++
    } else if (line.startsWith("? ")) {
      status.untracked++
    }
  }
  // git omits branch.ab when the configured upstream ref doesn't exist.
  status.sync.gone = status.sync.upstream !== null && !hasCounts
  return status
}

export interface WorktreeEntry {
  path: string
  branch: string | null
  bare: boolean
  prunable: boolean
}

/** Parses `git worktree list --porcelain -z`. The first entry is the main checkout. */
export function parseWorktrees(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let current: WorktreeEntry | undefined
  for (const field of output.split("\0")) {
    if (field.startsWith("worktree ")) {
      current = { path: field.slice("worktree ".length), branch: null, bare: false, prunable: false }
      entries.push(current)
    } else if (current && field.startsWith("branch ")) {
      current.branch = field.slice("branch ".length).replace(/^refs\/heads\//, "")
    } else if (current && field === "bare") {
      current.bare = true
    } else if (current && (field === "prunable" || field.startsWith("prunable "))) {
      current.prunable = true
    }
  }
  return entries
}

const BRANCH_FORMAT = [
  "%(refname:short)",
  "%(upstream:short)",
  "%(upstream:track,nobracket)",
  "%(worktreepath)",
].join("%00")

/** Parses `git for-each-ref --format=BRANCH_FORMAT`. */
export function parseBranches(output: string): Branch[] {
  const branches: Branch[] = []
  for (const line of output.split("\n")) {
    if (!line) continue
    const [name = "", upstream = "", track = "", worktreePath = ""] = line.split("\0")
    branches.push({
      name,
      worktreePath: worktreePath || null,
      sync: {
        upstream: upstream || null,
        gone: track === "gone",
        ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
        behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
      },
    })
  }
  return branches
}

function errorStatus(error: unknown): CheckoutStatus {
  return { kind: "error", message: error instanceof Error ? error.message : String(error) }
}

async function loadCheckout(entry: WorktreeEntry): Promise<CheckoutStatus> {
  if (entry.bare) return { kind: "bare" }
  if (entry.prunable) return { kind: "missing" }
  try {
    return parseStatus(await git(entry.path, ["status", "--porcelain=v2", "--branch"]))
  } catch (error) {
    return errorStatus(error)
  }
}

/** Loads a repo and all of its sub-rows. Failures become statuses; this never rejects. */
export async function loadRepo(path: string): Promise<Repo> {
  try {
    const [worktreeOutput, branchOutput] = await Promise.all([
      git(path, ["worktree", "list", "--porcelain", "-z"]),
      git(path, ["for-each-ref", `--format=${BRANCH_FORMAT}`, "refs/heads"]),
    ])
    const entries = parseWorktrees(worktreeOutput)
    const main = entries[0]
    if (!main) throw new Error("git worktree list returned nothing")

    // A bare repo's HEAD branch reports the repo as its worktree, but nothing is checked out there.
    const barePaths = new Set(entries.filter((e) => e.bare).map((e) => e.path))
    const refs = parseBranches(branchOutput).map((ref) =>
      ref.worktreePath && barePaths.has(ref.worktreePath) ? { ...ref, worktreePath: null } : ref,
    )

    // Worktree entries are included because a repo with no commits has a branch but no refs.
    const known = new Set([...refs.map((r) => r.name), ...entries.flatMap((e) => e.branch ?? [])])
    const trunk = TRUNK_NAMES.find((name) => known.has(name)) ?? null
    const trunkRef = refs.find((r) => r.name === trunk)
    // Matching by path too finds a trunk mid-rebase, which worktree list reports as detached.
    const trunkEntry = entries.find((e) => e.branch === trunk || e.path === trunkRef?.worktreePath)
    const primary = trunk ? trunkEntry : main
    const others = entries.filter((e) => e !== primary && !e.bare)

    const [status, ...otherStatuses] = await Promise.all([
      primary ? loadCheckout(primary) : ({ kind: "idle", sync: trunkRef!.sync } as const),
      ...others.map(loadCheckout),
    ])
    return {
      path,
      branch: trunk ?? main.branch,
      statusPath: primary?.path ?? path,
      status,
      worktrees: others.map((entry, i) => ({
        path: entry.path,
        branch: entry.branch,
        status: otherStatuses[i]!,
      })),
      branches: refs.filter((r) => !r.worktreePath && r.name !== trunk),
    }
  } catch (error) {
    return { path, branch: null, statusPath: path, status: errorStatus(error), worktrees: [], branches: [] }
  }
}
