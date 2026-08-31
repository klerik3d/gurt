import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { RepoChanges, SessionActivity, Tree } from '../../../shared/types'
import { isActionable, isDelivered, sessionStatus } from '../../../shared/types'
import type { Selection } from '../App'
import { bindingLabel } from '../../../shared/hotkeys'
import { agentKind, agentName, useAgents } from '../useAgents'
import { useHotkeys } from '../useHotkeys'
import { useOutsideClose } from '../hooks'
import { alertDialog, confirmDialog } from '../dialog'
import { SESSION_DOT } from '../status'
import { Icon, Dot } from './icons'
import { AgentMark } from './tags'
import { deleteSession, duplicateSession } from './SessionActions'
import { Modal } from './Modal'
import { fire, run } from '../async'

/** One visible line of the tree — the unit arrow-key navigation moves over. */
type Row =
  | { kind: 'task'; ws: string; task: string }
  | { kind: 'session'; id: string; ws: string; task: string }

const rowKey = (r: Row) => (r.kind === 'task' ? `t:${r.ws}/${r.task}` : `s:${r.id}`)

/** What the task list is ordered by, and which way round. */
export type TaskSortKey = 'name' | 'created'
export type TaskSortDir = 'asc' | 'desc'
export interface TaskSort {
  key: TaskSortKey
  dir: TaskSortDir
}

const TASK_SORT_KEY = 'gurt.sidebar.taskSort'
const DEFAULT_SORT: TaskSort = { key: 'name', dir: 'asc' }

export const SORT_KEY_LABEL: Record<TaskSortKey, string> = {
  name: 'Name',
  created: 'Created'
}

/** Direction reads as what the order *is*: "Z → A" and "Newest first" are the
 *  same `desc`, but nobody picking one thinks of it as descending. */
export const SORT_DIR_LABEL: Record<TaskSortKey, Record<TaskSortDir, string>> = {
  name: { asc: 'A → Z', desc: 'Z → A' },
  created: { asc: 'Oldest first', desc: 'Newest first' }
}

/** Case- and digit-aware, then exact — `sensitivity: 'base'` calls "api" and
 *  "API" equal, and a tie left to sort's stability would order them by whatever
 *  `readdir` returned that time. */
const byName = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }) ||
  (a < b ? -1 : a > b ? 1 : 0)

/**
 * Order the sidebar draws tasks in. `desc` reverses the whole comparison,
 * tiebreak included, so flipping direction flips exactly what is on screen —
 * the one thing the user is asking for when they press it.
 */
export function sortTasks<T extends { name: string; createdAt?: string }>(
  tasks: readonly T[],
  sort: TaskSort
): T[] {
  const cmp =
    sort.key === 'name'
      ? (a: T, b: T) => byName(a.name, b.name)
      : // Tasks created within the same second are a real case (a script, a
        // duplicate) — name keeps them from swapping places between renders.
        (a: T, b: T) =>
          (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || byName(a.name, b.name)
  const out = [...tasks].sort(cmp)
  return sort.dir === 'desc' ? out.reverse() : out
}

/** Sidebar-local and persisted: an ordering preference is not part of the tree,
 *  and one that resets on every launch is worse than not offering it. */
function useTaskSort(): [TaskSort, (s: TaskSort) => void] {
  const [sort, setSort] = useState<TaskSort>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(TASK_SORT_KEY) ?? 'null') as Partial<TaskSort>
      const key = raw?.key
      const dir = raw?.dir
      if ((key === 'name' || key === 'created') && (dir === 'asc' || dir === 'desc'))
        return { key, dir }
    } catch {
      // unreadable preference — the default order is a fine place to land
    }
    return DEFAULT_SORT
  })
  const update = (next: TaskSort): void => {
    setSort(next)
    try {
      localStorage.setItem(TASK_SORT_KEY, JSON.stringify(next))
    } catch {
      // a full/blocked store costs the preference, not the sort
    }
  }
  return [sort, update]
}

