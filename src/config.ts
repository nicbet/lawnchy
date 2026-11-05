import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const APP_NAME = "lawnchy"

export interface Agent {
  name: string
  /** Run by `sh`, so it can include arguments. */
  command: string
  /** How to get back from it, when "quit it" wouldn't be clear. */
  hint?: string
}

/** Anything in the `x` dialog. Runs like an agent, but is chosen by pressing its key. */
export interface Launchable extends Agent {
  key: string
}

export interface LaunchableConfig {
  launchables: Launchable[]
  error: string | null
}

export interface AgentConfig {
  agents: Agent[]
  defaultAgent: string | null
  /** A problem with the config file, for showing to the user. */
  error: string | null
}

/** Offered in the picker when installed, without needing any configuration. */
const WELL_KNOWN_AGENTS = ["claude", "codex", "gemini", "opencode", "aider", "cursor-agent", "amp", "goose"]

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(base, APP_NAME, "config.toml")
}

function isOnPath(command: string): boolean {
  return Bun.which(command) !== null
}

function parseConfig(text: string): { configured: Agent[]; defaultAgent: string | null; error: string | null } {
  let parsed: Record<string, unknown>
  try {
    parsed = Bun.TOML.parse(text) as Record<string, unknown>
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { configured: [], defaultAgent: null, error: message }
  }

  const problems: string[] = []
  const configured: Agent[] = []
  const table = parsed.agents
  if (table !== undefined && (typeof table !== "object" || table === null || Array.isArray(table))) {
    problems.push("[agents] must be a table")
  } else if (table) {
    for (const [name, command] of Object.entries(table)) {
      if (typeof command === "string" && command.trim()) configured.push({ name, command })
      else problems.push(`agents.${name} must be a command string`)
    }
  }

  const value = parsed.default_agent
  if (value !== undefined && typeof value !== "string") problems.push("default_agent must be a string")
  return {
    configured,
    defaultAgent: typeof value === "string" ? value : null,
    error: problems.length > 0 ? problems.join("; ") : null,
  }
}

/** Reads the config file; a missing file is the same as an empty one. */
async function readConfigText(path: string): Promise<{ text: string; readError: string | null }> {
  try {
    return { text: await readFile(path, "utf8"), readError: null }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "", readError: null }
    return { text: "", readError: String(error) }
  }
}

/**
 * Available without any configuration. Its status is ignored because a shell exits with
 * that of the last command typed, and a failed one isn't the shell failing.
 */
const BUILT_IN_TERMINAL: Launchable = {
  name: "terminal",
  key: "t",
  command: "${SHELL:-/bin/sh} || true",
  hint: `Type exit to return to ${APP_NAME}`,
}

/** Adds the built-in terminal, unless its name or key has been given to something else. */
function withTerminal(launchables: Launchable[]): Launchable[] {
  const { name, key } = BUILT_IN_TERMINAL
  const taken = launchables.some((item) => item.name === name || item.key === key)
  return taken ? launchables : [...launchables, BUILT_IN_TERMINAL]
}

/** Reads the `x` dialog's entries, in file order. Never rejects; problems go in `error`. */
export async function loadLaunchables(path = configPath()): Promise<LaunchableConfig> {
  const { text, readError } = await readConfigText(path)
  if (readError) return { launchables: withTerminal([]), error: readError }

  let parsed: Record<string, unknown>
  try {
    parsed = Bun.TOML.parse(text) as Record<string, unknown>
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { launchables: withTerminal([]), error: `${path}: ${message}` }
  }

  const table = parsed.launchables
  if (table === undefined) return { launchables: withTerminal([]), error: null }
  if (typeof table !== "object" || table === null || Array.isArray(table)) {
    return { launchables: withTerminal([]), error: `${path}: [launchables] must be a table` }
  }

  const launchables: Launchable[] = []
  const problems: string[] = []
  for (const [name, entry] of Object.entries(table)) {
    const { key, command } = (entry ?? {}) as { key?: unknown; command?: unknown }
    if (typeof key !== "string" || Array.from(key).length !== 1 || !key.trim()) {
      problems.push(`launchables.${name} needs a single-character key`)
    } else if (typeof command !== "string" || !command.trim()) {
      problems.push(`launchables.${name} needs a command`)
    } else if (launchables.some((other) => other.key === key)) {
      problems.push(`launchables.${name} reuses the key "${key}"`)
    } else {
      launchables.push({ name, key, command })
    }
  }
  return { launchables: withTerminal(launchables), error: problems.length > 0 ? `${path}: ${problems.join("; ")}` : null }
}

/**
 * Reads the agents available right now: configured ones first, then installed well-known
 * ones. Never rejects; a bad config file is reported through `error`.
 */
export async function loadAgents(path = configPath(), isInstalled = isOnPath): Promise<AgentConfig> {
  const { text, readError } = await readConfigText(path)
  const { configured, defaultAgent, error } = parseConfig(text)
  const names = new Set(configured.map((agent) => agent.name))
  const agents = [
    ...configured,
    ...WELL_KNOWN_AGENTS.filter((name) => !names.has(name) && isInstalled(name)).map((name) => ({
      name,
      command: name,
    })),
  ]

  const problems = [readError ?? (error && `${path}: ${error}`)]
  let resolvedDefault = defaultAgent
  if (defaultAgent && !agents.some((agent) => agent.name === defaultAgent)) {
    // `default_agent = "tool"` works for any installed command, without an [agents] entry.
    if (isInstalled(defaultAgent)) {
      agents.unshift({ name: defaultAgent, command: defaultAgent })
    } else {
      problems.push(`default_agent "${defaultAgent}" isn't in [agents] or on your PATH`)
      resolvedDefault = null
    }
  }
  return { agents, defaultAgent: resolvedDefault, error: problems.filter(Boolean).join("; ") || null }
}

/** Sets `default_agent` in the config file, leaving everything else in it untouched. */
export async function saveDefaultAgent(name: string, path = configPath()): Promise<void> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return ""
    throw error
  })
  const line = `default_agent = ${JSON.stringify(name)}`

  // Top-level keys must come before the first table, so only look there.
  const firstTable = text.search(/^\s*\[/m)
  const topEnd = firstTable === -1 ? text.length : firstTable
  const top = text.slice(0, topEnd)
  const existing = /^[ \t]*default_agent[ \t]*=.*$/m
  const updated = existing.test(top)
    ? top.replace(existing, () => line) + text.slice(topEnd)
    : `${line}\n${text}`

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, updated)
}
