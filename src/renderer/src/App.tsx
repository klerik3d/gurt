import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { EnvRef, RepoChanges, SessionInfo, SessionSnapshot, Tree } from '../../shared/types'
import { Sidebar } from './components/Sidebar'
import { SessionPane } from './components/SessionPane'
import { TaskPane } from './components/TaskPane'
import { AgentsModal } from './components/AgentsModal'

export type Selection =
  | { type: 'session'; id: string }
  | { type: 'task'; ws: string; task: string }
  | null

export const envKey = (ref: EnvRef) => `${ref.workspace}/${ref.task}/${ref.repo}`

// Draggable sidebar width, persisted across launches.
const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 600
const SIDEBAR_DEFAULT = 262
const SIDEBAR_WIDTH_KEY = 'gurt.sidebarWidth'

const clampSidebar = (w: number) => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w))

/** Global FIFO positions (1-based) of every queued session, keyed by id. */
export function queuePositions(tree: Tree | null): Record<string, number> {
  const queued: SessionInfo[] = []
  for (const ws of tree?.workspaces ?? [])
    for (const task of ws.tasks)
      for (const s of task.sessions) if (s.state === 'queued') queued.push(s)
  queued.sort((a, b) => (a.queuedAt ?? '').localeCompare(b.queuedAt ?? ''))
  const map: Record<string, number> = {}
  queued.forEach((s, i) => (map[s.id] = i + 1))
  return map
}

