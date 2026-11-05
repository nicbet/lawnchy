import { writeSync } from "node:fs"
import { homedir } from "node:os"
import type { CliRenderer } from "@opentui/core"
import { type Agent, APP_NAME } from "./config.ts"
import { cleanGitEnv } from "./git.ts"

/** Ctrl+C and Ctrl+\ go to everything in the terminal's foreground, including us. */
const TERMINAL_STOP_SIGNALS = ["SIGINT", "SIGQUIT"] as const
/** Exit codes of programs stopped by those signals, which aren't failures here. */
const STOPPED_EXIT_CODES = [130, 131]

/** Lets a program, or the user's shell prompt, know it was started from here. */
export const CHILD_ENV_VAR = APP_NAME.toUpperCase()

const DIM = "\x1b[2m"
const BOLD = "\x1b[1m"
const RESET = "\x1b[0m"
const SAVE_TITLE = "\x1b[22;0t"
const RESTORE_TITLE = "\x1b[23;0t"
const setTitle = (title: string) => `\x1b]2;${title}\x07`

export type Write = (text: string) => void

function writeToTerminal(text: string): void {
  try {
    writeSync(process.stdout.fd, text)
  } catch {
    // These messages are a courtesy, and never worth failing a launch over.
  }
}

/** Directory and config names could otherwise send escape sequences to the terminal. */
function printable(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, "")
}

function displayPath(path: string): string {
  const home = homedir()
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** Shown above the program, explaining what's running and how to get back. */
export function startMessage(name: string, path: string, hint: string): string {
  const running = `${APP_NAME} ▸ running ${BOLD}${printable(name)}${RESET}${DIM} in ${printable(displayPath(path))}`
  return `\n${DIM}${running}${RESET}\n${DIM}${APP_NAME} ▸ ${printable(hint)}${RESET}\n\n`
}

/** Closes the message above, so it isn't left looking current after we quit. */
export function endMessage(name: string): string {
  return `\n${DIM}${APP_NAME} ▸ ${printable(name)} finished${RESET}\n`
}

function ignoreSignal() {}

interface Program {
  name: string
  argv: string[]
  cwd: string
  /** How to get back here. */
  hint?: string
}

/**
 * Gives the terminal to a program, and takes it back when it exits.
 * Resolves to a message for the user if something went wrong, otherwise null.
 */
async function handOver(renderer: CliRenderer, program: Program, write: Write): Promise<string | null> {
  const { name, argv, cwd, hint = `Quit it to return to ${APP_NAME}` } = program
  await renderer.suspend()
  // Suspending removes the renderer's signal handlers, so without these, stopping the
  // program with Ctrl+C would kill us too. Resuming restores the renderer's own handlers.
  for (const signal of TERMINAL_STOP_SIGNALS) process.on(signal, ignoreSignal)
  write(`${SAVE_TITLE}${setTitle(`${APP_NAME} ▸ ${printable(name)}`)}${startMessage(name, cwd, hint)}`)
  try {
    const proc = Bun.spawn(argv, {
      cwd,
      env: { ...cleanGitEnv(), [CHILD_ENV_VAR]: "1" },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    const exitCode = await proc.exited
    const stopped =
      STOPPED_EXIT_CODES.includes(exitCode) || TERMINAL_STOP_SIGNALS.some((signal) => signal === proc.signalCode)
    return exitCode === 0 || stopped ? null : `${name} exited with code ${exitCode}`
  } catch (error) {
    return `Couldn't start ${name}: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    // Setting a title first means terminals that can't restore one aren't left with a stale name.
    write(`${endMessage(name)}${setTitle(APP_NAME)}${RESTORE_TITLE}`)
    for (const signal of TERMINAL_STOP_SIGNALS) process.off(signal, ignoreSignal)
    await renderer.resume()
  }
}

export async function runLazygit(renderer: CliRenderer, path: string, write = writeToTerminal): Promise<string | null> {
  if (!Bun.which("lazygit")) return "lazygit isn't installed or isn't on your PATH"
  return handOver(renderer, { name: "lazygit", argv: ["lazygit"], cwd: path }, write)
}

/** Whether `sh` can run this word, which unlike a PATH lookup includes builtins like `cd`. */
function shellKnows(program: string): boolean {
  const check = ["/bin/sh", "-c", 'command -v "$1"', "sh", program]
  return Bun.spawnSync(check, { stdout: "ignore", stderr: "ignore" }).exitCode === 0
}

/** Runs an agent or launchable through `sh`, so commands can use arguments and variables. */
export async function runCommand(
  renderer: CliRenderer,
  agent: Agent,
  path: string,
  write = writeToTerminal,
): Promise<string | null> {
  // Catch a missing program here, because its shell error would vanish when the screen returns.
  // Anything more complex than a plain word, like a variable or path, is left for the shell.
  const program = agent.command.trim().split(/\s+/)[0] ?? ""
  if (!/[=/~$"'(\\]/.test(program) && !shellKnows(program)) {
    return `${agent.name}: ${program} isn't installed or isn't on your PATH`
  }
  const argv = ["/bin/sh", "-c", agent.command]
  return handOver(renderer, { name: agent.name, argv, cwd: path, hint: agent.hint }, write)
}
