import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { type ReactNode, useMemo, useRef, useState } from "react"
import {
  type Agent,
  type AgentConfig,
  APP_NAME,
  configPath,
  type Launchable,
  loadAgents,
  loadLaunchables,
  saveDefaultAgent,
} from "./config.ts"
import { runCommand, runLazygit } from "./handover.ts"
import {
  buildRows,
  COLORS,
  columnWidths,
  compileFilter,
  fit,
  isBoring,
  nameParts,
  repoName,
  scrollOffset,
  shortenStart,
  spreadEvenly,
  type Row,
} from "./rows.ts"
import { useRepos } from "./useRepos.ts"

/** Title, column titles, detail line, key help and four rules. */
const CHROME_HEIGHT = 8
/** Horizontal padding of the title and footer rows; lines them up with the repo names. */
const PADDING_X = 2
const KEY_HELP = [
  "↑↓←→ nav",
  "⏎ lazygit",
  "a agent",
  "x run",
  "/ filter",
  "b boring",
  "r refresh",
  "q quit",
  "+add ~mod ?new !conflict",
]

function Rule({ width }: { width: number }) {
  return (
    <box height={1}>
      <text wrapMode="none" fg={COLORS.dim}>
        {"─".repeat(width)}
      </text>
    </box>
  )
}

function RowLine({ row, width, selected }: { row: Row; width: number; selected: boolean }) {
  const columns = columnWidths(width)
  const { prefix, name, suffix } = nameParts(row, columns.name)
  const main = selected ? COLORS.selectedFg : undefined
  return (
    <box height={1} backgroundColor={selected ? COLORS.selectedBg : undefined}>
      <text wrapMode="none">
        <span fg={selected ? main : COLORS.dim}>{prefix}</span>
        <span fg={main}>{name}</span>
        <span fg={selected ? main : COLORS.warn}>{suffix}</span>
        <span> </span>
        <span fg={main ?? row.branch.color}>{fit(row.branch.text, columns.branch)}</span>
        <span> </span>
        <span fg={row.status.color}>{fit(row.status.text, columns.status)}</span>
        <span> </span>
        <span fg={row.sync.color}>{fit(row.sync.text, columns.sync)}</span>
      </text>
    </box>
  )
}

interface AgentPickerState {
  /** Folder the agent will run in. */
  path: string
  agents: Agent[]
  defaultAgent: string | null
  index: number
}

interface LauncherState {
  /** Folder the launchable will run in. */
  path: string
  launchables: Launchable[]
}

const PICKER_CHROME_HEIGHT = 4

const POPUP_MAX_WIDTH = 72

/** A centered dialog: its folder on the first line, then rows, then a hint. */
function Popup({
  title,
  path,
  hint,
  rowCount,
  width,
  height,
  children,
}: {
  title: string
  path: string
  hint: string[]
  rowCount: number
  width: number
  height: number
  children: ReactNode
}) {
  const boxWidth = popupWidth(width)
  const innerWidth = boxWidth - POPUP_CHROME_WIDTH
  const boxHeight = rowCount + PICKER_CHROME_HEIGHT
  return (
    <box
      position="absolute"
      zIndex={10}
      left={Math.max(0, Math.floor((width - boxWidth) / 2))}
      top={Math.max(0, Math.floor((height - boxHeight) / 2))}
      width={boxWidth}
      height={boxHeight}
      flexDirection="column"
      border
      borderColor={COLORS.info}
      backgroundColor={COLORS.popupBg}
      title={` ${title} `}
      paddingLeft={1}
      paddingRight={1}
    >
      <text wrapMode="none" fg={COLORS.dim}>
        {fit(shortenStart(path, innerWidth), innerWidth)}
      </text>
      {children}
      <text wrapMode="none" fg={COLORS.dim}>
        {fit(spreadEvenly(hint, innerWidth), innerWidth)}
      </text>
    </box>
  )
}

const POPUP_CHROME_WIDTH = 4
const popupWidth = (width: number) => Math.min(POPUP_MAX_WIDTH, width - POPUP_CHROME_WIDTH)
const popupRowCount = (items: number, height: number) =>
  Math.max(1, Math.min(items, height - PICKER_CHROME_HEIGHT - 2))

