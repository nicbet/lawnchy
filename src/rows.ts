import { relative } from "node:path"
import type { CheckoutStatus, Repo, Sync } from "./git.ts"

export const COLORS = {
  ok: "#3fb950",
  warn: "#d29922",
  bad: "#f85149",
  info: "#58a6ff",
  /** The repo's own name. Separate from the colors above, which all report a status. */
  accent: "#d2a8ff",
  dim: "#8b949e",
  selectedBg: "#264f78",
  selectedFg: "#ffffff",
  popupBg: "#161b22",
} as const

export interface Cell {
  text: string
  color?: string
}

const IN_SYNC: Cell = { text: "✓", color: COLORS.ok }
const NO_UPSTREAM: Cell = { text: "—", color: COLORS.dim }
const UPSTREAM_GONE: Cell = { text: "✗", color: COLORS.bad }

export interface Row {
  key: string
  repoKey: string
  kind: "repo" | "worktree" | "branch"
  /** Tree glyphs and label before the name, dimmed. */
  prefix: string
  name: string
  /** Appended to `name` and never truncated, so a collapsed repo can't hide a problem. */
  suffix: string
  branch: Cell
  status: Cell
  sync: Cell
  /** Full-width line shown when the row is selected. */
  detail: Cell
  /** Folder to open in lazygit, or null if there's no usable checkout or repo there. */
  openPath: string | null
  expandable: boolean
  expanded: boolean
}

function isDirty(status: CheckoutStatus): boolean {
  return (
    status.kind === "ok" &&
    status.staged + status.modified + status.untracked + status.conflicted > 0
  )
}

function isQuietSync(sync: Sync): boolean {
  return !sync.gone && sync.ahead === 0 && sync.behind === 0
}

function isQuietStatus(status: CheckoutStatus): boolean {
  switch (status.kind) {
    case "ok":
      return !isDirty(status) && status.branch !== null && isQuietSync(status.sync)
    case "idle":
      return isQuietSync(status.sync)
    case "bare":
      return true
    case "loading":
    case "missing":
    case "error":
      return false
  }
}

/**
 * True when a repo has nothing to act on. Any extra checkout counts as activity,
 * including the repo's own directory being off the trunk. Branches with no upstream
 * don't: most repos have a few, so counting them would leave little to hide.
 */
export function isBoring(repo: Repo): boolean {
  return (
    repo.worktrees.length === 0 &&
    isQuietStatus(repo.status) &&
    repo.branches.every((branch) => isQuietSync(branch.sync))
  )
}

function statusCell(status: CheckoutStatus): Cell {
  switch (status.kind) {
    case "loading":
      return { text: "… loading", color: COLORS.dim }
    case "bare":
      return { text: "bare", color: COLORS.dim }
    case "missing":
      return { text: "✗ missing", color: COLORS.bad }
    case "error":
      return { text: "✗ error", color: COLORS.bad }
    case "idle":
      // Not checked out, so there's no working tree to have changes.
      return { text: "" }
    case "ok": {
      if (!isDirty(status)) return { text: "✓", color: COLORS.ok }
      const parts = [
        status.staged && `+${status.staged}`,
        status.modified && `~${status.modified}`,
        status.untracked && `?${status.untracked}`,
        status.conflicted && `!${status.conflicted}`,
      ].filter(Boolean)
      return { text: parts.join(" "), color: status.conflicted ? COLORS.bad : COLORS.warn }
    }
  }
}

function counts(sync: Sync): string {
  return [sync.ahead && `↑${sync.ahead}`, sync.behind && `↓${sync.behind}`].filter(Boolean).join(" ")
}

function syncCell(status: CheckoutStatus): Cell {
  return status.kind === "ok" || status.kind === "idle" ? syncStateCell(status.sync) : { text: "" }
}

function syncStateCell(sync: Sync): Cell {
  if (sync.gone) return UPSTREAM_GONE
  if (!sync.upstream) return NO_UPSTREAM
  return counts(sync) ? { text: counts(sync), color: COLORS.info } : IN_SYNC
}

