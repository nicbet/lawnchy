import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"]

export function sh(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...IDENTITY, ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

export async function makeTemp(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lawnchy-")))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** Creates a repo with one commit on `main`. */
export async function makeRepo(path: string): Promise<string> {
  await mkdir(path, { recursive: true })
  sh(path, "init", "-q", "-b", "main")
  await writeFile(join(path, "file.txt"), "one\n")
  sh(path, "add", ".")
  sh(path, "commit", "-q", "-m", "first")
  return path
}