function AgentPicker({ picker, width, height }: { picker: AgentPickerState; width: number; height: number }) {
  const innerWidth = popupWidth(width) - POPUP_CHROME_WIDTH
  const rowCount = popupRowCount(picker.agents.length, height)
  const start = scrollOffset(0, picker.index, rowCount, picker.agents.length)
  const nameWidth = Math.min(16, Math.floor(innerWidth / 3))
  return (
    <Popup
      title="Launch agent"
      path={picker.path}
      hint={["⏎ launch", "d set default", "esc cancel"]}
      rowCount={rowCount}
      width={width}
      height={height}
    >
      {picker.agents.slice(start, start + rowCount).map((agent, i) => {
        const selected = start + i === picker.index
        const isDefault = agent.name === picker.defaultAgent
        const marker = isDefault ? "  default" : ""
        return (
          <box key={agent.name} height={1} backgroundColor={selected ? COLORS.selectedBg : undefined}>
            <text wrapMode="none">
              <span fg={COLORS.selectedFg}>{fit(agent.name, nameWidth)}</span>
              <span> </span>
              <span fg={selected ? COLORS.selectedFg : COLORS.dim}>
                {fit(agent.command, innerWidth - nameWidth - 1 - marker.length)}
              </span>
              <span fg={COLORS.ok}>{marker}</span>
            </text>
          </box>
        )
      })}
    </Popup>
  )
}

function LauncherDialog({ launcher, width, height }: { launcher: LauncherState; width: number; height: number }) {
  const innerWidth = popupWidth(width) - POPUP_CHROME_WIDTH
  const rowCount = popupRowCount(launcher.launchables.length, height)
  const keyWidth = 4
  const nameWidth = Math.min(16, Math.floor(innerWidth / 3))
  return (
    <Popup title="Launch" path={launcher.path} hint={["press a key", "esc cancel"]} rowCount={rowCount} width={width} height={height}>
      {launcher.launchables.slice(0, rowCount).map((item) => (
        <box key={item.name} height={1}>
          <text wrapMode="none">
            <span fg={COLORS.info}>{fit(item.key, keyWidth)}</span>
            <span fg={COLORS.selectedFg}>{fit(item.name, nameWidth)}</span>
            <span> </span>
            <span fg={COLORS.dim}>{fit(item.command, innerWidth - keyWidth - nameWidth - 1)}</span>
          </text>
        </box>
      ))}
    </Popup>
  )
}

const realLaunchService = {
  load: (): Promise<AgentConfig> => loadAgents(),
  loadLaunchables: () => loadLaunchables(),
  saveDefault: (name: string): Promise<void> => saveDefaultAgent(name),
  run: runCommand,
}

