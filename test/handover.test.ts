import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { CliRenderer } from "@opentui/core"
import { endMessage, runCommand, startMessage } from "../src/handover.ts"
import { makeTemp } from "./helpers.ts"

function fakeRenderer() {
  const events: string[] = []
  const count = () => process.listenerCount("SIGINT")
  const renderer = {
    suspend: async () => void events.push(`suspend:${count()}`),
    resume: async () => void events.push(`resume:${count()}`),
  } as unknown as CliRenderer
  return { renderer, events, count }
}

const run = async (command: string, hint?: string) => {
  const { dir, cleanup } = await makeTemp()
  const fake = fakeRenderer()
  const before = fake.count()
  const written: string[] = []
  const write = (text: string) => {
    written.push(text)
    fake.events.push("write")
  }
  try {
    const result = await runCommand(fake.renderer, { name: "tool", command, hint }, dir, write)
    return { result, before, after: fake.count(), events: fake.events, written, dir }
  } finally {
    await cleanup()
  }
}

// $PPID is this test process. Without the protection, these signals would kill the test run.
test("Ctrl+C reaching us while a program runs doesn't stop us", async () => {
  expect((await run("kill -INT $PPID; sleep 0.1")).result).toBeNull()
})

test("Ctrl+\\ reaching us while a program runs doesn't stop us", async () => {
  expect((await run("kill -QUIT $PPID; sleep 0.1")).result).toBeNull()
})

test("signal handling is only changed during the handover", async () => {
  const { before, after, events } = await run("true")
  expect(after).toBe(before)
  // Gone before resuming, so the renderer's own handlers are the only ones afterwards.
  expect(events).toEqual([`suspend:${before}`, "write", "write", `resume:${before}`])
})

test("a program stopped by Ctrl+C or Ctrl+\\ isn't reported as a failure", async () => {
  expect((await run("kill -INT $$")).result).toBeNull()
  expect((await run("kill -QUIT $$")).result).toBeNull()
  expect((await run("exit 130")).result).toBeNull()
})

test("real failures are still reported", async () => {
  expect((await run("exit 3")).result).toBe("tool exited with code 3")
  expect((await run("kill -TERM $$")).result).toContain("tool exited with code")
})

test("shell builtins and complex commands aren't mistaken for missing programs", async () => {
  expect((await run("cd . && true")).result).toBeNull()
  expect((await run("FOO=1 true")).result).toBeNull()
  expect((await run('"true"')).result).toBeNull()
  expect((await run("(true)")).result).toBeNull()
  expect((await run("$NOT_SET true")).result).toBeNull()
})

test("a missing program is caught before giving up the terminal", async () => {
  const { result, events } = await run("definitely-not-installed --flag")
  expect(result).toContain("isn't installed")
  expect(events).toEqual([])
})

test("the terminal shows what's running and how to get back, then says it finished", async () => {
  const { written, dir } = await run("true")
  const [start, end] = written as [string, string]
  expect(start).toContain("running")
  expect(start).toContain("tool")
  expect(start).toContain(dir)
  expect(start).toContain("Quit it to return to lawnchy")
  expect(end).toContain("tool finished")
})

test("a program's own hint replaces the generic one", async () => {
  const { written } = await run("true", "Type exit to return")
  expect(written[0]).toContain("Type exit to return")
  expect(written[0]).not.toContain("Quit it")
})

test("the terminal title is saved, set to the program, and restored", async () => {
  const { written } = await run("true")
  const [start, end] = written as [string, string]
  expect(start.indexOf("\x1b[22;0t")).toBeLessThan(start.indexOf("\x1b]2;lawnchy ▸ tool\x07"))
  // A terminal that can't restore titles is left with this one, rather than the program's.
  expect(end.indexOf("\x1b]2;lawnchy\x07")).toBeLessThan(end.indexOf("\x1b[23;0t"))
  expect(end.indexOf("\x1b]2;lawnchy\x07")).toBeGreaterThanOrEqual(0)
})

test("the program can tell it was started from here", async () => {
  const { dir, cleanup } = await makeTemp()
  const seen = join(dir, "seen")
  try {
    await runCommand(fakeRenderer().renderer, { name: "tool", command: `printf "%s" "$LAWNCHY" > "${seen}"` }, dir, () => {})
    expect(await readFile(seen, "utf8")).toBe("1")
  } finally {
    await cleanup()
  }
})

test("messages can't send escape sequences from file or config names", () => {
  const evil = "x\x1b]2;pwned\x07\x1b[2Jy"
  const messages = startMessage(evil, `/tmp/${evil}`, evil) + endMessage(evil)
  expect(messages).not.toContain("\x1b]")
  expect(messages).not.toContain("\x1b[2J")
  expect(messages).not.toContain("\x07")
  expect(messages).toContain("x]2;pwned[2Jy")
})

test("paths under the home folder are shortened", () => {
  expect(startMessage("tool", join(homedir(), "code/api"), "hint")).toContain("~/code/api")
  expect(startMessage("tool", `${homedir()}-other/api`, "hint")).toContain(`${homedir()}-other/api`)
})