function branchCell(status: CheckoutStatus, listedBranch: string | null): Cell {
  if (status.kind === "ok") {
    if (status.branch) return { text: status.branch }
    return { text: `(detached ${status.oid ?? "?"})`, color: COLORS.warn }
  }
  if (status.kind === "idle") return { text: listedBranch ?? "" }
  return { text: listedBranch ?? "", color: COLORS.dim }
}

function detailCell(path: string, status: CheckoutStatus): Cell {
  // Message first: a long path must not push it past the edge of the line.
  if (status.kind === "error") return { text: `${status.message}  ${path}`, color: COLORS.bad }
  if (status.kind === "missing") return { text: `worktree directory is missing  ${path}`, color: COLORS.bad }
  const gone = (status.kind === "ok" || status.kind === "idle") && status.sync.gone
  const notes = [status.kind === "idle" && "not checked out", gone && "upstream gone"].filter(Boolean).join(", ")
  return { text: notes ? `${notes}  ${path}` : path, color: COLORS.dim }
}

function openPath(path: string, status: CheckoutStatus): string | null {
  return status.kind === "error" || status.kind === "missing" ? null : path
}

/** Summary shown on a collapsed repo: child count plus anything needing attention. */
function collapsedSuffix(repo: Repo): string {
  const dirty = repo.worktrees.filter((w) => isDirty(w.status)).length
  const broken = repo.worktrees.filter((w) => w.status.kind === "error" || w.status.kind === "missing").length
  const parts = [
    String(repo.worktrees.length + repo.branches.length),
    dirty && `${dirty} dirty`,
    broken && `${broken} broken`,
  ].filter(Boolean)
  return ` (${parts.join(", ")})`
}

/** The repo's path as listed: relative to the scan root, or its own name if it is the root. */
export function repoName(repo: Repo, root: string): string {
  return relative(root, repo.path) || repo.path.split("/").pop() || repo.path
}

/**
 * Builds a case-insensitive matcher from filter text. The text is a regexp when it
 * compiles; otherwise, as with "c++", it matches literally.
 */
export function compileFilter(text: string): (name: string) => boolean {
  try {
    const regexp = new RegExp(text, "i")
    return (name) => regexp.test(name)
  } catch {
    const literal = text.toLowerCase()
    return (name) => name.toLowerCase().includes(literal)
  }
}

/** Flattens repos into display rows, omitting the children of collapsed repos. */
export function buildRows(repos: Repo[], root: string, collapsed: ReadonlySet<string>): Row[] {
  const rows: Row[] = []
  for (const repo of repos) {
    const childCount = repo.worktrees.length + repo.branches.length
    const expanded = !collapsed.has(repo.path)
    const name = repoName(repo, root)
    rows.push({
      key: repo.path,
      repoKey: repo.path,
      kind: "repo",
      prefix: childCount === 0 ? "  " : expanded ? "▾ " : "▸ ",
      name,
      suffix: childCount > 0 && !expanded ? collapsedSuffix(repo) : "",
      branch: branchCell(repo.status, repo.branch),
      status: statusCell(repo.status),
      sync: syncCell(repo.status),
      detail: detailCell(repo.statusPath, repo.status),
      openPath: openPath(repo.statusPath, repo.status),
      expandable: childCount > 0,
      expanded,
    })
    if (!expanded) continue

    let remaining = childCount
    const glyph = () => (--remaining === 0 ? "  └─ " : "  ├─ ")
    for (const worktree of repo.worktrees) {
      rows.push({
        key: `${repo.path}\0worktree\0${worktree.path}`,
        repoKey: repo.path,
        kind: "worktree",
        prefix: `${glyph()}worktree `,
        name: relative(repo.path, worktree.path) || ".",
        suffix: "",
        branch: branchCell(worktree.status, worktree.branch),
        status: statusCell(worktree.status),
        sync: syncCell(worktree.status),
        detail: detailCell(worktree.path, worktree.status),
        openPath: openPath(worktree.path, worktree.status),
        expandable: false,
        expanded: false,
      })
    }
    for (const branch of repo.branches) {
      rows.push({
        key: `${repo.path}\0branch\0${branch.name}`,
        repoKey: repo.path,
        kind: "branch",
        prefix: `${glyph()}branch`,
        name: "",
        suffix: "",
        branch: { text: branch.name },
        status: { text: "" },
        sync: syncStateCell(branch.sync),
        detail: {
          text: branch.sync.upstream
            ? `${branch.name} → ${branch.sync.upstream}${branch.sync.gone ? " (gone)" : ""}`
            : `${branch.name} has no upstream`,
          color: COLORS.dim,
        },
        openPath: repo.path,
        expandable: false,
        expanded: false,
      })
    }
  }
  return rows
}