export function App({
  root,
  openInLazygit = runLazygit,
  launchService = realLaunchService,
}: {
  root: string
  openInLazygit?: typeof runLazygit
  launchService?: typeof realLaunchService
}) {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const { repos, scanning, refresh } = useRepos(root)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [hideBoring, setHideBoring] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const lastIndex = useRef(0)
  const offset = useRef(0)

  const [filter, setFilter] = useState("")
  const [editingFilter, setEditingFilter] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [picker, setPicker] = useState<AgentPickerState | null>(null)
  const [launcher, setLauncher] = useState<LauncherState | null>(null)
  const opening = useRef(false)
  const matchingRepos = useMemo(() => {
    if (!filter) return repos
    const matches = compileFilter(filter)
    return repos.filter((repo) => matches(repoName(repo, root)))
  }, [repos, root, filter])
  const shownRepos = useMemo(
    () => (hideBoring ? matchingRepos.filter((repo) => !isBoring(repo)) : matchingRepos),
    [matchingRepos, hideBoring],
  )
  const hiddenCount = matchingRepos.length - shownRepos.length
  const rows = useMemo(() => buildRows(shownRepos, root, collapsed), [shownRepos, root, collapsed])

  // Track selection by key so it survives refreshes; if the row vanished, stay at its position.
  const found = rows.findIndex((row) => row.key === selectedKey)
  const index = found >= 0 ? found : Math.min(lastIndex.current, Math.max(0, rows.length - 1))
  lastIndex.current = index
  const selected = rows[index]

  const viewport = Math.max(1, height - CHROME_HEIGHT)
  offset.current = scrollOffset(offset.current, index, viewport, rows.length)
  const visible = rows.slice(offset.current, offset.current + viewport)

  const moveTo = (target: number) => {
    const next = Math.max(0, Math.min(target, rows.length - 1))
    const row = rows[next]
    if (!row) return
    // Updated now because keys can arrive faster than redraws.
    lastIndex.current = next
    setSelectedKey(row.key)
  }

  const setExpanded = (repoKey: string, expanded: boolean) => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (expanded) next.delete(repoKey)
      else next.add(repoKey)
      return next
    })
  }

  const openSelected = async () => {
    if (!selected?.openPath) return
    opening.current = true
    try {
      setNotice(await openInLazygit(renderer, selected.openPath))
      void refresh()
    } finally {
      opening.current = false
    }
  }

  const launchAgent = async (agent: Agent, path: string) => {
    opening.current = true
    setPicker(null)
    setLauncher(null)
    try {
      setNotice(await launchService.run(renderer, agent, path))
      void refresh()
    } finally {
      opening.current = false
    }
  }

  /** Runs the default agent on the highlighted row, or asks which one to run. */
  const startAgent = async (alwaysAsk: boolean) => {
    const path = selected?.openPath
    if (!path) return
    opening.current = true
    let config: AgentConfig
    try {
      config = await launchService.load()
    } finally {
      opening.current = false
    }
    setNotice(config.error)

    const defaultAgent = config.agents.find((agent) => agent.name === config.defaultAgent)
    if (defaultAgent && !alwaysAsk) {
      await launchAgent(defaultAgent, path)
    } else if (config.agents.length === 0) {
      setNotice(config.error ?? `No agents found. Add one to [agents] in ${configPath()}`)
    } else {
      setPicker({
        path,
        agents: config.agents,
        defaultAgent: config.defaultAgent,
        index: defaultAgent ? config.agents.indexOf(defaultAgent) : 0,
      })
    }
  }

  const startLauncher = async () => {
    const path = selected?.openPath
    if (!path) return
    opening.current = true
    try {
      const { launchables, error } = await launchService.loadLaunchables()
      setNotice(error)
      setLauncher({ path, launchables })
    } finally {
      opening.current = false
    }
  }

  const handlePickerKey = (current: AgentPickerState, name: string) => {
    const move = (delta: number) => {
      const index = Math.max(0, Math.min(current.index + delta, current.agents.length - 1))
      setPicker({ ...current, index })
    }
    const agent = current.agents[current.index]
    switch (name) {
      case "escape":
        setPicker(null)
        break
      case "up":
      case "k":
        move(-1)
        break
      case "down":
      case "j":
        move(1)
        break
      case "return":
        if (agent) void launchAgent(agent, current.path)
        break
      case "d":
        if (agent) {
          setPicker({ ...current, defaultAgent: agent.name })
          launchService.saveDefault(agent.name).catch((error: unknown) => {
            setPicker((latest) => latest && { ...latest, defaultAgent: current.defaultAgent })
            setNotice(`Couldn't save the default agent: ${error instanceof Error ? error.message : String(error)}`)
          })
        }
        break
    }
  }

  useKeyboard((key) => {
    // Keys pressed between requesting a program and it taking over the terminal.
    if (opening.current) return
    setNotice(null)
    if (picker) {
      handlePickerKey(picker, key.name)
      return
    }
    if (launcher) {
      if (key.name === "escape") {
        setLauncher(null)
      } else if (!key.ctrl && !key.meta) {
        // Shifted letters are separate keys, so "c" and "C" can launch different things.
        const typed = key.shift ? key.name.toUpperCase() : key.name
        const match = launcher.launchables.find((item) => item.key === typed)
        if (match) void launchAgent(match, launcher.path)
      }
      return
    }
    if (editingFilter) {
      // The focused input takes everything else, so typing "q" doesn't quit.
      if (key.name === "escape") {
        setFilter("")
        setEditingFilter(false)
      }
      return
    }
    switch (key.name) {
      case "/":
        setEditingFilter(true)
        break
      case "escape":
        setFilter("")
        break
      case "q":
        renderer.destroy()
        break
      case "r":
        void refresh()
        break
      case "b":
        setHideBoring((previous) => !previous)
        break
      case "up":
      case "k":
        moveTo(lastIndex.current - 1)
        break
      case "down":
      case "j":
        moveTo(lastIndex.current + 1)
        break
      case "pageup":
        moveTo(lastIndex.current - viewport)
        break
      case "pagedown":
        moveTo(lastIndex.current + viewport)
        break
      case "home":
        moveTo(0)
        break
      case "end":
        moveTo(rows.length - 1)
        break
      case "left":
      case "h":
        if (selected?.expandable && selected.expanded) setExpanded(selected.repoKey, false)
        else if (selected && selected.kind !== "repo") setSelectedKey(selected.repoKey)
        break
      case "right":
      case "l":
        if (selected?.expandable && !selected.expanded) setExpanded(selected.repoKey, true)
        break
      case "space":
        if (selected?.expandable) setExpanded(selected.repoKey, !selected.expanded)
        break
      case "return":
      case "o":
        void openSelected()
        break
      case "a":
        void startAgent(key.shift)
        break
      case "x":
        void startLauncher()
        break
    }
  })

  const columns = columnWidths(width)
  const countNotes = [
    filter && `${matchingRepos.length} match "${filter}"`,
    hiddenCount > 0 && `${hiddenCount} boring hidden`,
  ].filter(Boolean)
  const repoCount = `${repos.length} ${repos.length === 1 ? "repo" : "repos"}${countNotes.length > 0 ? ` (${countNotes.join(", ")})` : ""}`
  // The count stays whole at the far right; the path gets whatever room is left.
  const titleCount = `${scanning ? "scanning…  " : ""}${repoCount}`
  const titlePrefixWidth = `${APP_NAME}  `.length
  const titleMinGap = 2
  const paddedWidth = width - 2 * PADDING_X
  const titleRoot = shortenStart(root, paddedWidth - titlePrefixWidth - Bun.stringWidth(titleCount) - titleMinGap)
  const titlePadding = " ".repeat(
    Math.max(0, paddedWidth - titlePrefixWidth - Bun.stringWidth(titleRoot) - Bun.stringWidth(titleCount)),
  )
  const emptyMessage =
    repos.length === 0
      ? scanning
        ? "  Scanning…"
        : `  No git repositories found under ${root}`
      : matchingRepos.length === 0
        ? `  No repos match "${filter}". Press Esc to clear the filter.`
        : "  Nothing to report. Press b to show boring repos."

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box height={1} paddingLeft={PADDING_X} paddingRight={PADDING_X}>
        <text wrapMode="none">
          <strong>{APP_NAME}</strong>
          <span fg={COLORS.dim}>{`  ${titleRoot}${titlePadding}${titleCount}`}</span>
        </text>
      </box>
      <Rule width={width} />
      <box height={1}>
        <text wrapMode="none" fg={COLORS.dim}>
          {[
            fit("  REPOSITORY", columns.name),
            fit("BRANCH", columns.branch),
            fit("STATUS", columns.status),
            fit("SYNC", columns.sync),
          ].join(" ")}
        </text>
      </box>
      <Rule width={width} />
      <box flexGrow={1} flexDirection="column">
        {rows.length === 0 ? (
          <text fg={COLORS.dim}>{emptyMessage}</text>
        ) : (
          visible.map((row) => <RowLine key={row.key} row={row} width={width} selected={row === selected} />)
        )}
      </box>
      <Rule width={width} />
      <box height={1} paddingLeft={PADDING_X} paddingRight={PADDING_X}>
        <text wrapMode="none" fg={notice ? COLORS.bad : selected?.detail.color}>
          {fit(notice ?? selected?.detail.text ?? "", paddedWidth)}
        </text>
      </box>
      <Rule width={width} />
      {editingFilter ? (
        <box height={1} flexDirection="row" paddingLeft={PADDING_X} paddingRight={PADDING_X}>
          <text fg={COLORS.info}>{"/ "}</text>
          <input
            focused
            flexGrow={1}
            value={filter}
            placeholder="string or regexp  (Enter keeps, Esc clears)"
            onInput={setFilter}
            onSubmit={() => setEditingFilter(false)}
          />
        </box>
      ) : (
        <box height={1} paddingLeft={PADDING_X} paddingRight={PADDING_X}>
          <text wrapMode="none" fg={COLORS.dim}>
            {fit(spreadEvenly(KEY_HELP, paddedWidth), paddedWidth)}
          </text>
        </box>
      )}
      {picker && <AgentPicker picker={picker} width={width} height={height} />}
      {launcher && <LauncherDialog launcher={launcher} width={width} height={height} />}
    </box>
  )
}