export function Sidebar({
  width,
  tree,
  ws,
  selection,
  changes,
  activity,
  focusSignal,
  onNewSession,
  onSelectTask,
  onSelectSession
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
  activity: Record<string, SessionActivity>
  /** Bumped by App on ⌘2 (`gotoTasks`) — focuses the tree, including on the
   *  mount that follows switching into the work view from elsewhere. */
  focusSignal?: number
  onNewSession: (ws: string, task: string) => void
  onSelectTask: (ws: string, task: string) => void
  onSelectSession: (id: string) => void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [creatingTask, setCreatingTask] = useState(false)
  const [taskDraftName, setTaskDraftName] = useState('')
  const taskPopRef = useRef<HTMLDivElement>(null)
  useOutsideClose(creatingTask, taskPopRef, () => {
    setCreatingTask(false)
    setTaskDraftName('')
  })
  const agents = useAgents()
  const hotkeys = useHotkeys()
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
  const [sort, setSort] = useTaskSort()
  const [sortOpen, setSortOpen] = useState(false)
  const sortPopRef = useRef<HTMLDivElement>(null)
  useOutsideClose(sortOpen, sortPopRef, () => setSortOpen(false))
  /** The one ordering everything below reads — rendering and the arrow-key row
   *  list both, or navigation would walk a list the user cannot see. */
  const tasks = sortTasks(wsData?.tasks ?? [], sort)
  /** Owner of every task in `tasks`. Empty only when there is no workspace, and
   *  then `tasks` is empty too, so nothing below ever reads the empty string. */
  const wsName = wsData?.name ?? ''

  // Keyboard navigation can walk the selection out of view — follow it.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selection])

  // ⌘2: focus the tree so arrow keys work immediately, no click first. Fires
  // on mount too (App bumps the signal before the work view has mounted this
  // component when switching in from dashboard/settings).
  useEffect(() => {
    if (focusSignal) treeRef.current?.focus()
  }, [focusSignal])

  const setCollapse = (ws2: string, task: string, on: boolean) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (on) next.add(`${ws2}/${task}`)
      else next.delete(`${ws2}/${task}`)
      return next
    })
    // Collapsing hides the selected session — move the selection up to the task
    // so it stays visible and arrow navigation keeps its place.
    if (on && selection?.type === 'session') {
      const owner = wsData?.tasks.find((t) => t.sessions.some((s) => s.id === selection.id))
      if (owner?.name === task) onSelectTask(ws2, task)
    }
  }

  /** Every task's collapse key, for the header's fold-all toggle. */
  const allTaskKeys = tasks.map((t) => `${wsName}/${t.name}`)
  const allCollapsed = allTaskKeys.length > 0 && allTaskKeys.every((k) => collapsed.has(k))
  const toggleCollapseAll = () => {
    if (!wsData || !allTaskKeys.length) return
    if (allCollapsed) {
      setCollapsed(new Set())
      return
    }
    setCollapsed(new Set(allTaskKeys))
    // Same reasoning as setCollapse: a selected session about to be hidden
    // moves the selection up to its task.
    if (selection?.type === 'session') {
      const owner = wsData.tasks.find((t) => t.sessions.some((s) => s.id === selection.id))
      if (owner) onSelectTask(wsData.name, owner.name)
    }
  }

  const deleteTask = async (taskName: string) => {
    if (!ws) return
    const dirty = await window.gurt.taskDirtyRepos(ws, taskName).catch(() => [])
    const warning = dirty.length
      ? `Task "${taskName}" has uncommitted changes in: ${dirty.join(', ')}. Delete anyway and permanently lose them, along with all environments and sessions?`
      : `Delete task "${taskName}" with all its environments, clones and sessions?`
    if (await confirmDialog(warning, { title: 'Delete task', confirmText: 'Delete', danger: true }))
      window.gurt.removeTask(ws, taskName).catch((e: unknown) => alertDialog(String(e)))
  }

  /** Resolves true once the delete has been confirmed and sent. */
  const deleteRow = async (id: string): Promise<boolean> => {
    const s = wsData?.tasks.flatMap((t) => t.sessions).find((x) => x.id === id)
    return s ? deleteSession(s) : false
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
  for (const task of tasks) {
    rows.push({ kind: 'task', ws: wsName, task: task.name })
    if (!collapsed.has(`${wsName}/${task.name}`))
      for (const s of task.sessions)
        rows.push({ kind: 'session', id: s.id, ws: wsName, task: task.name })
  }
  const isSelected = (r: Row) =>
    r.kind === 'task'
      ? selection?.type === 'task' && selection.ws === r.ws && selection.task === r.task
      : selection?.type === 'session' && selection.id === r.id
  const cursor = rows.findIndex(isSelected)
  /** Select a row by reference. Undefined is a no-op: the callers below step the
   *  cursor with clamped arithmetic, so it only happens on an empty tree. */
  const selectRow = (r: Row | undefined): void => {
    if (!r) return
    if (r.kind === 'task') onSelectTask(r.ws, r.task)
    else onSelectSession(r.id)
  }

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
          fire(() => deleteTask(cur.task).then(() => treeRef.current?.focus()))
          break
        }
        // A selection left on the deleted session would sit on an empty pane, so
        // step off it — but only once the delete is actually going through, or a
        // cancelled dialog would still have moved the cursor. Either neighbour
        // outlives this session: a sibling, or the task row that must be above it.
        const next = rows[cursor + 1] ?? rows[cursor - 1]
        fire(() =>
          deleteRow(cur.id).then((deleted) => {
            if (deleted && next) selectRow(next)
            treeRef.current?.focus()
          })
        )
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
        <div className="sb-ws">
          <span className="sb-ws-name">Tasks</span>
        </div>
        <span className="spacer" />
        <div className="sb-sort" ref={sortPopRef}>
          <button
            className={`icon-sq ${sortOpen ? 'active' : ''}`}
            title={`Sort tasks · ${SORT_KEY_LABEL[sort.key]}, ${SORT_DIR_LABEL[sort.key][sort.dir]}`}
            disabled={!allTaskKeys.length}
            onClick={() => setSortOpen((o) => !o)}
          >
            {/* The glyph flips with the direction, so the current order is
                readable from the closed button and not only from its tooltip. */}
            <Icon
              name="sort"
              size={14}
              style={sort.dir === 'desc' ? { transform: 'scaleY(-1)' } : undefined}
            />
          </button>
          {sortOpen && (
            <div className="menu sb-sort-menu">
              {/* Key and direction stay in one open menu: switching the key
                  relabels the directions under it ("A → Z" becomes "Oldest
                  first"), which is how the pair explains itself. */}
              {(['name', 'created'] as TaskSortKey[]).map((k) => (
                <div
                  key={k}
                  className={`menu-item ${sort.key === k ? 'active' : ''}`}
                  onClick={() => setSort({ ...sort, key: k })}
                >
                  <Dot tone={sort.key === k ? 'accent' : 'outline'} size={6} />
                  {SORT_KEY_LABEL[k]}
                </div>
              ))}
              <div className="menu-sep" />
              {(['asc', 'desc'] as TaskSortDir[]).map((d) => (
                <div
                  key={d}
                  className={`menu-item ${sort.dir === d ? 'active' : ''}`}
                  onClick={() => setSort({ ...sort, dir: d })}
                >
                  <Dot tone={sort.dir === d ? 'accent' : 'outline'} size={6} />
                  {SORT_DIR_LABEL[sort.key][d]}
                </div>
              ))}
            </div>
          )}
        </div>
        <button
          className="icon-sq"
          title={allCollapsed ? 'Expand all' : 'Collapse all'}
          disabled={!allTaskKeys.length}
          onClick={toggleCollapseAll}
        >
          <Icon name="fold" size={14} style={allCollapsed ? { transform: 'rotate(180deg)' } : undefined} />
        </button>
        <div className="sb-newtask" ref={taskPopRef}>
          <button
            className="icon-sq"
            title={`New task · ${bindingLabel(hotkeys.newTask)}`}
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
                  onKeyDown={run((e) => e.key === 'Enter' && submitNewTask())}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="sb-tree" ref={treeRef} tabIndex={0} role="tree" onKeyDown={onTreeKey}>
        {tasks.map((task) => {
          const tkey = `${wsName}/${task.name}`
          const isCollapsed = collapsed.has(tkey)
          const row: Row = { kind: 'task', ws: wsName, task: task.name }
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
                onClick={() => onSelectTask(wsName, task.name)}
                onDoubleClick={() => startRename(row)}
              >
                <span
                  className="sb-chev"
                  onClick={(e) => {
                    e.stopPropagation()
                    setCollapse(wsName, task.name, !isCollapsed)
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
                    onCommit={run(commitRename)}
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
                        onNewSession(wsName, task.name)
                      }}
                    >
                      <Icon name="message" size={13} />
                    </button>
                    <button
                      className="icon-sq sb-act"
                      title="delete task"
                      onClick={(e) => {
                        e.stopPropagation()
                        fire(() => deleteTask(task.name))
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
                  const srow: Row = { kind: 'session', id: s.id, ws: wsName, task: task.name }
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
                          onCommit={run(commitRename)}
                          onCancel={cancelRename}
                        />
                      ) : (
                        <>
                          <span className="sb-session-name">{s.title}</span>
                          {/* Agent mark and row actions share the right edge:
                              hovering swaps one for the other, so the actions
                              cost the title no width when nobody is reaching
                              for them. */}
                          <span className="sb-session-client">
                            {s.agent && (
                              <AgentMark kind={agentKind(agents, s.agent)} name={agentName(agents, s.agent)} />
                            )}
                          </span>
                          <span className="sb-session-acts">
                            <button
                              className="icon-sq sb-act"
                              title="duplicate as draft"
                              onClick={(e) => {
                                e.stopPropagation()
                                void duplicateSession(s.id, (copy) => onSelectSession(copy.id))
                              }}
                            >
                              <Icon name="copy" size={13} />
                            </button>
                            <button
                              className="icon-sq sb-act"
                              title="delete session"
                              onClick={(e) => {
                                e.stopPropagation()
                                void deleteSession(s)
                              }}
                            >
                              <Icon name="trash" size={13} />
                            </button>
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

/** Destructive confirm for deleting an entire workspace — every task,
 *  environment, clone and session in it goes with it, so the delete button
 *  only unlocks once the user has retyped the workspace's own name, same as
 *  GitHub's repo-delete pattern. */
export function DeleteWorkspaceModal({
  ws,
  onClose,
  onDeleted
}: {
  ws: string
  onClose: () => void
  onDeleted: () => void
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const matches = name === ws

  const submit = async () => {
    if (!matches || busy) return
    setBusy(true)
    setError('')
    try {
      await window.gurt.removeWorkspace(ws)
      onDeleted()
    } catch (e) {
      setBusy(false)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal title="Delete workspace" onClose={onClose}>
      <div className="modal-body">
        <p>
          Permanently delete workspace "<strong>{ws}</strong>"? Every task, environment, clone and
          session in it — including any uncommitted changes — is deleted with it. This cannot be
          undone.
        </p>
        <div>
          <span className="dim">
            Type <strong>{ws}</strong> to confirm.
          </span>
          <input
            autoFocus
            className="input"
            style={{ marginTop: 6 }}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={run((e) => e.key === 'Enter' && submit())}
            placeholder={ws}
          />
        </div>
        {error && <div className="error">{error}</div>}
      </div>
      <div className="modal-foot">
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-danger" disabled={!matches || busy} onClick={run(submit)}>
          Delete workspace
        </button>
      </div>
    </Modal>
  )
}

