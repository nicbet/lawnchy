import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { configPath, loadAgents, loadLaunchables, saveDefaultAgent } from "../src/config.ts"
import { makeTemp } from "./helpers.ts"

let dir: string
let cleanup: () => Promise<void>
let path: string

beforeEach(async () => {
  ;({ dir, cleanup } = await makeTemp())
  path = join(dir, "config.toml")
})
afterEach(() => cleanup())

const onlyInstalled =
  (...installed: string[]) =>
  (command: string) =>
    installed.includes(command)

test("configPath follows XDG_CONFIG_HOME and falls back to ~/.config", () => {
  const original = process.env.XDG_CONFIG_HOME
  try {
    process.env.XDG_CONFIG_HOME = "/custom"
    expect(configPath()).toBe("/custom/lawnchy/config.toml")
    delete process.env.XDG_CONFIG_HOME
    expect(configPath()).toEndWith("/.config/lawnchy/config.toml")
  } finally {
    if (original === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = original
  }
})

test("with no config file, offers installed well-known agents", async () => {
  expect(await loadAgents(path, onlyInstalled("codex", "claude", "unrelated"))).toEqual({
    agents: [
      { name: "claude", command: "claude" },
      { name: "codex", command: "codex" },
    ],
    defaultAgent: null,
    error: null,
  })
})

test("configured agents come first and override well-known ones of the same name", async () => {
  await writeFile(path, `default_agent = "review"\n[agents]\nreview = "codex --model x"\nclaude = "claude --continue"\n`)
  expect(await loadAgents(path, onlyInstalled("claude", "codex"))).toEqual({
    agents: [
      { name: "review", command: "codex --model x" },
      { name: "claude", command: "claude --continue" },
      { name: "codex", command: "codex" },
    ],
    defaultAgent: "review",
    error: null,
  })
})

test("default_agent can name any installed command", async () => {
  await writeFile(path, `default_agent = "mytool"\n`)
  const config = await loadAgents(path, onlyInstalled("mytool"))
  expect(config.defaultAgent).toBe("mytool")
  expect(config.agents).toEqual([{ name: "mytool", command: "mytool" }])
  expect(config.error).toBeNull()
})

test("a default that doesn't exist is reported, not launched", async () => {
  await writeFile(path, `default_agent = "ghost"\n`)
  const config = await loadAgents(path, onlyInstalled("claude"))
  expect(config.defaultAgent).toBeNull()
  expect(config.error).toContain(`"ghost"`)
  expect(config.agents.map((a) => a.name)).toEqual(["claude"])
})

test("bad config is reported, and installed agents are still offered", async () => {
  await writeFile(path, "default_agent = \n")
  const invalid = await loadAgents(path, onlyInstalled("claude"))
  expect(invalid.error).toContain(path)
  expect(invalid.agents.map((a) => a.name)).toEqual(["claude"])

  await writeFile(path, `default_agent = 3\n[agents]\nbad = 1\nempty = " "\ngood = "good --x"\n`)
  const wrongTypes = await loadAgents(path, onlyInstalled())
  expect(wrongTypes.agents).toEqual([{ name: "good", command: "good --x" }])
  expect(wrongTypes.defaultAgent).toBeNull()
  expect(wrongTypes.error).toContain("agents.bad")
  expect(wrongTypes.error).toContain("agents.empty")
  expect(wrongTypes.error).toContain("default_agent must be a string")

  await writeFile(path, `agents = "nope"\n`)
  expect((await loadAgents(path, onlyInstalled())).error).toContain("[agents] must be a table")
})

test("saveDefaultAgent creates the file and its folder", async () => {
  const nested = join(dir, "a/b/config.toml")
  await saveDefaultAgent("claude", nested)
  expect(await readFile(nested, "utf8")).toBe(`default_agent = "claude"\n`)
})

test("saveDefaultAgent replaces the old value and keeps everything else", async () => {
  const before = `# my agents\ndefault_agent = "old" # trailing\n\n[agents]\n# review things\nreview = "codex"\n`
  await writeFile(path, before)
  await saveDefaultAgent("review", path)
  expect(await readFile(path, "utf8")).toBe(`# my agents\ndefault_agent = "review"\n\n[agents]\n# review things\nreview = "codex"\n`)
  expect((await loadAgents(path, onlyInstalled())).defaultAgent).toBe("review")
})

test("saveDefaultAgent adds the key above tables, where TOML needs it", async () => {
  await writeFile(path, `[agents]\nreview = "codex"\n`)
  await saveDefaultAgent("review", path)
  const config = await loadAgents(path, onlyInstalled())
  expect(config.defaultAgent).toBe("review")
  expect(config.agents).toEqual([{ name: "review", command: "codex" }])
})

test("saveDefaultAgent ignores a same-named key inside a table", async () => {
  await writeFile(path, `[other]\ndefault_agent = "untouched"\n`)
  await saveDefaultAgent("claude", path)
  const text = await readFile(path, "utf8")
  expect(text).toStartWith(`default_agent = "claude"\n`)
  expect(text).toContain(`default_agent = "untouched"`)
})

test("saveDefaultAgent doesn't treat special characters in the name as a pattern", async () => {
  await mkdir(dir, { recursive: true })
  await writeFile(path, `default_agent = "old"\n`)
  await saveDefaultAgent('we$&ird"name', path)
  expect((await loadAgents(path, onlyInstalled('we$&ird"name'))).defaultAgent).toBe('we$&ird"name')
})

test("launchables load in file order, as inline or full tables", async () => {
  await writeFile(
    path,
    `[launchables]\nyazi = { key = "y", command = "yazi" }\nterminal = { key = "t", command = "$SHELL" }\n\n[launchables.code]\nkey = "c"\ncommand = "code ."\n`,
  )
  expect(await loadLaunchables(path)).toEqual({
    launchables: [
      { name: "yazi", key: "y", command: "yazi" },
      { name: "terminal", key: "t", command: "$SHELL" },
      { name: "code", key: "c", command: "code ." },
    ],
    error: null,
  })
})

const terminal = {
  name: "terminal",
  key: "t",
  command: "${SHELL:-/bin/sh} || true",
  hint: "Type exit to return to lawnchy",
}

test("a terminal is available with no configuration", async () => {
  expect(await loadLaunchables(path)).toEqual({ launchables: [terminal], error: null })
  await writeFile(path, `default_agent = "x"\n`)
  expect(await loadLaunchables(path)).toEqual({ launchables: [terminal], error: null })
})

test("the built-in terminal comes after configured entries", async () => {
  await writeFile(path, `[launchables]\nyazi = { key = "y", command = "yazi" }\n`)
  const { launchables } = await loadLaunchables(path)
  expect(launchables.map((item) => item.name)).toEqual(["yazi", "terminal"])
})

test("the built-in terminal steps aside for its name or its key", async () => {
  await writeFile(path, `[launchables]\nterminal = { key = "s", command = "fish" }\n`)
  expect((await loadLaunchables(path)).launchables).toEqual([{ name: "terminal", key: "s", command: "fish" }])

  await writeFile(path, `[launchables]\ntests = { key = "t", command = "make test" }\n`)
  expect((await loadLaunchables(path)).launchables).toEqual([{ name: "tests", key: "t", command: "make test" }])
})

test("the built-in terminal survives a broken config file", async () => {
  await writeFile(path, "launchables = \n")
  const { launchables, error } = await loadLaunchables(path)
  expect(launchables).toEqual([terminal])
  expect(error).toContain(path)
})

test("bad launchables are reported, and the valid ones still load", async () => {
  await writeFile(
    path,
    `[launchables]\ngood = { key = "g", command = "good" }\nnokey = { command = "x" }\nlong = { key = "ab", command = "x" }\nblank = { key = " ", command = "x" }\nnocmd = { key = "n" }\nclash = { key = "g", command = "other" }\nodd = "not a table"\n`,
  )
  const { launchables, error } = await loadLaunchables(path)
  expect(launchables).toEqual([{ name: "good", key: "g", command: "good" }, terminal])
  for (const name of ["nokey", "long", "blank", "nocmd", "clash", "odd"]) expect(error).toContain(`launchables.${name}`)
  expect(error).toContain(`reuses the key "g"`)
})

test("upper and lower case keys are different, and any single character works", async () => {
  await writeFile(path, `[launchables]\na = { key = "c", command = "a" }\nb = { key = "C", command = "b" }\nd = { key = "é", command = "d" }\n`)
  const { launchables, error } = await loadLaunchables(path)
  expect(error).toBeNull()
  expect(launchables.map((item) => item.key)).toEqual(["c", "C", "é", "t"])
})

test("launchables of the wrong type are reported", async () => {
  await writeFile(path, `launchables = 3\n`)
  expect((await loadLaunchables(path)).error).toContain("[launchables] must be a table")
})
