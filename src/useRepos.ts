import { useCallback, useEffect, useRef, useState } from "react"
import { loadRepo, type Repo } from "./git.ts"
import { findRepos } from "./scan.ts"

function byPath(a: Repo, b: Repo): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

function placeholder(path: string): Repo {
  return { path, branch: null, statusPath: path, status: { kind: "loading" }, worktrees: [], branches: [] }
}

/** Streams repos into state as they're found. During a refresh, old rows stay until replaced. */
export function useRepos(root: string) {
  const [repos, setRepos] = useState<Repo[]>([])
  const [scanning, setScanning] = useState(true)
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    const id = ++generation.current
    const isCurrent = () => generation.current === id
    setScanning(true)

    const seen = new Set<string>()
    const loads: Promise<void>[] = []
    for await (const path of findRepos(root)) {
      if (!isCurrent()) return
      seen.add(path)
      setRepos((previous) =>
        previous.some((repo) => repo.path === path)
          ? previous
          : [...previous, placeholder(path)].sort(byPath),
      )
      loads.push(
        loadRepo(path).then((repo) => {
          if (isCurrent()) setRepos((previous) => previous.map((r) => (r.path === path ? repo : r)))
        }),
      )
    }
    if (!isCurrent()) return
    setRepos((previous) => previous.filter((repo) => seen.has(repo.path)))
    await Promise.all(loads)
    if (isCurrent()) setScanning(false)
  }, [root])

  useEffect(() => {
    void refresh()
    return () => {
      generation.current++
    }
  }, [refresh])

  return { repos, scanning, refresh }
}