/** Pads or ellipsis-truncates `text` to exactly `width` terminal cells. */
export function fit(text: string, width: number): string {
  if (width <= 0) return ""
  const textWidth = Bun.stringWidth(text)
  if (textWidth <= width) return text + " ".repeat(width - textWidth)
  let out = ""
  let used = 0
  for (const char of text) {
    const charWidth = Bun.stringWidth(char)
    if (used + charWidth > width - 1) break
    out += char
    used += charWidth
  }
  return `${out}…${" ".repeat(width - used - 1)}`
}

/**
 * Shortens `text` to `width` cells by dropping its start, keeping the end of a path,
 * which is the informative part. Returns nothing if there's no room for more than "…".
 */
export function shortenStart(text: string, width: number): string {
  if (Bun.stringWidth(text) <= width) return text
  if (width < 2) return ""
  let shown = ""
  let used = 1
  for (const char of Array.from(text).reverse()) {
    used += Bun.stringWidth(char)
    if (used > width) break
    shown = char + shown
  }
  return `…${shown}`
}

/**
 * Joins items across `width` cells, first at the left edge and last at the right, with
 * gaps that differ by at most one. Gaps never go below one, so too many items overflow.
 */
export function spreadEvenly(items: string[], width: number): string {
  const gaps = items.length - 1
  if (gaps < 1) return items.join("")
  const free = width - items.reduce((total, item) => total + Bun.stringWidth(item), 0)
  const baseGap = Math.max(1, Math.floor(free / gaps))
  const widerGaps = free > gaps ? free % gaps : 0
  return items.reduce((line, item, i) => line + " ".repeat(baseGap + (i <= widerGaps ? 1 : 0)) + item)
}

const STATUS_WIDTH = 16
/** Fits "↑999 ↓999". */
const SYNC_WIDTH = 9
const GAPS = 3

export function columnWidths(total: number) {
  const flexible = Math.max(0, total - STATUS_WIDTH - SYNC_WIDTH - GAPS)
  const name = Math.max(12, Math.ceil(flexible * 0.6))
  const branch = Math.max(6, flexible - name)
  return { name, branch, status: STATUS_WIDTH, sync: SYNC_WIDTH }
}

/**
 * Fits the prefix + name + suffix into the name column, truncating only the name.
 * A repo's path is split into its parent folders, owner (second-to-last segment, as in
 * GitHub's owner/repo) and name (last segment). The split comes from the full path, so
 * truncation empties the later parts rather than moving them to the wrong segment.
 */
export function nameParts(
  row: Row,
  width: number,
): { prefix: string; parent: string; owner: string; name: string; suffix: string } {
  const room = Math.max(0, width - Bun.stringWidth(row.prefix) - Bun.stringWidth(row.suffix))
  const shown = fit(row.name, room).trimEnd()
  const padding = " ".repeat(Math.max(0, room - Bun.stringWidth(shown)))
  const nameStart = row.kind === "repo" ? row.name.lastIndexOf("/") + 1 : 0
  const ownerStart = nameStart > 0 ? row.name.lastIndexOf("/", nameStart - 2) + 1 : 0
  return {
    prefix: row.prefix,
    parent: shown.slice(0, ownerStart),
    owner: shown.slice(ownerStart, nameStart),
    name: shown.slice(nameStart),
    suffix: row.suffix + padding,
  }
}

/** Returns the scroll offset that keeps `selected` visible with minimal movement. */
export function scrollOffset(previous: number, selected: number, viewport: number, total: number): number {
  if (viewport <= 0) return 0
  let offset = previous
  if (selected < offset) offset = selected
  if (selected >= offset + viewport) offset = selected - viewport + 1
  return Math.max(0, Math.min(offset, Math.max(0, total - viewport)))
}
