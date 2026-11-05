#!/usr/bin/env bun
import { realpath, stat } from "node:fs/promises"
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { version } from "../package.json"
import { App } from "./App.tsx"
import { configPath } from "./config.ts"

const USAGE = `Usage: lawnchy [directory]

Finds every git repository under a directory (default: the current one) and
shows its status, with other worktrees and branches as sub-rows.

Options:
  -h, --help     Show this help
  -v, --version  Show the version

Agents are configured in ${configPath()}`

async function resolveRoot(arg: string | undefined): Promise<string> {
  const root = await realpath(arg ?? ".").catch(() => null)
  if (!root || !(await stat(root)).isDirectory()) {
    console.error(`lawnchy: not a directory: ${arg ?? "."}`)
    process.exit(1)
  }
  return root
}

const args = process.argv.slice(2)
if (args.includes("-h") || args.includes("--help")) {
  console.log(USAGE)
  process.exit(0)
}
if (args.includes("-v") || args.includes("--version")) {
  console.log(version)
  process.exit(0)
}
if (args.length > 1 || args[0]?.startsWith("-")) {
  console.error(USAGE)
  process.exit(1)
}

const root = await resolveRoot(args[0])
const renderer = await createCliRenderer()
createRoot(renderer).render(<App root={root} />)
