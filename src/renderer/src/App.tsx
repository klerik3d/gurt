import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type {
  RepoChanges,
  SessionActivity,
  SessionInfo,
  SessionSnapshot,
  Tree
} from '../../shared/types'
import type { BootProgress } from '../../shared/api'
import { applyLog, sessionStatus } from '../../shared/types'
import type { NotificationRecord } from '../../shared/notifications'
import { NOTIFICATION_RING_CAP } from '../../shared/notifications'
import { SESSION_DOT, containerDot } from './status'
import { Icon, Logo } from './components/icons'
import { EnvRepoMarks } from './components/tags'
import { Sidebar, NameModal, DeleteWorkspaceModal } from './components/Sidebar'
import { SessionPane } from './components/SessionPane'
import { TaskPane } from './components/TaskPane'
import { SettingsPage, type SettingsSection } from './components/SettingsPage'
import { Dashboard } from './components/Dashboard'
import { CommandPalette } from './components/CommandPalette'
import { NotificationsPanel } from './components/NotificationsPanel'
import { useOutsideClose } from './hooks'
import { markSeen } from './reviewed'
import { DialogHost, alertDialog } from './dialog'
import { logErr } from './log'
import { run } from './async'
import { bindingLabel, bindingMatchesEvent } from '../../shared/hotkeys'
import { useHotkeys } from './useHotkeys'

export type Selection =
  | { type: 'session'; id: string }
  | { type: 'task'; ws: string; task: string }
  | null

export type View = 'work' | 'dashboard' | 'settings'

