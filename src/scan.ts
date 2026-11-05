import { readdir } from "node:fs/promises"
import { join } from "node:path"

/** Dependency stores: huge, and any repo inside them isn't one the user is working on. */
const SKIPPED_DIRS = new Set(["node_modules", "__pycache__", ".venv"])

/**
 * Yields every directory under `root` (including `root`) that contains a `.git`
 * *directory*. A `.git` file marks a linked worktree or submodule, which is not
 * a root; linked worktrees are reported by their parent repo instead.
 *
 * Does not descend into a repo once found, so anything nested inside one is not
 * reported. Symlinks are not followed, and unreadable directories are skipped.
 */
export async function* findRepos(root: string): AsyncGenerator<string> {
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const children: string[] = []
    let isRepo = false
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === ".git") isRepo = true
      else if (!SKIPPED_DIRS.has(entry.name)) children.push(join(dir, entry.name))
    }
    if (isRepo) yield dir
    else stack.push(...children)
  }
}
