import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import type {
  AgentConfig,
  AgentsFile,
  McpMode,
  McpSelection,
  RepoChanges,
  SessionConfigOption,
  SessionInfo,
  Tree
} from '../../../shared/types'
import { isActionable, isDelivered, sessionStatus } from '../../../shared/types'
import type { CredentialEntry } from '../../../shared/credentials'
import { hasManagedCredential, resolveForRepo } from '../../../shared/credentials'
import type { McpDef } from '../../../shared/mcp'
import type { Selection } from '../App'
import { agentKind, agentName, useAgents } from '../useAgents'
import { useOutsideClose } from '../hooks'
import { alertDialog, confirmDialog } from '../dialog'
import { SESSION_DOT } from '../status'
import { Icon, Dot } from './icons'
import { AgentMark, agentIcon } from './tags'
import { Modal } from './Modal'

/** One visible line of the tree — the unit arrow-key navigation moves over. */
type Row =
  | { kind: 'task'; ws: string; task: string }
  | { kind: 'session'; id: string; ws: string; task: string }

const rowKey = (r: Row) => (r.kind === 'task' ? `t:${r.ws}/${r.task}` : `s:${r.id}`)

export function Sidebar({
  width,
  tree,
  ws,
  selection,
  changes,
  activity,
  onPickWorkspace,
  onNewWorkspace,
  onNewSession,
  onSelectTask,
  onSelectSession,
  onOpenPalette
}: {
  /** Current sidebar width in px (user-draggable). */
  width: number
  tree: Tree | null
  /** Name of the workspace currently shown; null while the tree loads. */
  ws: string | null
  selection: Selection
  /** Per-task git changes keyed `ws/task` — drives the actionable badge. */
  changes: Record<string, RepoChanges[]>
  /** Live runtime overlay per session id — splits `started` into running/waiting/idle. */
  activity: Record<string, { busy?: boolean; awaitingInput?: boolean }>
  onPickWorkspace: (ws: string) => void
  onNewWorkspace: () => void
  onNewSession: (ws: string, task: string) => void
  onSelectTask: (ws: string, task: string) => void
  onSelectSession: (id: string) => void
  onOpenPalette: () => void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [wsMenuOpen, setWsMenuOpen] = useState(false)
  const wsMenuRef = useRef<HTMLDivElement>(null)
  const [creatingTask, setCreatingTask] = useState(false)
  const [taskDraftName, setTaskDraftName] = useState('')
  const taskPopRef = useRef<HTMLDivElement>(null)
  useOutsideClose(creatingTask, taskPopRef, () => {
    setCreatingTask(false)
    setTaskDraftName('')
  })
  const agents = useAgents()
  /** The row whose name is currently swapped for a text field, if any. */
  const [renaming, setRenaming] = useState<Row | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  /** Guards the edit against resolving twice: both Escape and a keyboard commit
   *  move focus off the input, and the blur that follows would otherwise run the
   *  commit a second time — against a name that no longer exists. */
  const renameSettled = useRef(false)
  const treeRef = useRef<HTMLDivElement>(null)
  const selectedRef = useRef<HTMLDivElement>(null)

  const wsData = tree?.workspaces.find((w) => w.name === ws)

  useEffect(() => {
    if (!wsMenuOpen) return
    const onDown = (e: MouseEvent) => {
      if (wsMenuRef.current && !wsMenuRef.current.contains(e.target as Node)) setWsMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setWsMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [wsMenuOpen])

  // Keyboard navigation can walk the selection out of view — follow it.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selection])

  const setCollapse = (ws2: string, task: string, on: boolean) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      on ? next.add(`${ws2}/${task}`) : next.delete(`${ws2}/${task}`)
      return next
    })
    // Collapsing hides the selected session — move the selection up to the task
    // so it stays visible and arrow navigation keeps its place.
    if (on && selection?.type === 'session') {
      const owner = wsData?.tasks.find((t) => t.sessions.some((s) => s.id === selection.id))
      if (owner?.name === task) onSelectTask(ws2, task)
    }
  }

  const deleteTask = async (taskName: string) => {
    if (!ws) return
    const dirty = await window.gurt.taskDirtyRepos(ws, taskName).catch(() => [])
    const warning = dirty.length
      ? `Task "${taskName}" has uncommitted changes in: ${dirty.join(', ')}. Delete anyway and permanently lose them, along with all environments and sessions?`
      : `Delete task "${taskName}" with all its environments, clones and sessions?`
    if (await confirmDialog(warning, { title: 'Delete task', confirmText: 'Delete', danger: true }))
      window.gurt.removeTask(ws, taskName).catch((e) => alertDialog(String(e)))
  }

  /** Resolves true once the delete has been confirmed and sent. */
  const deleteSession = async (id: string): Promise<boolean> => {
    const s = wsData?.tasks.flatMap((t) => t.sessions).find((x) => x.id === id)
    if (!s) return false
    // A session owns its container, so deleting it takes the container down —
    // say so, and say what survives: the clone and whatever is uncommitted in it.
    const warning =
      s.container && s.container.status !== 'stopped'
        ? `Delete session "${s.title}"? Its container goes down with it; the clone and any uncommitted changes stay.`
        : `Delete session "${s.title}"?`
    if (
      !(await confirmDialog(warning, {
        title: 'Delete session',
        confirmText: 'Delete',
        danger: true
      }))
    )
      return false
    window.gurt.sessionDelete(id).catch((e) => alertDialog(String(e)))
    return true
  }

  // Creates the task right from the header "+", no modal round-trip — click,
  // type, Enter. Selects it immediately so the flow lands somewhere useful.
  const submitNewTask = async () => {
    const name = taskDraftName.trim()
    if (!name || !ws) return
    setCreatingTask(false)
    setTaskDraftName('')
    try {
      await window.gurt.createTask(ws, name)
      onSelectTask(ws, name)
    } catch (e) {
      await alertDialog(e instanceof Error ? e.message : String(e))
    }
  }

  // The tree as the user sees it, top to bottom — collapsed tasks contribute
  // only their own row. Arrow keys walk this list; nothing else needs the shape.
  const rows: Row[] = []
  for (const task of wsData?.tasks ?? []) {
    rows.push({ kind: 'task', ws: wsData!.name, task: task.name })
    if (!collapsed.has(`${wsData!.name}/${task.name}`))
      for (const s of task.sessions)
        rows.push({ kind: 'session', id: s.id, ws: wsData!.name, task: task.name })
  }
  const isSelected = (r: Row) =>
    r.kind === 'task'
      ? selection?.type === 'task' && selection.ws === r.ws && selection.task === r.task
      : selection?.type === 'session' && selection.id === r.id
  const cursor = rows.findIndex(isSelected)
  const selectRow = (r: Row) =>
    r.kind === 'task' ? onSelectTask(r.ws, r.task) : onSelectSession(r.id)

  const startRename = (r: Row) => {
    renameSettled.current = false
    setRenameDraft(
      r.kind === 'task'
        ? r.task
        : (wsData?.tasks.flatMap((t) => t.sessions).find((s) => s.id === r.id)?.title ?? '')
    )
    setRenaming(r)
  }

  /** `refocus` distinguishes committing with Enter — where the caret should fall
   *  back to the tree so navigation continues — from committing by clicking
   *  away, where focus has already gone somewhere the user chose. */
  const commitRename = async (refocus: boolean) => {
    if (renameSettled.current) return
    renameSettled.current = true
    const r = renaming
    const name = renameDraft.trim()
    setRenaming(null)
    if (refocus) treeRef.current?.focus()
    if (!r || !name) return
    try {
      if (r.kind === 'task') {
        if (name === r.task) return
        // The rename moves the task directory, so any container bind-mounted on
        // it has to come down first — say so before doing it behind their back.
        const live = (wsData?.tasks.find((t) => t.name === r.task)?.sessions ?? []).filter(
          (s) => s.container && s.container.status !== 'stopped'
        )
        if (
          live.length &&
          !(await confirmDialog(
            `Renaming "${r.task}" stops the container(s) of: ${live.map((s) => s.title).join(', ')}. Continue?`,
            { title: 'Rename task', confirmText: 'Rename' }
          ))
        )
          return
        await window.gurt.renameTask(r.ws, r.task, name)
        // The selection holds the old name — re-point it at the renamed task.
        if (selection?.type === 'task' && selection.ws === r.ws && selection.task === r.task)
          onSelectTask(r.ws, name)
      } else {
        await window.gurt.renameSession(r.id, name)
      }
    } catch (e) {
      await alertDialog(e instanceof Error ? e.message : String(e))
    }
  }

  const cancelRename = () => {
    renameSettled.current = true
    setRenaming(null)
    treeRef.current?.focus()
  }

  const onTreeKey = (e: ReactKeyboardEvent) => {
    if (renaming || !rows.length) return
    const cur = rows[cursor]
    const collapsedNow = cur?.kind === 'task' && collapsed.has(`${cur.ws}/${cur.task}`)
    switch (e.key) {
      case 'ArrowDown':
        selectRow(rows[Math.min(cursor + 1, rows.length - 1)])
        break
      case 'ArrowUp':
        selectRow(rows[Math.max(cursor - 1, 0)])
        break
      case 'ArrowRight':
        if (!cur) return
        // Expand first; on an already-expanded task, step into its sessions.
        if (cur.kind !== 'task') return
        if (collapsedNow) setCollapse(cur.ws, cur.task, false)
        else if (rows[cursor + 1]?.kind === 'session') selectRow(rows[cursor + 1])
        break
      case 'ArrowLeft':
        if (!cur) return
        // Mirror of Right: out of the sessions to the task, then collapse it.
        if (cur.kind === 'session') onSelectTask(cur.ws, cur.task)
        else if (!collapsedNow) setCollapse(cur.ws, cur.task, true)
        break
      case 'Enter':
      case 'F2':
        if (cur) startRename(cur)
        break
      // Both keys: ⌦ where the keyboard has one, ⌫ where Delete *is* backspace.
      // Neither acts on its own — the confirmation is the whole safety net.
      case 'Delete':
      case 'Backspace': {
        if (!cur) return
        // The dialog takes the caret and never hands it back — the tree needs it
        // to go on navigating, whichever way the answer went.
        if (cur.kind === 'task') {
          deleteTask(cur.task).then(() => treeRef.current?.focus())
          break
        }
        // A selection left on the deleted session would sit on an empty pane, so
        // step off it — but only once the delete is actually going through, or a
        // cancelled dialog would still have moved the cursor. Either neighbour
        // outlives this session: a sibling, or the task row that must be above it.
        const next = rows[cursor + 1] ?? rows[cursor - 1]
        deleteSession(cur.id).then((deleted) => {
          if (deleted && next) selectRow(next)
          treeRef.current?.focus()
        })
        break
      }
      default:
        return
    }
    e.preventDefault()
  }

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sb-head">
        <div className="sb-ws" ref={wsMenuRef}>
          <button className="sb-ws-btn" onClick={() => setWsMenuOpen((o) => !o)}>
            <span className="sb-ws-name">{ws ?? 'gurt'}</span>
            <Icon name="chevron" size={13} className="faint" />
          </button>
          {wsMenuOpen && (
            <div className="menu sb-ws-menu">
              {tree?.workspaces.map((w) => (
                <div
                  key={w.name}
                  className={`menu-item ${w.name === ws ? 'active' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    setWsMenuOpen(false)
                    onPickWorkspace(w.name)
                  }}
                >
                  {w.name}
                </div>
              ))}
              <div className="menu-sep" />
              <div
                className="menu-item"
                onMouseDown={(e) => {
                  e.preventDefault()
                  setWsMenuOpen(false)
                  onNewWorkspace()
                }}
              >
                + new workspace
              </div>
            </div>
          )}
        </div>
        <span className="spacer" />
        <button className="icon-sq" title="Search · ⌘K" onClick={onOpenPalette}>
          <Icon name="search" size={14} />
        </button>
        <div className="sb-newtask" ref={taskPopRef}>
          <button
            className="icon-sq"
            title="New task · ⌘⇧N"
            onClick={() => setCreatingTask((o) => !o)}
          >
            <Icon name="plus" size={14} />
          </button>
          {creatingTask && (
            <div className="menu sb-newtask-menu">
              <div className="menu-item-input">
                <input
                  autoFocus
                  className="input"
                  placeholder="task name"
                  value={taskDraftName}
                  onChange={(e) => setTaskDraftName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submitNewTask()}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="sb-tree" ref={treeRef} tabIndex={0} role="tree" onKeyDown={onTreeKey}>
        {wsData?.tasks.map((task) => {
          const tkey = `${wsData.name}/${task.name}`
          const isCollapsed = collapsed.has(tkey)
          const row: Row = { kind: 'task', ws: wsData.name, task: task.name }
          const taskSelected = isSelected(row)
          const editing = renaming && rowKey(renaming) === rowKey(row)
          return (
            <div key={task.name} className="sb-group">
              <div
                className={`sb-task ${taskSelected ? 'selected' : ''}`}
                ref={taskSelected ? selectedRef : undefined}
                role="treeitem"
                aria-expanded={!isCollapsed}
                aria-selected={taskSelected}
                onClick={() => onSelectTask(wsData.name, task.name)}
                onDoubleClick={() => startRename(row)}
              >
                <span
                  className="sb-chev"
                  onClick={(e) => {
                    e.stopPropagation()
                    setCollapse(wsData.name, task.name, !isCollapsed)
                  }}
                >
                  <Icon
                    name="chevron"
                    size={11}
                    style={isCollapsed ? { transform: 'rotate(-90deg)' } : undefined}
                  />
                </span>
                {editing ? (
                  <RenameInput
                    value={renameDraft}
                    onChange={setRenameDraft}
                    onCommit={commitRename}
                    onCancel={cancelRename}
                  />
                ) : (
                  <>
                    <span className="sb-task-name">{task.name}</span>
                    <TaskBadge repos={changes[tkey] ?? []} />
                    <span className="spacer" />
                    <button
                      className="icon-sq sb-act"
                      title="new session"
                      onClick={(e) => {
                        e.stopPropagation()
                        onNewSession(wsData.name, task.name)
                      }}
                    >
                      <Icon name="message" size={13} />
                    </button>
                    <button
                      className="icon-sq sb-act"
                      title="delete task"
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteTask(task.name)
                      }}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </>
                )}
              </div>
              {!isCollapsed &&
                task.sessions.map((s) => {
                  const status = sessionStatus({ ...s, ...activity[s.id] })
                  const dot = SESSION_DOT[status]
                  const srow: Row = { kind: 'session', id: s.id, ws: wsData.name, task: task.name }
                  const selected = isSelected(srow)
                  const renamingThis = renaming && rowKey(renaming) === rowKey(srow)
                  return (
                    <div
                      key={s.id}
                      className={`sb-session ${selected ? 'selected' : ''}`}
                      ref={selected ? selectedRef : undefined}
                      role="treeitem"
                      aria-selected={selected}
                      title={dot.label}
                      onClick={() => onSelectSession(s.id)}
                      onDoubleClick={() => startRename(srow)}
                    >
                      <Dot tone={dot.tone} pulse={dot.pulse} />
                      {renamingThis ? (
                        <RenameInput
                          value={renameDraft}
                          onChange={setRenameDraft}
                          onCommit={commitRename}
                          onCancel={cancelRename}
                        />
                      ) : (
                        <>
                          <span className="sb-session-name">{s.title}</span>
                          <span className="sb-session-client">
                            {s.agent && (
                              <AgentMark kind={agentKind(agents, s.agent)} name={agentName(agents, s.agent)} />
                            )}
                          </span>
                        </>
                      )}
                    </div>
                  )
                })}
              {!isCollapsed && task.sessions.length === 0 && (
                <div className="sb-empty">no sessions — “+” to add one</div>
              )}
            </div>
          )
        })}
        {wsData && wsData.tasks.length === 0 && (
          <div className="sb-empty" style={{ paddingLeft: 18 }}>
            no tasks yet — “+” above to add one
          </div>
        )}
        {tree && tree.workspaces.length === 0 && (
          <div className="sb-empty" style={{ paddingLeft: 18 }}>
            no workspaces yet — create one via the workspace menu
          </div>
        )}
      </div>
    </aside>
  )
}

/** Inline name editor for a tree row: commits on Enter or blur, drops on Escape.
 *  Its keys stop at the input so the tree's own arrow/Enter handling stays out. */
function RenameInput({
  value,
  onChange,
  onCommit,
  onCancel
}: {
  value: string
  onChange: (v: string) => void
  onCommit: (refocus: boolean) => void
  onCancel: () => void
}) {
  return (
    <input
      autoFocus
      className="sb-rename"
      value={value}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={() => onCommit(false)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') onCommit(true)
        else if (e.key === 'Escape') onCancel()
      }}
    />
  )
}

/** Delivery state of the task's clones: work to do, work awaiting merge, or nothing. */
function TaskBadge({ repos }: { repos: RepoChanges[] }) {
  if (repos.some(isActionable))
    return <span className="task-badge" title="uncommitted or unpushed changes" />
  if (repos.some(isDelivered))
    return <span className="task-badge badge-delivered" title="delivered — awaiting merge" />
  return null
}

export function NameModal({
  title,
  placeholder,
  onClose,
  onSubmit
}: {
  title: string
  placeholder?: string
  onClose: () => void
  onSubmit: (name: string) => void
}) {
  const [name, setName] = useState('')
  return (
    <Modal title={title} onClose={onClose}>
      <div className="modal-body">
        <input
          autoFocus
          className="input"
          placeholder={placeholder ?? 'name'}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && name.trim() && onSubmit(name.trim())}
        />
      </div>
      <div className="modal-foot">
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!name.trim()} onClick={() => onSubmit(name.trim())}>
          Create
        </button>
      </div>
    </Modal>
  )
}

// ---- New session modal (#2a) with inline Harness config (#2b) ----

/** Quiet select row: a field-styled button that opens a menu of options. */
function PickRow({
  open,
  onToggle,
  onClose,
  menu,
  children
}: {
  open: boolean
  onToggle: () => void
  onClose: () => void
  menu: ReactNode
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(open, ref, onClose)
  return (
    <div className="pick-wrap" ref={ref}>
      <button type="button" className="pick-row" onClick={onToggle}>
        {children}
        <Icon name="chevron" size={13} className="faint" style={{ flex: 'none' }} />
      </button>
      {open && <div className="menu pick-menu">{menu}</div>}
    </div>
  )
}

export function NewSessionModal({
  tree,
  ws,
  task,
  edit,
  onClose,
  onCreated
}: {
  tree: Tree
  ws: string
  /** Preselected task name; empty string → the modal's task picker chooses. */
  task: string
  /** When present, edit this existing draft's settings instead of creating one. */
  edit?: SessionInfo
  onClose: () => void
  onCreated: (s: SessionInfo) => void
}) {
  const editing = !!edit
  const [agents, setAgents] = useState<AgentsFile | null>(null)
  const [agent, setAgent] = useState(edit?.agent ?? '')
  const [taskName, setTaskName] = useState(edit?.task ?? task)
  /** The env definition this session runs on. */
  const [env, setEnv] = useState(edit?.env ?? '')
  /** The session's repo (null = none). Seeded from the picked env's default. */
  const [repo, setRepo] = useState<string | null>(edit?.repo ?? null)
  const [prompt, setPrompt] = useState(edit?.startPrompt ?? '')
  const [mcpDefs, setMcpDefs] = useState<McpDef[]>([])
  /** MCP id -> granted mode; absent = not attached. */
  const [mcp, setMcp] = useState<Record<string, McpMode>>(
    Object.fromEntries((edit?.mcp ?? []).map((m) => [m.id, m.mode]))
  )
  /** Permission mode: auto-allow tool calls, or ask for each one. */
  const [autoAllow, setAutoAllow] = useState(edit?.autoAllow ?? true)
  /** Native git access injection — off by default; the user opts in per session. */
  const [gitAccess, setGitAccess] = useState(edit?.gitAccess ?? false)
  /** The selected agent's cached config surface (models/effort/commands). */
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null)
  /** Config-option picks keyed by option id; empty = agent defaults. */
  const [configValues, setConfigValues] = useState<Record<string, string | boolean>>(
    edit?.configValues ?? {}
  )
  const [credentials, setCredentials] = useState<CredentialEntry[]>([])
  const [harnessOpen, setHarnessOpen] = useState(false)
  /** Which quiet-select menu is open. */
  const [picker, setPicker] = useState<'task' | 'env' | 'repo' | 'client' | null>(null)
  /** Task picker showing its inline "new task" text field instead of the list. */
  const [creatingTask, setCreatingTask] = useState(false)
  const [newTaskName, setNewTaskName] = useState('')
  const [error, setError] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    window.gurt.getAgents().then((a) => {
      setAgents(a)
      // Create mode picks the first agent; edit mode keeps the draft's.
      if (!editing) {
        const first = Object.keys(a)[0]
        if (first) setAgent(first)
      }
    })
    window.gurt.getMcpDefs().then(setMcpDefs)
    window.gurt.getCredentials().then((f) => setCredentials(f.credentials)).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const mcpSelection = (): McpSelection[] =>
    Object.entries(mcp).map(([id, mode]) => ({ id, mode }))

  const wsData = tree.workspaces.find((w) => w.name === ws)
  const tasks = wsData?.tasks ?? []
  const taskData = tasks.find((t) => t.name === taskName)
  const repos = wsData?.repos ?? []
  const envs = wsData?.envs ?? []
  const agentList = agents
    ? Object.entries(agents).map(([id, a]) => ({ id, label: a.label, kind: a.kind }))
    : []

  useEffect(() => {
    if (!taskName && tasks.length) setTaskName(tasks[0].name)
  }, [taskName, tasks])

  // Default to the first env; seed the session repo from its default (create mode
  // only — edit mode keeps the session's saved repo).
  useEffect(() => {
    if (!env && envs.length) {
      setEnv(envs[0].name)
      if (!editing) setRepo(envs[0].repo ?? null)
    }
  }, [env, envs, editing])

  // Picking a (different) env re-seeds the session repo from that env's default.
  const pickEnv = (name: string) => {
    setEnv(name)
    setRepo(envs.find((e) => e.name === name)?.repo ?? null)
    setPicker(null)
  }

  const closeTaskPicker = () => {
    setPicker(null)
    setCreatingTask(false)
    setNewTaskName('')
  }

  // Creates the task on the fly and selects it, so the picker never forces a
  // detour through the sidebar's separate "new task" flow.
  const createTaskInline = async () => {
    const name = newTaskName.trim()
    if (!name) return
    setError('')
    try {
      await window.gurt.createTask(ws, name)
      setTaskName(name)
      closeTaskPicker()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Load the chosen agent's cached config surface so the model/effort/command
  // controls can be offered before the container is up. A stale response from a
  // previous agent is dropped via the `live` guard.
  useEffect(() => {
    if (!agent) {
      setAgentConfig(null)
      return
    }
    let live = true
    window.gurt
      .getAgentConfig(agent)
      .then((c) => live && setAgentConfig(c))
      .catch(() => live && setAgentConfig(null))
    return () => {
      live = false
    }
  }, [agent])

  const setConfig = (opt: SessionConfigOption, value: string | boolean) =>
    setConfigValues((prev) => ({ ...prev, [opt.id]: value }))
  // Effective value of an option: the user's pick, else the agent's current.
  const effective = (opt: SessionConfigOption) => configValues[opt.id] ?? opt.currentValue
  // Model/effort/fast — rendered inside Harness config, alongside Mode/Git
  // access/MCP/Skills; they're all part of the same "how does this session run"
  // surface. Mode itself is expressed via the auto/manual toggle, not this list.
  const cfgOptions = (agentConfig?.configOptions ?? []).filter((o) => o.category !== 'mode')
  const cfgLabel = (o: SessionConfigOption) =>
    o.category === 'model' ? 'MODEL' : o.category === 'thought_level' ? 'EFFORT' : o.name.toUpperCase()
  // What the currently-picked value of a select option actually means — shown under
  // the chips so e.g. "Default" doesn't sit unexplained (it's whatever the agent
  // itself reports for that entry).
  const selectedDescription = (opt: SessionConfigOption): string | undefined =>
    opt.options?.find((o) => o.value === effective(opt))?.description ?? undefined
  const selectedName = (opt: SessionConfigOption): string | undefined =>
    opt.options?.find((o) => o.value === effective(opt))?.name

  const repoCfg = repo ? repos.find((r) => r.name === repo) : undefined
  const gitResolution = repoCfg ? resolveForRepo(credentials, repoCfg) : null
  const gitCredNote = gitResolution
    ? hasManagedCredential(gitResolution)
      ? `credential: ${gitResolution.entry?.label}`
      : gitResolution.error
        ? `credential error: ${gitResolution.error}`
        : gitResolution.entry?.kind === 'git-host'
          ? `host credentials (explicit): ${gitResolution.entry.label}`
          : 'no credential — remote git/forge is blocked until one is configured'
    : null

  const saveEdit = async () => {
    setError('')
    try {
      await window.gurt.sessionEditDraft(edit!.id, {
        agent,
        env,
        repo,
        autoAllow,
        gitAccess,
        mcp: mcpSelection(),
        startPrompt: prompt,
        configValues
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const create = async (action: 'run' | 'queue' | 'draft') => {
    setError('')
    try {
      const s = await window.gurt.createSession(
        { workspace: ws, task: taskName, env },
        repo,
        agent,
        prompt,
        action,
        mcpSelection(),
        autoAllow,
        gitAccess,
        configValues
      )
      onCreated(s)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Draft only needs env + agent + prompt; running/queueing also needs a repo.
  const ready = !!taskName && !!env && !!agent && !!prompt.trim()
  const canRun = ready && !!repo
  const mcpCount = Object.keys(mcp).length
  // Model/effort surface in the summary so they stay legible while the panel's collapsed.
  const modelOpt = cfgOptions.find((o) => o.category === 'model')
  const effortOpt = cfgOptions.find((o) => o.category === 'thought_level')
  const harnessSummary = [
    modelOpt && selectedName(modelOpt),
    effortOpt && selectedName(effortOpt),
    autoAllow ? 'auto' : 'manual',
    `${mcpCount} mcp`
  ]
    .filter(Boolean)
    .join(' · ')

  /** A task's mark is its liveliest session: someone needs you (solid yellow)
   *  wins over merely having live sessions (green). */
  const taskStatusTone = (t: { sessions: SessionInfo[] }): 'green' | 'yellow' | 'outline' => {
    if (t.sessions.some((s) => s.awaitingInput)) return 'yellow'
    if (t.sessions.some((s) => s.state === 'started')) return 'green'
    return 'outline'
  }

  return (
    <Modal title={editing ? 'Edit session' : 'New session'} width={520} onClose={onClose}>
      <div className="ns-body">
        {/* task */}
        <PickRow
          open={picker === 'task'}
          onToggle={() => setPicker(picker === 'task' ? null : 'task')}
          onClose={closeTaskPicker}
          menu={
            creatingTask ? (
              <div className="menu-item-input">
                <input
                  autoFocus
                  className="input"
                  placeholder="task name"
                  value={newTaskName}
                  onChange={(e) => setNewTaskName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && createTaskInline()}
                />
              </div>
            ) : (
              <>
                {tasks.map((t) => (
                  <div
                    key={t.name}
                    className={`menu-item ${t.name === taskName ? 'active' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      setTaskName(t.name)
                      setPicker(null)
                    }}
                  >
                    <Dot tone={taskStatusTone(t)} />
                    {t.name}
                  </div>
                ))}
                {tasks.length > 0 && <div className="menu-sep" />}
                <div
                  className="menu-item"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    setCreatingTask(true)
                  }}
                >
                  + new task
                </div>
              </>
            )
          }
        >
          <span className="seclabel">TASK</span>
          <span className="pick-div" />
          {taskName ? (
            <>
              <Dot tone={taskData ? taskStatusTone(taskData) : 'outline'} />
              <span className="pick-value">{taskName}</span>
            </>
          ) : (
            <span className="pick-value faint">{tasks.length ? 'pick a task' : 'no tasks yet'}</span>
          )}
          <span className="spacer" />
        </PickRow>

        {/* environment */}
        <div className="ns-section">
          <span className="seclabel">ENVIRONMENT</span>
          <PickRow
            open={picker === 'env'}
            onToggle={() => setPicker(picker === 'env' ? null : 'env')}
            onClose={() => setPicker(null)}
            menu={
              envs.length ? (
                envs.map((e) => (
                  <div
                    key={e.name}
                    className={`menu-item ${e.name === env ? 'active' : ''}`}
                    onMouseDown={(ev) => {
                      ev.preventDefault()
                      pickEnv(e.name)
                    }}
                  >
                    <Icon name="box" size={13} className="dim" />
                    {e.name}
                    {e.repo && <span className="menu-meta mono">{e.repo}</span>}
                  </div>
                ))
              ) : (
                <div className="menu-empty">no environments — add one in Settings → Environments</div>
              )
            }
          >
            <Icon name="box" size={14} className="dim" style={{ flex: 'none' }} />
            <span className="pick-value strong">{env || 'pick an environment'}</span>
            <span className="spacer" />
          </PickRow>

          {/* session repository — seeded from the env's default, changeable here */}
          <span className="seclabel">REPOSITORY</span>
          <PickRow
            open={picker === 'repo'}
            onToggle={() => setPicker(picker === 'repo' ? null : 'repo')}
            onClose={() => setPicker(null)}
            menu={
              <>
                <div
                  className={`menu-item ${repo == null ? 'active' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    setRepo(null)
                    setPicker(null)
                  }}
                >
                  no repository
                </div>
                {repos.map((r) => (
                  <div
                    key={r.name}
                    className={`menu-item ${r.name === repo ? 'active' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      setRepo(r.name)
                      setPicker(null)
                    }}
                  >
                    <Icon name="branch" size={11} className="faint" />
                    {r.name}
                    <span className="menu-meta mono">{shortRepoUrl(r.url)}</span>
                  </div>
                ))}
              </>
            }
          >
            {repoCfg ? (
              <span className="chip-tag">
                <Icon name="branch" size={11} className="faint" />
                {shortRepoUrl(repoCfg.url)}
              </span>
            ) : (
              <span className="chip-dashed">no repository</span>
            )}
            <span className="spacer" />
          </PickRow>
          {!repo && (
            <div className="hc-note">no repository — Run/Queue disabled until you pick one</div>
          )}
        </div>

        {/* agent */}
        <div className="ns-section">
          <span className="seclabel">AGENT</span>
          <PickRow
            open={picker === 'client'}
            onToggle={() => setPicker(picker === 'client' ? null : 'client')}
            onClose={() => setPicker(null)}
            menu={
              agentList.length ? (
                agentList.map((a) => (
                  <div
                    key={a.id}
                    className={`menu-item ${a.id === agent ? 'active' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      setAgent(a.id)
                      setPicker(null)
                    }}
                  >
                    <Dot tone="green" size={7} />
                    <Icon name={agentIcon(a.kind)} size={12} className="faint" />
                    {a.label}
                  </div>
                ))
              ) : (
                <div className="menu-empty">no clients — add one in Settings → Clients</div>
              )
            }
          >
            <span className="pick-value">Client</span>
            <span className="spacer" />
            {agent && <Dot tone="green" size={7} />}
            <span className="pick-meta">
              {agent ? (
                <AgentMark kind={agentKind(agents ?? {}, agent)} name={agentName(agents ?? {}, agent)} />
              ) : (
                'none'
              )}
            </span>
          </PickRow>

          <div className={`hc ${harnessOpen ? 'open' : ''}`}>
            <button type="button" className="pick-row hc-head" onClick={() => setHarnessOpen((o) => !o)}>
              <Icon
                name="chevron"
                size={13}
                className="faint"
                style={{ flex: 'none', transform: harnessOpen ? undefined : 'rotate(-90deg)' }}
              />
              <span className="pick-value">Harness config</span>
              <span className="spacer" />
              <span className="pick-meta">{harnessSummary}</span>
            </button>
            {harnessOpen && (
              <div className="hc-body">
                {/* model / effort / fast — from the agent's cached config surface. The
                    agent's "default" entry (e.g. effort's unlabeled "Default") isn't a
                    real choice, it's the absence of one — omitted here so "nothing
                    selected" reads as itself instead of a mystery option. */}
                {cfgOptions.map((opt) =>
                  opt.type === 'select' ? (
                    <div key={opt.id} className="hc-block">
                      <span className="seclabel">{cfgLabel(opt)}</span>
                      <div className="chip-row">
                        {(opt.options ?? []).filter((o) => o.value !== 'default').map((o) => (
                          <button
                            key={o.value}
                            type="button"
                            className={`chip-btn ${effective(opt) === o.value ? 'on' : ''}`}
                            title={o.description ?? undefined}
                            onClick={() => setConfig(opt, o.value)}
                          >
                            {o.name}
                          </button>
                        ))}
                      </div>
                      {selectedDescription(opt) && (
                        <div className="hc-note">{selectedDescription(opt)}</div>
                      )}
                    </div>
                  ) : (
                    <div key={opt.id} className="hc-block">
                      <span className="seclabel">{cfgLabel(opt)}</span>
                      <div className="chip-row">
                        <button
                          type="button"
                          className={`chip-btn ${effective(opt) === true ? 'on' : ''}`}
                          onClick={() => setConfig(opt, true)}
                        >
                          on
                        </button>
                        <button
                          type="button"
                          className={`chip-btn ${effective(opt) === false ? 'on' : ''}`}
                          onClick={() => setConfig(opt, false)}
                        >
                          off
                        </button>
                      </div>
                    </div>
                  )
                )}
                <div className="hc-block">
                  <span className="seclabel">MODE</span>
                  <div className="chip-row">
                    <button
                      className={`chip-btn ${autoAllow ? 'on' : ''}`}
                      onClick={() => setAutoAllow(true)}
                      title="allow tool calls automatically"
                    >
                      auto
                    </button>
                    <button
                      className={`chip-btn ${!autoAllow ? 'on' : ''}`}
                      onClick={() => setAutoAllow(false)}
                      title="confirm each tool call"
                    >
                      manual
                    </button>
                  </div>
                </div>
                <div className="hc-block">
                  <span className="seclabel">GIT ACCESS</span>
                  <div className="chip-row">
                    <button
                      className={`chip-btn ${gitAccess ? 'on' : ''}`}
                      onClick={() => setGitAccess(true)}
                      title="native git + gh in the container"
                    >
                      on
                    </button>
                    <button
                      className={`chip-btn ${!gitAccess ? 'on' : ''}`}
                      onClick={() => setGitAccess(false)}
                      title="delegate remote git to the github MCP"
                    >
                      off
                    </button>
                  </div>
                  {gitCredNote && <div className="hc-note">{gitCredNote}</div>}
                </div>
                {mcpDefs.length > 0 && (
                  <div className="hc-block">
                    <span className="seclabel">MCP SERVERS</span>
                    {mcpDefs.map((def) => (
                      <McpRow
                        key={def.id}
                        def={def}
                        mode={mcp[def.id]}
                        onChange={(mode) =>
                          setMcp((prev) => {
                            const next = { ...prev }
                            if (mode == null) delete next[def.id]
                            else next[def.id] = mode
                            return next
                          })
                        }
                      />
                    ))}
                  </div>
                )}
                <div className="hc-block">
                  <span className="seclabel">SKILLS</span>
                  <div className="hc-stub">Skills, hooks, tool policy — coming later</div>
                </div>
                <div className="hc-foot">
                  <span className="spacer" />
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      setAutoAllow(true)
                      setGitAccess(false)
                      setMcp({})
                    }}
                  >
                    Reset
                  </button>
                  <button className="btn btn-sm btn-primary" onClick={() => setHarnessOpen(false)}>
                    Done
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="pick-row pick-static" title="agent roles — coming later">
            <span className="pick-value">Role</span>
            <span className="tag">optional</span>
            <span className="spacer" />
            <span className="pick-meta">No role</span>
            <Icon name="chevron" size={13} className="faint" style={{ flex: 'none' }} />
          </div>
        </div>

        {/* prompt */}
        <div className="ns-prompt">
          <textarea
            ref={taRef}
            autoFocus
            className="ns-prompt-input"
            placeholder="What should the agent do?"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                if (editing) {
                  if (ready) saveEdit()
                } else if (canRun) create('run')
              }
            }}
          />
          <div className="ns-prompt-foot">
            <span className="pick-meta mono">{editing ? '⌘↵ to save' : '⌘↵ to run'}</span>
          </div>
        </div>

        {error && <div className="error">{error}</div>}
      </div>

      <div className="modal-foot">
        {editing ? (
          <>
            <span className="spacer" />
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={!ready} onClick={saveEdit}>
              Save
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-text" disabled={!ready} onClick={() => create('draft')}>
              Save draft
            </button>
            <span className="spacer" />
            <button
              className="btn"
              disabled={!canRun}
              title={!repo ? 'pick a repository to queue' : undefined}
              onClick={() => create('queue')}
            >
              Add to queue
            </button>
            <button
              className="btn btn-primary"
              disabled={!canRun}
              title={!repo ? 'pick a repository to run' : undefined}
              onClick={() => create('run')}
            >
              <Icon name="play" size={11} />
              Run now
            </button>
          </>
        )}
      </div>
    </Modal>
  )
}

/** One MCP server row in the harness config: dot + name + off/read-only/full menu. */
function McpRow({
  def,
  mode,
  onChange
}: {
  def: McpDef
  mode: McpMode | undefined
  onChange: (mode: McpMode | null) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(open, ref, () => setOpen(false))
  const on = mode != null
  const label = mode == null ? 'off' : mode === 'read-only' ? 'read-only' : 'full'
  const pick = (m: McpMode | null) => {
    setOpen(false)
    onChange(m)
  }
  return (
    <div className="pick-wrap" ref={ref}>
      <button
        type="button"
        className="pick-row mcp-row"
        title={def.description}
        onClick={() => setOpen((o) => !o)}
      >
        <Dot tone={on ? 'green' : 'outline'} size={7} />
        <span className={`mcp-name ${on ? '' : 'faint'}`}>{def.label}</span>
        <span className="spacer" />
        <span className="pick-meta">{label}</span>
        <Icon name="chevron" size={12} className="faint" style={{ flex: 'none' }} />
      </button>
      {open && (
        <div className="menu pick-menu">
          {(['off', 'read-only', 'full'] as const).map((m) => (
            <div
              key={m}
              className={`menu-item ${label === m ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(m === 'off' ? null : m)
              }}
            >
              {m}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** `https://github.com/acme/checkout-web.git` → `acme/checkout-web`. */
function shortRepoUrl(url: string): string {
  const cleaned = url.replace(/\.git$/, '').replace(/\/+$/, '')
  const m = cleaned.match(/[:/]([^:/]+\/[^:/]+)$/)
  return m ? m[1] : cleaned
}