// Draggable sidebar width, persisted across launches.
const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 600
const SIDEBAR_DEFAULT = 284
const SIDEBAR_WIDTH_KEY = 'gurt.sidebarWidth'
// Distance from the window edge to the sidebar's left border: .workbench's
// 4px padding + the 44px activity bar + its 4px margin-right (styles.css).
const SIDEBAR_LEFT_OFFSET = 52

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
  /** Epoch ms of the turn each busy session is in — the dashboard's "N in this
   *  turn" readout. Only turns that started while this window was open are here;
   *  main does not persist turn starts, and inventing one would misreport. */
  const [turnStarts, setTurnStarts] = useState<Record<string, number>>({})
  const [paletteOpen, setPaletteOpen] = useState(false)
  const hotkeys = useHotkeys()
  /** Boot restore progress — the footer bar while main is still restoring
   *  sessions / reconciling containers. Null until first heard from; hidden
   *  once `done`. */
  const [boot, setBoot] = useState<BootProgress | null>(null)
  useEffect(() => {
    const off = window.gurt.onBootProgress((p) =>
      setBoot((prev) => (prev && prev.percent > p.percent ? prev : p))
    )
    // Pull the current value too — this window may have opened after some (or
    // all) of the pushes fired. Monotonic guard: a pushed update that beat this
    // reply is newer and must not be rolled back.
    window.gurt
      .getBootProgress()
      .then((p) => setBoot((prev) => (prev && prev.percent > p.percent ? prev : p)))
      .catch(logErr('getBootProgress'))
    return off
  }, [])
  const [notifications, setNotifications] = useState<NotificationRecord[]>([])
  /** Invalidates in-flight notification resyncs: a push (created/read) that
   *  lands while a `getNotifications` reply is in flight makes that reply
   *  stale — letting it land would revert the pushed record. */
  const notifSyncSeq = useRef(0)
  const syncNotifications = useCallback(() => {
    const seq = ++notifSyncSeq.current
    window.gurt
      .getNotifications()
      .then((list) => {
        if (seq === notifSyncSeq.current) setNotifications(list)
      })
      .catch(logErr('getNotifications'))
  }, [])
  const [notifOpen, setNotifOpen] = useState(false)
  const notifRef = useRef<HTMLDivElement>(null)
  useOutsideClose(notifOpen, notifRef, () => setNotifOpen(false))
  const [newTask, setNewTask] = useState<string | null>(null)
  const [newWorkspace, setNewWorkspace] = useState(false)
  const [deletingWorkspace, setDeletingWorkspace] = useState<string | null>(null)
  const [curWs, setCurWs] = useState<string | null>(null)
  /** Titlebar workspace-switcher dropdown — the single place to change `curWs`
   *  now, visible from every view (see the sidebar's now-static readout). */
  const [wsMenuOpen, setWsMenuOpen] = useState(false)
  const wsMenuRef = useRef<HTMLDivElement>(null)
  useOutsideClose(wsMenuOpen, wsMenuRef, () => setWsMenuOpen(false))
  /** ⌘`/⌘⇧` hold-to-switch: while the modifier stays down, cycling only moves
   *  this highlight (`order[index]`) and opens the same dropdown read-only —
   *  `curWs` itself only changes once the modifier is released (see
   *  `commitWsSwitch`), the same two-step gesture as macOS's own ⌘Tab. */
  const [wsSwitcher, setWsSwitcher] = useState<{ order: string[]; index: number } | null>(null)
  const wsSwitcherRef = useRef(wsSwitcher)
  wsSwitcherRef.current = wsSwitcher
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
    return saved ? clampSidebar(saved) : SIDEBAR_DEFAULT
  })
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const treeRef = useRef(tree)
  treeRef.current = tree
  /** Workspace names, most-recently-activated first — drives ⌘`/⌘⇧` cycling
   *  (see `cycleWorkspace`) instead of the tree's filesystem-readdir order. */
  const mruRef = useRef<string[]>([])
  /** Tasks whose changes were already requested at least once (app-start lazy load). */
  const changesRequested = useRef<Set<string>>(new Set())

  const refreshTree = useCallback(() => {
    window.gurt.getTree().then(setTree).catch(logErr('getTree'))
  }, [])

  /** `fetch` reaches the network — only the panel's own triggers pass it. */
  const refreshChanges = useCallback((ws: string, task: string, fetch = false) => {
    const key = `${ws}/${task}`
    changesRequested.current.add(key)
    window.gurt
      .getTaskChanges(ws, task, { fetch })
      .then((c) => setChanges((prev) => ({ ...prev, [key]: c })))
      .catch(logErr('getTaskChanges'))
  }, [])

  /** The task pane's own refresh trigger, bound to the current selection. Stable
   *  per selection: the pane refreshes when it opens or switches task, not on
   *  every render of this component. */
  const selWs = selection?.type === 'task' ? selection.ws : ''
  const selTask = selection?.type === 'task' ? selection.task : ''
  const refreshSelectionChanges = useCallback(
    () => refreshChanges(selWs, selTask, true),
    [refreshChanges, selWs, selTask]
  )

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
    const offTurn = window.gurt.onSessionTurn(({ sessionId, ref, phase }) => {
      setTurnStarts((prev) => {
        if (phase === 'started') return { ...prev, [sessionId]: Date.now() }
        if (!(sessionId in prev)) return prev
        const { [sessionId]: _gone, ...rest } = prev
        return rest
      })
      if (phase === 'ended') refreshChanges(ref.workspace, ref.task)
    })
    const offLog = window.gurt.onProvisionLog(({ key, line }) => {
      setLogs((prev) => ({ ...prev, [key]: [...(prev[key] ?? []).slice(-500), line] }))
    })
    const offNotif = window.gurt.onNotification((record) => {
      // A push supersedes any resync still in flight — its reply predates this
      // record and would clobber it.
      notifSyncSeq.current++
      // Same cap as main's ring (§6: in-memory, oldest dropped) — otherwise
      // this array outlives it and the two permanently disagree.
      setNotifications((prev) => [...prev, record].slice(-NOTIFICATION_RING_CAP))
    })
    // Main marking a session's notifications read server-side (its `awaiting`
    // cleared, or opened some other way) doesn't go through this window's own
    // markRead/markAllRead calls — mirror it so the badge doesn't go stale.
    const offNotifRead = window.gurt.onNotificationRead(({ sessionId }) => {
      notifSyncSeq.current++
      setNotifications((prev) =>
        prev.map((n) => (n.sessionId === sessionId && !n.read ? { ...n, read: true } : n))
      )
    })
    return () => {
      offTree()
      offSession()
      offSessionLog()
      offTurn()
      offLog()
      offNotif()
      offNotifRead()
    }
  }, [refreshTree, refreshChanges])

  useEffect(() => {
    syncNotifications()
  }, [syncNotifications])

  // Resync with main's ring whenever the popover opens — main's ring is
  // capped independently (§6) and read-state can also change without a push
  // reaching this window (e.g. another window's panel), so an open is a
  // convenient, cheap point to reconcile both without polling continuously.
  useEffect(() => {
    if (notifOpen) syncNotifications()
  }, [notifOpen, syncNotifications])

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

  // Track activation order for cycleWorkspace: every time curWs changes (via
  // any path — hotkey, titlebar dropdown, selectSession/selectTask jumping to
  // a workspace, new-workspace creation) it becomes the new MRU head. Deleted
  // workspaces are dropped whenever the tree changes so the list can't grow
  // unbounded across create/delete churn.
  useEffect(() => {
    if (curWs) mruRef.current = [curWs, ...mruRef.current.filter((n) => n !== curWs)]
  }, [curWs])
  useEffect(() => {
    if (!tree) return
    const names = new Set(tree.workspaces.map((w) => w.name))
    mruRef.current = mruRef.current.filter((n) => names.has(n))
  }, [tree])

  // The tree is the source of truth for what still exists. A task or session
  // that was deleted can no longer be selected — otherwise ⌘N/⌘⇧N and the
  // header actions keep silently targeting it, e.g. a new-session modal
  // pre-filled with a deleted task's name.
  //
  // Only what the tree has already shown is pruned: creating a task or session
  // selects it right after the IPC returns, one tree refresh *before* it shows
  // up in `tree` — pruning on absence alone would wipe every fresh selection.
  const treeKnown = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!tree) return
    const alive = new Set<string>()
    for (const w of tree.workspaces)
      for (const t of w.tasks) {
        alive.add(`task:${w.name}/${t.name}`)
        for (const s of t.sessions) alive.add(`session:${s.id}`)
      }
    const key = selection
      ? selection.type === 'session'
        ? `session:${selection.id}`
        : `task:${selection.ws}/${selection.task}`
      : null
    if (key && treeKnown.current.has(key) && !alive.has(key)) setSelection(null)
    treeKnown.current = alive
  }, [tree, selection])

  // Drag the divider between sidebar and main; the new width is clientX
  // minus the sidebar's left offset (see SIDEBAR_LEFT_OFFSET).
  const startSidebarResize = useCallback((e: ReactMouseEvent) => {
    e.preventDefault()
    const onMove = (ev: MouseEvent) =>
      setSidebarWidth(clampSidebar(ev.clientX - SIDEBAR_LEFT_OFFSET))
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('blur', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    // A mouseup this window never sees (released over devtools, a native menu,
    // another window) would leave the drag armed forever — losing focus is the
    // reliable signal that the drag is over.
    window.addEventListener('blur', onUp)
  }, [])

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
  }, [sidebarWidth])

  const selectSession = useCallback((id: string) => {
    setView('work')
    setSelection({ type: 'session', id })
    // Opening a session is what "reviewed" means on the dashboard — the same
    // act that clears its notifications (§4.2) clears it from the review list.
    markSeen(id)
    // Keep curWs in step with whatever workspace actually owns this session —
    // otherwise a cross-workspace jump (e.g. via the palette) leaves curWs
    // pointing at the old workspace, and the next ⌘N/⌘⇧N silently targets it.
    const owner = treeRef.current?.workspaces.find((w) =>
      w.tasks.some((t) => t.sessions.some((s) => s.id === id))
    )
    if (owner) setCurWs(owner.name)
    // The IPC call marks this session's pending notifications read server-side
    // (§4.2 — opening a session another way, not just a panel click); mirror
    // that locally so the bell badge updates without waiting on a push event.
    setNotifications((prev) =>
      prev.map((n) => (n.sessionId === id && !n.read ? { ...n, read: true } : n))
    )
    window.gurt
      .sessionSnapshot(id)
      .then((snap) => {
        if (snap) setSnapshots((prev) => ({ ...prev, [id]: snap }))
      })
      .catch(logErr('sessionSnapshot'))
  }, [])

  const selectTask = useCallback((tws: string, task: string) => {
    setView('work')
    setSelection({ type: 'task', ws: tws, task })
    setCurWs(tws)
  }, [])

  const markNotificationRead = useCallback((id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)))
    window.gurt.markNotificationRead(id).catch(logErr('markNotificationRead'))
  }, [])

  const markAllNotificationsRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => (n.read ? n : { ...n, read: true })))
    window.gurt.markAllRead().catch(logErr('markAllRead'))
  }, [])

  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id))
    window.gurt.dismissNotification(id).catch(logErr('dismissNotification'))
  }, [])

  // A new session is a bare draft from the moment it exists — nothing to pick
  // up front, no modal round-trip. Its env/repo/agent/harness get filled in on
  // the draft's own Config tab; only its task is decided here, since a session
  // cannot exist outside one (the IPC boundary requires it, ipc.ts).
  const createDraft = useCallback(
    (wsName: string, task: string) => {
      window.gurt
        .createSession(
          { workspace: wsName, task, env: '' },
          [],
          '',
          '',
          'draft',
          [],
          true,
          {},
          'executor',
          // Nothing picked yet, not "none picked": the config tab seeds the
          // workspace's `defaultSkills` into a draft that has never chosen
          // (docs/requirements-skills.md §4.2).
          [],
          { internal: false }
        )
        .then((s) => selectSession(s.id))
        .catch((e: unknown) => alertDialog(e instanceof Error ? e.message : String(e)))
    },
    [selectSession]
  )

  const openNewSession = useCallback(
    (ctx?: { ws: string; task: string }) => {
      if (ctx) {
        createDraft(ctx.ws, ctx.task)
        return
      }
      if (!ws) return
      // No explicit context (⌘N, palette) — prefill the task the user is looking at.
      const sel = selectionRef.current
      let task = ''
      if (sel?.type === 'task' && sel.ws === ws.name) task = sel.task
      else if (sel?.type === 'session')
        task = ws.tasks.find((t) => t.sessions.some((s) => s.id === sel.id))?.name ?? ''
      // The selection can lag the tree (a task deleted while selected). Never
      // target a task that no longer exists — the session would be created
      // inside a task that isn't there.
      if (task && !ws.tasks.some((t) => t.name === task)) task = ''
      // Still nothing — fall back to the workspace's first task.
      if (!task) task = ws.tasks[0]?.name ?? ''
      // No tasks at all: a session cannot exist outside one, so send the user
      // through the ordinary "new task" flow first instead of failing silently.
      if (!task) {
        setNewTask(ws.name)
        return
      }
      createDraft(ws.name, task)
    },
    [ws, createDraft]
  )

  // Shared with the ⌘`/⌘⇧` IPC path below — macOS reclaims that combination
  // as a hidden menu accelerator (main/menu.ts) since the OS reserves it
  // system-wide for window cycling and never delivers it as a DOM keydown, so
  // this needs to be callable from outside the keydown handler too.
  //
  // Each call only moves the highlight — a held modifier means repeated
  // presses (each its own call: real key-repeat off macOS, one accelerator
  // fire per press on macOS) just walk it further. The first call in a
  // fresh gesture opens the switcher from `ws`'s position; later calls
  // advance whatever it's already showing. `commitWsSwitch` (below) is what
  // actually changes `curWs`, once the modifier lifts.
  const cycleWorkspace = useCallback(
    (dir: 1 | -1) => {
      const wsList = treeRef.current?.workspaces ?? []
      if (wsList.length < 2) return
      const cur = wsSwitcherRef.current
      if (cur) {
        setWsSwitcher({ order: cur.order, index: (cur.index + dir + cur.order.length) % cur.order.length })
        return
      }
      // Cycle by activation recency (mruRef), not tree/readdir order — a
      // workspace never yet activated this session falls back to its tree
      // position, appended after everything with a known MRU rank.
      const order = [
        ...mruRef.current.filter((n) => wsList.some((w) => w.name === n)),
        ...wsList.map((w) => w.name).filter((n) => !mruRef.current.includes(n))
      ]
      const idx = order.indexOf(ws?.name ?? '')
      setWsSwitcher({ order, index: (idx + dir + order.length) % order.length })
    },
    [ws]
  )

  // Applies the switcher's current highlight to `curWs` and closes it — the
  // ⌘/Ctrl-up half of the gesture `cycleWorkspace` starts. Also fired on
  // window blur so a focus change mid-hold (a native dialog, another app)
  // can't strand the switcher open with a keyup that'll never arrive.
  const commitWsSwitch = useCallback(() => {
    const cur = wsSwitcherRef.current
    setWsSwitcher(null)
    if (!cur) return
    const target = cur.order[cur.index]
    if (!target || target === ws?.name) return
    // Same rule as the titlebar dropdown: leaving a workspace clears whatever
    // session/task was open so the sidebar/breadcrumb don't show stale content.
    setSelection(null)
    setCurWs(target)
  }, [ws])

  useEffect(() => {
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Meta' || e.key === 'Control') commitWsSwitch()
    }
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', commitWsSwitch)
    return () => {
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', commitWsSwitch)
    }
  }, [commitWsSwitch])

  // macOS never lets ⌘`/⌘⇧` reach here as a keydown (see `cycleWorkspace`
  // above) — main forwards it over IPC instead once its hidden accelerator
  // fires. Harmless no-op on other platforms, which just never emit it.
  useEffect(() => window.gurt.onHotkeyCycleWorkspace(cycleWorkspace), [cycleWorkspace])

  // Global hotkeys: palette · new session · new task · cycle workspaces
  // (default ⌘K / ⌘N / ⌘⇧N / ⌘` / ⌘⇧`, remappable in Settings → Hotkeys).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (bindingMatchesEvent(hotkeys.workspaceNext, e)) {
        e.preventDefault()
        cycleWorkspace(1)
      } else if (bindingMatchesEvent(hotkeys.workspacePrev, e)) {
        e.preventDefault()
        cycleWorkspace(-1)
      } else if (bindingMatchesEvent(hotkeys.palette, e)) {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      } else if (bindingMatchesEvent(hotkeys.newTask, e)) {
        e.preventDefault()
        if (ws) setNewTask(ws.name)
      } else if (bindingMatchesEvent(hotkeys.newSession, e)) {
        e.preventDefault()
        openNewSession()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ws, openNewSession, hotkeys, cycleWorkspace])

  const positions = queuePositions(tree)
  // The dropdown reads from whichever is driving it: the switcher's MRU
  // order while a ⌘/Ctrl hold is in progress (so it shows the same reel
  // `cycleWorkspace` is walking, in that order), the plain tree otherwise.
  const wsMenuList = wsSwitcher
    ? wsSwitcher.order
        .map((n) => tree?.workspaces.find((w) => w.name === n))
        .filter((w): w is NonNullable<typeof w> => !!w)
    : (tree?.workspaces ?? [])
  const wsMenuActiveName = wsSwitcher ? wsSwitcher.order[wsSwitcher.index] : ws?.name
  const unreadCount = notifications.reduce((n, r) => n + (r.read ? 0 : 1), 0)
  const unreadBadge = unreadCount > 9 ? '9+' : String(unreadCount)

  // The tree only refetches on `tree-changed`, which doesn't fire on busy /
  // permission transitions. Overlay the freshest runtime flags from snapshots
  // (pushed on every session change) so the sidebar's run/wait/idle marks stay live.
  const activity: Record<string, SessionActivity> = {}
  for (const [id, snap] of Object.entries(snapshots))
    activity[id] = { busy: snap.info.busy, awaitingInput: snap.info.awaitingInput }

  const activeSnap = selection?.type === 'session' ? snapshots[selection.id] : undefined
  const activeInfo = activeSnap?.info
  // The container is the session's own — no lookup through the task any more.
  const activeContainer = activeInfo?.container

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

  // The workspace name itself is now the interactive `.tb-ws` button — this is
  // only the rest of the breadcrumb, shown as plain text after it. Dropping
  // `activeInfo.workspace` / `selection.ws` here is safe: selectSession/
  // selectTask already keep curWs in step with whatever's open (see the note
  // in selectSession about cross-workspace jumps), so the button's label is
  // always in sync.
  const crumbRest =
    view === 'settings'
      ? 'settings'
      : view === 'dashboard'
        ? 'dashboard'
        : activeInfo
          ? `${activeInfo.task} · ${activeInfo.title}`
          : selection?.type === 'task'
            ? selection.task
            : null

  const crumbDot = view === 'work' && activeStatus ? SESSION_DOT[activeStatus] : null

  return (
    <div className="app">
      <div className="titlebar">
        <div className="tb-center">
          <div className="tb-crumb">
            <div className="tb-ws" ref={wsMenuRef}>
              <button className="tb-ws-btn" onClick={() => setWsMenuOpen((o) => !o)}>
                {ws?.name ?? 'gurt'}
                <Icon name="chevron" size={12} className="faint" />
              </button>
              {(wsMenuOpen || wsSwitcher) && (
                <div className="menu tb-ws-menu">
                  {wsMenuList.map((w) => (
                    <div
                      key={w.name}
                      className={`menu-item ${w.name === wsMenuActiveName ? 'active' : ''}`}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        setWsMenuOpen(false)
                        setWsSwitcher(null)
                        // An explicit workspace switch closes whatever session/task is
                        // open — it belongs to the workspace being left, and leaving it
                        // selected would show stale content the sidebar no longer scopes
                        // to, and a breadcrumb that no longer matches the sidebar tree.
                        if (w.name !== ws?.name) setSelection(null)
                        setCurWs(w.name)
                      }}
                    >
                      <span style={{ flex: 1 }}>{w.name}</span>
                      <button
                        className="icon-sq sb-act"
                        title="delete workspace"
                        onMouseDown={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setWsMenuOpen(false)
                          setWsSwitcher(null)
                          setDeletingWorkspace(w.name)
                        }}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </div>
                  ))}
                  <div className="menu-sep" />
                  <div
                    className="menu-item"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      setWsMenuOpen(false)
                      setWsSwitcher(null)
                      setNewWorkspace(true)
                    }}
                  >
                    + new workspace
                  </div>
                </div>
              )}
            </div>
            {crumbRest && (
              <>
                <span className="tb-crumb-sep">/</span>
                {crumbDot && (
                  <span
                    className={`dot dot-${crumbDot.tone}${crumbDot.pulse ? ' dot-pulse' : ''}`}
                    title={crumbDot.label}
                    style={{ width: 7, height: 7 }}
                  />
                )}
                <span className="tb-crumb-rest">{crumbRest}</span>
              </>
            )}
          </div>
        </div>
        <div className="tb-icons">
          <button
            className="icon-sq tb-btn"
            title={`Search · ${bindingLabel(hotkeys.palette)}`}
            onClick={() => setPaletteOpen(true)}
          >
            <Icon name="search" size={16} />
          </button>
          <div className="notif-wrap" ref={notifRef}>
            <button
              className={`icon-sq tb-btn ${notifOpen ? 'active' : ''}`}
              title="Notifications"
              onClick={() => setNotifOpen((o) => !o)}
            >
              <Icon name="bell" size={16} />
              {unreadCount > 0 && <span className="notif-badge">{unreadBadge}</span>}
            </button>
            {notifOpen && (
              <NotificationsPanel
                notifications={notifications}
                tree={tree}
                onClose={() => setNotifOpen(false)}
                onSelectSession={selectSession}
                onMarkRead={markNotificationRead}
                onMarkAllRead={markAllNotificationsRead}
                onDismiss={dismissNotification}
              />
            )}
          </div>
        </div>
      </div>

      <div className="workbench">
        <div className="activitybar">
          <button
            className={`ab-item ${view === 'dashboard' ? 'active' : ''}`}
            title="Dashboard"
            onClick={() => setView('dashboard')}
          >
            <Icon name="grid" size={17} />
          </button>
          <button
            className={`ab-item ${view === 'work' ? 'active' : ''}`}
            title="Tasks & sessions"
            onClick={() => setView('work')}
          >
            <Icon name="message" size={17} />
          </button>
          <span className="spacer" />
          <button
            className={`ab-item ${view === 'settings' ? 'active' : ''}`}
            title="Settings"
            onClick={() => setView('settings')}
          >
            <Icon name="gear" size={17} />
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
              onNewSession={(w, t) => createDraft(w, t)}
              onSelectTask={selectTask}
              onSelectSession={selectSession}
            />
            <div className="sidebar-resizer" onMouseDown={startSidebarResize} />
            <main className="main">
              {selection?.type === 'session' && (
                <SessionPane
                  tree={tree}
                  snapshot={snapshots[selection.id]}
                  sessionId={selection.id}
                  queuePosition={positions[selection.id]}
                  log={logs[selection.id] ?? []}
                  onSelect={selectSession}
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
                  onRefreshChanges={refreshSelectionChanges}
                  onSelectSession={selectSession}
                />
              )}
              {!selection && (
                <div className="placeholder">
                  <div className="placeholder-logo">
                    <Logo size={240} />
                  </div>
                  <div className="placeholder-text">
                    select a session on the left, or press{' '}
                    <span className="kbd">{bindingLabel(hotkeys.palette)}</span> to get started
                  </div>
                </div>
              )}
            </main>
          </>
        )}

        {view === 'dashboard' && (
          <main className="main">
            <Dashboard
              tree={tree}
              activity={activity}
              changes={changes}
              positions={positions}
              turnStarts={turnStarts}
              onSelectSession={selectSession}
              onSelectTask={selectTask}
            />
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
            <span
              className={`dot ${runningCount > 0 ? 'dot-green dot-pulse' : 'dot-yellow'}`}
              style={{ width: 6, height: 6 }}
            />
          )}
          {runningCount} running · {needYouCount} need you
        </span>
        {boot && !boot.done && (
          <span className="foot-boot">
            <span className="foot-boot-track">
              <span className="foot-boot-fill" style={{ width: `${boot.percent}%` }} />
            </span>
            starting up · {boot.label} · {boot.percent}%
          </span>
        )}
        <span className="spacer" />
        {activeInfo && activeContainer && (
          <>
            <span className="foot-env">
              <EnvRepoMarks env={activeInfo.env} repos={activeInfo.repos} task={activeInfo.task} />
              <span>{containerDot(activeContainer.status).label}</span>
            </span>
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
      {newTask && (
        <NameModal
          title={`New task in ${newTask}`}
          placeholder="task name"
          onClose={() => setNewTask(null)}
          onSubmit={run(async (name) => {
            try {
              await window.gurt.createTask(newTask, name)
              setNewTask(null)
              selectTask(newTask, name)
            } catch (e) {
              void alertDialog(e instanceof Error ? e.message : String(e))
            }
          })}
        />
      )}
      {newWorkspace && (
        <NameModal
          title="New workspace"
          placeholder="workspace name"
          onClose={() => setNewWorkspace(false)}
          onSubmit={run(async (name) => {
            try {
              await window.gurt.createWorkspace(name)
              setNewWorkspace(false)
              setCurWs(name)
            } catch (e) {
              void alertDialog(e instanceof Error ? e.message : String(e))
            }
          })}
        />
      )}
      {deletingWorkspace && (
        <DeleteWorkspaceModal
          ws={deletingWorkspace}
          onClose={() => setDeletingWorkspace(null)}
          onDeleted={() => setDeletingWorkspace(null)}
        />
      )}
      <DialogHost />
    </div>
  )
}
