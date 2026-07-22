import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { RepoChanges, SessionInfo, SessionSnapshot, Tree } from '../../shared/types'
import { applyLog, sessionStatus } from '../../shared/types'
import { envKey } from '../../shared/keys'
import { Icon } from './components/icons'
import { Sidebar, NameModal, NewSessionModal } from './components/Sidebar'
import { SessionPane } from './components/SessionPane'
import { TaskPane } from './components/TaskPane'
import { SettingsPage, type SettingsSection } from './components/SettingsPage'
import { CommandPalette } from './components/CommandPalette'
import { DialogHost, alertDialog } from './dialog'

export type Selection =
  | { type: 'session'; id: string }
  | { type: 'task'; ws: string; task: string }
  | null

export type View = 'work' | 'dashboard' | 'settings'

export { envKey }

// Draggable sidebar width, persisted across launches.
const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 600
const SIDEBAR_DEFAULT = 284
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
  const [view, setView] = useState<View>('work')
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('environments')
  const [snapshots, setSnapshots] = useState<Record<string, SessionSnapshot>>({})
  const [logs, setLogs] = useState<Record<string, string[]>>({})
  /** Per-task git changes snapshot, keyed `ws/task` — read by TaskPane and the sidebar badge. */
  const [changes, setChanges] = useState<Record<string, RepoChanges[]>>({})
  const [paletteOpen, setPaletteOpen] = useState(false)
  /** New-session modal context; task empty → the modal's task picker chooses. */
  const [newSession, setNewSession] = useState<{ ws: string; task: string } | null>(null)
  const [newTask, setNewTask] = useState<string | null>(null)
  const [newWorkspace, setNewWorkspace] = useState(false)
  const [curWs, setCurWs] = useState<string | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
    return saved ? clampSidebar(saved) : SIDEBAR_DEFAULT
  })
  const selectionRef = useRef(selection)
  selectionRef.current = selection
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
    // session-changed carries no entries — keep the timeline we already hold;
    // session:snapshot (on select) delivers the full fold.
    const offSession = window.gurt.onSessionChanged((snap) => {
      setSnapshots((prev) => ({
        ...prev,
        [snap.info.id]: { ...snap, entries: snap.entries ?? prev[snap.info.id]?.entries }
      }))
    })
    // Timeline deltas. Records for a session whose snapshot (with entries) isn't
    // here yet are dropped — the snapshot fetch that follows selection supersedes them.
    const offSessionLog = window.gurt.onSessionLog(({ sessionId, records }) => {
      setSnapshots((prev) => {
        const cur = prev[sessionId]
        if (!cur?.entries) return prev
        return { ...prev, [sessionId]: { ...cur, entries: applyLog(cur.entries, records) } }
      })
    })
    // End of an agent turn — recompute the task's git state, but never fetch.
    const offTurn = window.gurt.onSessionTurn(({ ref, phase }) => {
      if (phase === 'ended') refreshChanges(ref.workspace, ref.task)
    })
    const offLog = window.gurt.onProvisionLog(({ key, line }) => {
      setLogs((prev) => ({ ...prev, [key]: [...(prev[key] ?? []).slice(-500), line] }))
    })
    return () => {
      offTree()
      offSession()
      offSessionLog()
      offTurn()
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

  // Keep the current workspace valid as the tree changes.
  const workspaces = tree?.workspaces ?? []
  const ws = workspaces.find((w) => w.name === curWs) ?? workspaces[0]
  useEffect(() => {
    if (tree && !tree.workspaces.some((w) => w.name === curWs))
      setCurWs(tree.workspaces[0]?.name ?? null)
  }, [tree, curWs])

  // Drag the divider between sidebar and main; the sidebar's left edge sits
  // after the 52px activity bar, so the new width is clientX minus that.
  const startSidebarResize = useCallback((e: ReactMouseEvent) => {
    e.preventDefault()
    const onMove = (ev: MouseEvent) => setSidebarWidth(clampSidebar(ev.clientX - 52))
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
    setView('work')
    setSelection({ type: 'session', id })
    window.gurt
      .sessionSnapshot(id)
      .then((snap) => {
        if (snap) setSnapshots((prev) => ({ ...prev, [id]: snap }))
      })
      .catch(console.error)
  }, [])

  const selectTask = useCallback((tws: string, task: string) => {
    setView('work')
    setSelection({ type: 'task', ws: tws, task })
  }, [])

  const openNewSession = useCallback(
    (ctx?: { ws: string; task: string }) => {
      if (ctx) {
        setNewSession(ctx)
        return
      }
      if (!ws) return
      // No explicit context (⌘N, palette) — prefill the task the user is looking at.
      const sel = selectionRef.current
      let task = ''
      if (sel?.type === 'task' && sel.ws === ws.name) task = sel.task
      else if (sel?.type === 'session')
        task = ws.tasks.find((t) => t.sessions.some((s) => s.id === sel.id))?.name ?? ''
      setNewSession({ ws: ws.name, task })
    },
    [ws]
  )

  // Global hotkeys: ⌘K palette · ⌘N new session · ⌘⇧N new task.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const k = e.key.toLowerCase()
      if (k === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      } else if (k === 'n') {
        e.preventDefault()
        if (e.shiftKey) {
          if (ws) setNewTask(ws.name)
        } else {
          openNewSession()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ws, openNewSession])

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
      ?.envs.find((e) => e.session === activeInfo.id)

  // Footer counters across every session, live overlay included.
  let runningCount = 0
  let needYouCount = 0
  for (const w of workspaces)
    for (const t of w.tasks)
      for (const s of t.sessions) {
        const st = sessionStatus({ ...s, ...activity[s.id] })
        if (st === 'running' || st === 'starting') runningCount++
        else if (st === 'waiting') needYouCount++
      }

  const activeStatus = activeInfo
    ? sessionStatus({ ...activeInfo, ...activity[activeInfo.id] })
    : null

  const crumb =
    view === 'settings'
      ? `${ws?.name ?? 'gurt'} / settings`
      : view === 'dashboard'
        ? `${ws?.name ?? 'gurt'} / dashboard`
        : activeInfo
          ? `${activeInfo.workspace} / ${activeInfo.task} · ${activeInfo.title}`
          : selection?.type === 'task'
            ? `${selection.ws} / ${selection.task}`
            : (ws?.name ?? 'gurt')

  const crumbTone =
    view === 'work' && activeStatus
      ? activeStatus === 'waiting' || activeStatus === 'running' || activeStatus === 'starting'
        ? 'yellow'
        : activeStatus === 'idle'
          ? 'green'
          : 'outline'
      : null

  return (
    <div className="app">
      <div className="titlebar">
        <div className="tb-logo">
          <div className="logo-dots">
            <span className="ld ld-accent" />
            <span className="ld" />
            <span className="ld" />
            <span className="ld" />
          </div>
          <span className="tb-name">gurt</span>
        </div>
        <div className="tb-center">
          <div className="tb-crumb">
            {crumbTone && (
              <span
                className={`dot dot-${crumbTone}${activeStatus === 'running' || activeStatus === 'starting' ? ' dot-pulse' : ''}`}
                style={{ width: 7, height: 7 }}
              />
            )}
            {crumb}
          </div>
        </div>
        <div className="tb-icons">
          <button className="icon-sq tb-btn" title="Search · ⌘K" onClick={() => setPaletteOpen(true)}>
            <Icon name="search" size={16} />
          </button>
          <button
            className="icon-sq tb-btn"
            title="Settings"
            onClick={() => setView((v) => (v === 'settings' ? 'work' : 'settings'))}
          >
            <Icon name="gear" size={16} />
          </button>
        </div>
      </div>

      <div className="workbench">
        <div className="activitybar">
          <button
            className={`ab-item ${view === 'work' ? 'active' : ''}`}
            title="Tasks & sessions"
            onClick={() => setView('work')}
          >
            <Icon name="message" size={17} />
          </button>
          <button
            className={`ab-item ${view === 'dashboard' ? 'active' : ''}`}
            title="Dashboard"
            onClick={() => setView('dashboard')}
          >
            <Icon name="grid" size={17} />
          </button>
          <span className="spacer" />
          <button
            className={`ab-item ${view === 'settings' ? 'active' : ''}`}
            title="Settings"
            onClick={() => setView('settings')}
          >
            <Icon name="sliders" size={17} />
          </button>
        </div>

        {view === 'work' && (
          <>
            <Sidebar
              width={sidebarWidth}
              tree={tree}
              ws={ws?.name ?? null}
              selection={selection}
              changes={changes}
              activity={activity}
              onPickWorkspace={setCurWs}
              onNewWorkspace={() => setNewWorkspace(true)}
              onNewTask={(w) => setNewTask(w)}
              onNewSession={(w, t) => setNewSession({ ws: w, task: t })}
              onSelectTask={selectTask}
              onSelectSession={selectSession}
              onOpenPalette={() => setPaletteOpen(true)}
            />
            <div className="sidebar-resizer" onMouseDown={startSidebarResize} />
            <main className="main">
              {selection?.type === 'session' && (
                <SessionPane
                  tree={tree}
                  snapshot={snapshots[selection.id]}
                  sessionId={selection.id}
                  queuePosition={positions[selection.id]}
                  log={
                    snapshots[selection.id]
                      ? logs[
                          envKey({
                            workspace: snapshots[selection.id].info.workspace,
                            task: snapshots[selection.id].info.task,
                            env: snapshots[selection.id].info.env,
                            session: snapshots[selection.id].info.id
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
                  select a session on the left, or press <span className="kbd">⌘K</span> to get
                  started
                </div>
              )}
            </main>
          </>
        )}

        {view === 'dashboard' && (
          <main className="main">
            <div className="placeholder">dashboard — coming soon</div>
          </main>
        )}

        {view === 'settings' && (
          <SettingsPage
            tree={tree}
            ws={ws?.name ?? null}
            section={settingsSection}
            onSection={setSettingsSection}
          />
        )}
      </div>

      <div className="footer">
        <span className="foot-left">
          {(runningCount > 0 || needYouCount > 0) && (
            <span className={`dot dot-yellow${runningCount > 0 ? ' dot-pulse' : ''}`} style={{ width: 6, height: 6 }} />
          )}
          {runningCount} running · {needYouCount} need you
        </span>
        <span className="spacer" />
        {activeInfo && activeEnv && (
          <>
            <span>
              {activeInfo.env}
              {activeInfo.repo ? ` · ${activeInfo.repo}` : ''} {activeEnv.status}
            </span>
            <span>gurt/{activeInfo.task}</span>
          </>
        )}
      </div>

      {paletteOpen && tree && (
        <CommandPalette
          tree={tree}
          activity={activity}
          onClose={() => setPaletteOpen(false)}
          onNewSession={() => {
            setPaletteOpen(false)
            openNewSession()
          }}
          onNewTask={() => {
            setPaletteOpen(false)
            if (ws) setNewTask(ws.name)
          }}
          onSelectSession={(id) => {
            setPaletteOpen(false)
            selectSession(id)
          }}
          onSelectTask={(w, t) => {
            setPaletteOpen(false)
            selectTask(w, t)
          }}
        />
      )}
      {newSession && tree && (
        <NewSessionModal
          tree={tree}
          ws={newSession.ws}
          task={newSession.task}
          onClose={() => setNewSession(null)}
          onCreated={(s) => {
            setNewSession(null)
            selectSession(s.id)
          }}
        />
      )}
      {newTask && (
        <NameModal
          title={`New task in ${newTask}`}
          placeholder="task name"
          onClose={() => setNewTask(null)}
          onSubmit={async (name) => {
            try {
              await window.gurt.createTask(newTask, name)
              setNewTask(null)
              selectTask(newTask, name)
            } catch (e) {
              void alertDialog(e instanceof Error ? e.message : String(e))
            }
          }}
        />
      )}
      {newWorkspace && (
        <NameModal
          title="New workspace"
          placeholder="workspace name"
          onClose={() => setNewWorkspace(false)}
          onSubmit={async (name) => {
            try {
              await window.gurt.createWorkspace(name)
              setNewWorkspace(false)
              setCurWs(name)
            } catch (e) {
              void alertDialog(e instanceof Error ? e.message : String(e))
            }
          }}
        />
      )}
      <DialogHost />
    </div>
  )
}