export default function App() {
  const [tree, setTree] = useState<Tree | null>(null)
  const [selection, setSelection] = useState<Selection>(null)
  const [snapshots, setSnapshots] = useState<Record<string, SessionSnapshot>>({})
  const [logs, setLogs] = useState<Record<string, string[]>>({})
  /** Per-task git changes snapshot, keyed `ws/task` — read by TaskPane and the sidebar badge. */
  const [changes, setChanges] = useState<Record<string, RepoChanges[]>>({})
  const [agentsOpen, setAgentsOpen] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
    return saved ? clampSidebar(saved) : SIDEBAR_DEFAULT
  })
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  /** Session busy flags, to detect the end of an agent turn (busy → idle). */
  const busyRef = useRef<Record<string, boolean>>({})
  /** Tasks whose changes were already requested at least once (app-start lazy load). */
  const changesRequested = useRef<Set<string>>(new Set())

  const refreshTree = useCallback(() => {
    window.gurt.getTree().then(setTree).catch(console.error)
  }, [])

  /** `fetch` reaches the network — only the panel's own triggers pass it. */
  const refreshChanges = useCallback((ws: string, task: string, fetch = false) => {
    const key = `${ws}/${task}`
    changesRequested.current.add(key)
    window.gurt
      .getTaskChanges(ws, task, { fetch })
      .then((c) => setChanges((prev) => ({ ...prev, [key]: c })))
      .catch(console.error)
  }, [])

  useEffect(() => {
    refreshTree()
    const offTree = window.gurt.onTreeChanged(refreshTree)
    const offSession = window.gurt.onSessionChanged((snap) => {
      setSnapshots((prev) => ({ ...prev, [snap.info.id]: snap }))
      // End of an agent turn — recompute the task's git state, but never fetch.
      if (busyRef.current[snap.info.id] && !snap.busy)
        refreshChanges(snap.info.workspace, snap.info.task)
      busyRef.current[snap.info.id] = snap.busy
    })
    const offLog = window.gurt.onProvisionLog(({ key, line }) => {
      setLogs((prev) => ({ ...prev, [key]: [...(prev[key] ?? []).slice(-500), line] }))
    })
    return () => {
      offTree()
      offSession()
      offLog()
    }
  }, [refreshTree, refreshChanges])

  // Lazy app-start load: fetch changes once for every task the tree shows,
  // so sidebar badges appear without opening each task pane.
  useEffect(() => {
    for (const ws of tree?.workspaces ?? [])
      for (const task of ws.tasks)
        if (!changesRequested.current.has(`${ws.name}/${task.name}`))
          refreshChanges(ws.name, task.name)
  }, [tree, refreshChanges])

  // Drag the divider between sidebar and main; the sidebar's left edge is at
  // x=0, so the pointer's clientX is the new width (clamped).
  const startSidebarResize = useCallback((e: ReactMouseEvent) => {
    e.preventDefault()
    const onMove = (ev: MouseEvent) => setSidebarWidth(clampSidebar(ev.clientX))
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
  }, [sidebarWidth])

  const selectSession = useCallback((id: string) => {
    setSelection({ type: 'session', id })
    window.gurt
      .sessionSnapshot(id)
      .then((snap) => {
        if (snap) setSnapshots((prev) => ({ ...prev, [id]: snap }))
      })
      .catch(console.error)
  }, [])

  const positions = queuePositions(tree)

  // The tree only refetches on `tree-changed`, which doesn't fire on busy /
  // permission transitions. Overlay the freshest runtime flags from snapshots
  // (pushed on every session change) so the sidebar's run/wait/idle marks stay live.
  const activity: Record<string, { busy?: boolean; awaitingInput?: boolean }> = {}
  for (const [id, snap] of Object.entries(snapshots))
    activity[id] = { busy: snap.info.busy, awaitingInput: snap.info.awaitingInput }

  const activeSnap = selection?.type === 'session' ? snapshots[selection.id] : undefined
  const activeInfo = activeSnap?.info
  const activeEnv =
    activeInfo &&
    tree?.workspaces
      .find((w) => w.name === activeInfo.workspace)
      ?.tasks.find((t) => t.name === activeInfo.task)
      ?.envs.find((e) => e.repo === activeInfo.envRepo)

  const titleText = activeInfo
    ? `gurt — ${activeInfo.envRepo} · ${activeInfo.title}`
    : selection?.type === 'task'
      ? `gurt — ${selection.ws} / ${selection.task}`
      : 'gurt'

  return (
    <div className="app">
      <div className="titlebar">
        <div className="titlebar-pill">
          <span style={{ opacity: 0.8 }}>⌕</span>
          {titleText}
        </div>
        <div className="titlebar-icons">▤ ▦ ⬓</div>
      </div>
      <div className="workbench">
        <Sidebar
          width={sidebarWidth}
          tree={tree}
          selection={selection}
          changes={changes}
          activity={activity}
          onSelectTask={(ws, task) => setSelection({ type: 'task', ws, task })}
          onSelectSession={selectSession}
          onOpenAgents={() => setAgentsOpen(true)}
        />
        <div
          className="sidebar-resizer"
          onMouseDown={startSidebarResize}
          title="drag to resize"
        />
        <main className="main">
        {selection?.type === 'session' && (
          <SessionPane
            snapshot={snapshots[selection.id]}
            sessionId={selection.id}
            queuePosition={positions[selection.id]}
            log={
              snapshots[selection.id]
                ? logs[
                    envKey({
                      workspace: snapshots[selection.id].info.workspace,
                      task: snapshots[selection.id].info.task,
                      repo: snapshots[selection.id].info.envRepo
                    })
                  ] ?? []
                : []
            }
            onDeleted={() => setSelection(null)}
          />
        )}
        {selection?.type === 'task' && (
          <TaskPane
            tree={tree}
            ws={selection.ws}
            task={selection.task}
            logs={logs}
            positions={positions}
            changes={changes[`${selection.ws}/${selection.task}`]}
            onRefreshChanges={() => refreshChanges(selection.ws, selection.task, true)}
            onSelectSession={selectSession}
          />
        )}
        {!selection && (
          <div className="placeholder">
            select a session on the left, or create a workspace to get started
          </div>
        )}
        </main>
      </div>
      <div className="statusbar">
        {activeEnv ? (
          <>
            <span className={activeEnv.status === 'running' ? 'ok' : ''}>
              {activeEnv.status === 'running' ? '● ' : '○ '}
              {activeInfo!.envRepo} {activeEnv.status}
            </span>
            <span>gurt/{activeInfo!.task}</span>
          </>
        ) : (
          <span>gurt</span>
        )}
      </div>
      {agentsOpen && <AgentsModal onClose={() => setAgentsOpen(false)} />}
    </div>
  )
}
