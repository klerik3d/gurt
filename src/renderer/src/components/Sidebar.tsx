import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { ChangedFile, DiffTarget, RepoChanges, SessionActivity, Tree } from '../../../shared/types'
import { sessionStatus } from '../../../shared/types'
import type { Selection } from '../App'
import { bindingLabel } from '../../../shared/hotkeys'
import { agentKind, agentName, useAgents } from '../useAgents'
import { useHotkeys } from '../useHotkeys'
import { useOutsideClose } from '../hooks'
import { alertDialog, confirmDialog } from '../dialog'
import { showToast } from '../toast'
import { GitCommitPanel, type CommitDraft } from './GitActions'
import { SESSION_DOT } from '../status'
import { markUnread } from '../reviewed'
import { Icon, Dot } from './icons'
import { AgentMark } from './tags'
import { deleteSession, duplicateSession, recreateSession } from './SessionActions'
import { Modal } from './Modal'
import { fire, run } from '../async'
import { RowContextMenu } from './RowContextMenu'
import { sortTasks, type ScopeListController } from '../useScopeList'
import { ScopeFilter, ScopeSort } from './ScopeControls'
import { ScopeRow } from './ScopeRow'
import { scopeNameInput } from '../../../shared/scopeName'
import {
  TaskRepositories,
  diffRowKey,
  groupKey,
  diffRows,
  type DiffFileSelection,
  type DiffFolding,
  type DiffNav,
  type DiffRow,
  type FileLayout
} from './DiffSidebar'

/** One visible line of the tree — the unit arrow-key navigation moves over. */
type Row =
  | { kind: 'task'; ws: string; task: string }
  | { kind: 'session'; id: string; ws: string; task: string }

const rowKey = (r: Row) => (r.kind === 'task' ? `t:${r.ws}/${r.task}` : `s:${r.id}`)

/** Rows arrow keys walk: diff mode adds a task's repos, folders and files. */
type NavRow = Row | { kind: 'diff'; ws: string; task: string; row: DiffRow }

const navKey = (r: NavRow) => (r.kind === 'diff' ? `d:${r.ws}/${r.task}/${diffRowKey(r.row)}` : rowKey(r))

/** Nesting level — Left walks to the nearest row above with a smaller one. */
const navDepth = (r: NavRow) =>
  r.kind === 'task' ? 0 : r.kind === 'session' || r.row.kind === 'repo' ? 1 : r.row.kind === 'group' ? 2 : 3 + r.row.depth

/** Returns the same set when nothing changes, so a no-op fold doesn't re-render. */
const toggled = (prev: Set<string>, key: string, on: boolean) => {
  if (prev.has(key) === on) return prev
  const next = new Set(prev)
  if (on) next.add(key)
  else next.delete(key)
  return next
}

export function Sidebar({
  collapsed,
  setCollapsed,
  setCollapse,
  seeded,
  width,
  tree,
  scopeList,
  ws,
  selection,
  changes,
  activity,
  focusSignal,
  readStateReady,
  onNewSession,
  onSelectTask,
  onSelectSession,
  mode = 'sessions',
  diffFile,
  onSelectDiffFile,
  onRefreshChanges
}: {
  collapsed: Set<string>
  setCollapsed: React.Dispatch<React.SetStateAction<Set<string>>>
  setCollapse: (ws: string, task: string, on: boolean) => void
  seeded: React.RefObject<Set<string>>
  /** Current sidebar width in px (user-draggable). */
  width: number
  mode?: 'sessions' | 'diff'
  diffFile?: DiffFileSelection | null
  onSelectDiffFile: (file: DiffFileSelection) => void
  onRefreshChanges: (ws: string, task: string) => Promise<void>
  tree: Tree | null
  scopeList: ScopeListController
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
  /** Whether the read marks on `activity` are settled — the fold-on-entry seed
   *  below must not run against a turn ledger that has not arrived yet. */
  readStateReady?: boolean
  onNewSession: (ws: string, task: string) => void
  onSelectTask: (ws: string, task: string) => void
  onSelectSession: (id: string) => void
}) {
  const [fileLayout, setFileLayout] = useState<FileLayout>(() =>
    localStorage.getItem('gurt.diff.fileLayout') === 'tree' ? 'tree' : 'list'
  )
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
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
  /** Right-click (or two-finger tap) target — a row's actions, at the pointer
   *  instead of behind a dedicated button, so hovering the tree never has to
   *  reserve or reveal space for one and the list holds still under the mouse. */
  const [ctxMenu, setCtxMenu] = useState<{ row: Row; x: number; y: number } | null>(null)
  /** Guards the edit against resolving twice: both Escape and a keyboard commit
   *  move focus off the input, and the blur that follows would otherwise run the
   *  commit a second time — against a name that no longer exists. */
  const renameSettled = useRef(false)
  const treeRef = useRef<HTMLDivElement>(null)
  /** Diff-mode folding lives here, not in the rows, so arrow keys see it too. */
  const [openRepos, setOpenRepos] = useState<Set<string>>(() => new Set())
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set())
  const [groupFiles, setGroupFiles] = useState<Record<string, { files?: ChangedFile[]; error?: string }>>({})
  const loadingGroups = useRef(new Set<string>())
  useEffect(() => {
    for (const key of openGroups) {
      const [workspace, task, repo, target] = JSON.parse(key) as [string, string, string, DiffTarget]
      if (target.kind !== 'commit' || groupFiles[key] || loadingGroups.current.has(key)) continue
      loadingGroups.current.add(key)
      window.gurt.getDiffFiles(workspace, task, repo, target).then(
        (files) => setGroupFiles((prev) => ({ ...prev, [key]: { files } })),
        (error: unknown) => setGroupFiles((prev) => ({ ...prev, [key]: { error: String(error) } }))
      ).finally(() => loadingGroups.current.delete(key))
    }
  }, [openGroups, groupFiles])
  const [closedFolders, setClosedFolders] = useState<Set<string>>(() => new Set())
  /** Where the diff-mode cursor sits within the selected task: `key` null is the
   *  task row itself. Repos and folders aren't selections App knows about, so
   *  the cursor has to be kept here; it only counts while its task is selected. */
  const [diffCursor, setDiffCursor] = useState<{ ws: string; task: string; key: string | null } | null>(null)
  const [commitDrafts, setCommitDrafts] = useState<Record<string, CommitDraft>>({})
  const [busyRepos, setBusyRepos] = useState<Set<string>>(() => new Set())
  const inFlightRepos = useRef(new Set<string>())
  const [repoMenu, setRepoMenu] = useState<{ ws: string; task: string; repo: string; x: number; y: number; target?: DiffTarget } | null>(null)

  const wsData = tree?.workspaces.find((w) => w.name === ws)
  /** The one ordering everything below reads — rendering and the arrow-key row
   *  list both, or navigation would walk a list the user cannot see. */
  const allTasks = sortTasks(wsData?.tasks ?? [], scopeList.sort)
  const tasks = allTasks.filter((task) => !scopeList.pattern || scopeList.pattern.test(task.name))
  /** Owner of every task in `tasks`. Empty only when there is no workspace, and
   *  then `tasks` is empty too, so nothing below ever reads the empty string. */
  const wsName = wsData?.name ?? ''
  const scopeNames = scopeNamesOf(wsData)
  const taskDraft = scopeNameInput(taskDraftName, scopeNames)

  // ⌘2: focus the tree so arrow keys work immediately, no click first. Fires
  // on mount too (App bumps the signal before the work view has mounted this
  // component when switching in from dashboard/settings).
  useEffect(() => {
    if (focusSignal) treeRef.current?.focus()
  }, [focusSignal])

  // Seed each workspace once; navigation must preserve manual folding.
  const seedKey = allTasks.length && readStateReady ? wsName : null
  useEffect(() => {
    if (mode === 'diff' || !seedKey || seeded.current.has(seedKey)) return
    seeded.current.add(seedKey)
    // The open session's own task stays up — folding it would hide the row for
    // what the pane is showing.
    const open = allTasks.find(
      (t) => selection?.type === 'session' && t.sessions.some((s) => s.id === selection.id)
    )
    const read = (t: (typeof tasks)[number]) =>
      t !== open &&
      t.sessions.length > 0 &&
      t.sessions.every((s) => sessionStatus({ ...s, ...activity[s.id] }) === 'idle-read')
    setCollapsed((prev) => new Set([...prev, ...allTasks.filter(read).map((t) => `${wsName}/${t.name}`)]))
  }, [seedKey, allTasks, activity, wsName, selection, mode, seeded, setCollapsed])

  /** Every task's collapse key, for the header's fold-all toggle. */
  const allTaskKeys = tasks.map((t) => `${wsName}/${t.name}`)
  const allCollapsed = allTaskKeys.length > 0 && allTaskKeys.every((k) => collapsed.has(k))
  const toggleCollapseAll = () => {
    if (!wsData || !allTaskKeys.length) return
    seeded.current.add(wsName)
    if (allCollapsed) {
      setCollapsed((prev) => new Set([...prev].filter((key) => !allTaskKeys.includes(key))))
      return
    }
    setCollapsed((prev) => new Set([...prev, ...allTaskKeys]))
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
      ? `Scope "${taskName}" has uncommitted changes in: ${dirty.join(', ')}. Delete anyway and permanently lose them, along with all environments and sessions?`
      : `Delete scope "${taskName}" with all its environments, clones and sessions?`
    if (await confirmDialog(warning, { title: 'Delete scope', confirmText: 'Delete', danger: true }))
      window.gurt.removeTask(ws, taskName).catch((e: unknown) => alertDialog(String(e)))
  }

  /** Resolves true once the delete has been confirmed and sent. */
  const deleteRow = async (id: string): Promise<boolean> => {
    const s = wsData?.tasks.flatMap((t) => t.sessions).find((x) => x.id === id)
    return s ? deleteSession(s) : false
  }

  /** Right-click opens the row's menu at the pointer and selects the row under
   *  it — same as clicking, so the menu always acts on what it's next to. */
  const openContextMenu = (e: ReactMouseEvent, row: Row) => {
    e.preventDefault()
    e.stopPropagation()
    moveTo(row)
    setCtxMenu({ row, x: e.clientX, y: e.clientY })
  }

  /** The open context menu's contents: scope actions or session actions. */
  const renderCtxMenu = (menu: { row: Row; x: number; y: number }, close: () => void) => {
    const { row } = menu
    // Only a session that already reads as seen has a mark worth handing back.
    const readSession =
      row.kind === 'session' &&
      tasks.some((t) =>
        t.sessions.some(
          (s) => s.id === row.id && sessionStatus({ ...s, ...activity[s.id] }) === 'idle-read'
        )
      )
    // Recreate only means something for a session that has left draft.
    const launched =
      row.kind === 'session'
        ? tasks.flatMap((t) => t.sessions).find((s) => s.id === row.id && s.state !== 'draft')
        : undefined
    return (
      <RowContextMenu x={menu.x} y={menu.y} onClose={close}>
        {row.kind === 'task' ? (
          <>
            <div
              className="menu-item"
              onMouseDown={(e) => {
                e.preventDefault()
                close()
                onNewSession(row.ws, row.task)
              }}
            >
              <Icon name="message" size={13} className="faint" />
              <span>New session</span>
            </div>
            <div className="menu-sep" />
            <div
              className="menu-item"
              onMouseDown={(e) => {
                e.preventDefault()
                close()
                fire(() => window.gurt.taskOpenTerminal(row.ws, row.task))
              }}
            >
              <Icon name="terminal" size={13} className="faint" />
              <span>Open in Terminal</span>
            </div>
            <div
              className="menu-item"
              onMouseDown={(e) => {
                e.preventDefault()
                close()
                fire(() => window.gurt.taskCopyPath(row.ws, row.task))
              }}
            >
              <Icon name="copy" size={13} className="faint" />
              <span>Copy path</span>
            </div>
            <div className="menu-sep" />
            <div
              className="menu-item danger"
              onMouseDown={(e) => {
                e.preventDefault()
                close()
                fire(() => deleteTask(row.task))
              }}
            >
              <Icon name="trash" size={13} className="faint" />
              <span>Delete scope</span>
            </div>
          </>
        ) : (
          <>
            <div
              className="menu-item"
              onMouseDown={(e) => {
                e.preventDefault()
                close()
                void duplicateSession(row.id, (copy) => onSelectSession(copy.id))
              }}
            >
              <Icon name="copy" size={13} className="faint" />
              <span>Duplicate</span>
            </div>
            {launched && (
              <div
                className="menu-item"
                onMouseDown={(e) => {
                  e.preventDefault()
                  close()
                  void recreateSession(launched, (draft) => onSelectSession(draft.id))
                }}
              >
                <Icon name="history" size={13} className="faint" />
                <span>Recreate…</span>
              </div>
            )}
            {readSession && (
              <div
                className="menu-item"
                onMouseDown={(e) => {
                  e.preventDefault()
                  close()
                  markUnread(row.id)
                }}
              >
                <Icon name="eye" size={13} className="faint" />
                <span>Mark unread</span>
              </div>
            )}
            <div className="menu-sep" />
            <div
              className="menu-item danger"
              onMouseDown={(e) => {
                e.preventDefault()
                close()
                fire(() => deleteRow(row.id))
              }}
            >
              <Icon name="trash" size={13} className="faint" />
              <span>Delete session</span>
            </div>
          </>
        )}
      </RowContextMenu>
    )
  }

  // Creates the task right from the header "+", no modal round-trip — click,
  // type, Enter. Selects it immediately so the flow lands somewhere useful.
  const submitNewTask = async () => {
    const { name, error } = taskDraft
    if (!name || error || !ws) return
    setCreatingTask(false)
    setTaskDraftName('')
    try {
      await window.gurt.createTask(ws, name)
      onSelectTask(ws, name)
    } catch (e) {
      await alertDialog(e instanceof Error ? e.message : String(e))
    }
  }

  const folding = (task: string): DiffFolding => ({
    repoOpen: (repo) => openRepos.has(`${wsName}/${task}/${repo}`),
    groupOpen: (repo, target) => openGroups.has(groupKey(wsName, task, repo, target)),
    groupFiles: (repo, target) => groupFiles[groupKey(wsName, task, repo, target)],
    folderOpen: (repo, path, target) => !closedFolders.has(`${groupKey(wsName, task, repo, target)}/${path}`)
  })

  // The tree as the user sees it, top to bottom — collapsed tasks contribute
  // only their own row. Arrow keys walk this list; nothing else needs the shape.
  const rows: NavRow[] = []
  for (const task of tasks) {
    rows.push({ kind: 'task', ws: wsName, task: task.name })
    if (collapsed.has(`${wsName}/${task.name}`)) continue
    if (mode === 'sessions')
      for (const s of task.sessions)
        rows.push({ kind: 'session', id: s.id, ws: wsName, task: task.name })
    else
      for (const row of diffRows(changes[`${wsName}/${task.name}`] ?? [], fileLayout, folding(task.name)))
        rows.push({ kind: 'diff', ws: wsName, task: task.name, row })
  }
  const isSelected = (r: Row) =>
    r.kind === 'task'
      ? selection?.type === 'task' && selection.ws === r.ws && selection.task === r.task
      : selection?.type === 'session' && selection.id === r.id
  const cursor = (() => {
    if (mode === 'diff' && selection?.type === 'task') {
      const { ws: sws, task: stask } = selection
      const key =
        diffCursor?.ws === sws && diffCursor.task === stask
          ? diffCursor.key
          : diffFile
            ? diffRowKey({ kind: 'file', repo: diffFile.repo, path: diffFile.path, target: diffFile.target })
            : null
      const at = key === null ? -1 : rows.findIndex(
        (r) => r.kind === 'diff' && r.ws === sws && r.task === stask && diffRowKey(r.row) === key
      )
      if (at >= 0) return at
    }
    return rows.findIndex((r) => r.kind !== 'diff' && isSelected(r))
  })()
  const cursorRow = rows[cursor]
  const cursorKey = cursorRow ? navKey(cursorRow) : null

  // Keyboard navigation can walk the cursor out of view — follow it.
  useEffect(() => {
    treeRef.current?.querySelector('.cursor')?.scrollIntoView({ block: 'nearest' })
  }, [cursorKey])

  /** Put the cursor on a row by reference. Undefined is a no-op: the callers
   *  below step the cursor with clamped arithmetic, so it only happens on an
   *  empty tree. Files select themselves into the diff pane, like sessions do. */
  const moveTo = (r: NavRow | undefined): void => {
    if (!r) return
    if (r.kind === 'session') return onSelectSession(r.id)
    if (mode === 'diff') setDiffCursor({ ws: r.ws, task: r.task, key: r.kind === 'diff' ? diffRowKey(r.row) : null })
    if (r.kind === 'task') onSelectTask(r.ws, r.task)
    else if (r.row.kind === 'file')
      onSelectDiffFile({ ws: r.ws, task: r.task, repo: r.row.repo, path: r.row.path, target: r.row.target })
    // Re-selecting the task it is already on would drop App's session selection.
    else if (!(selection?.type === 'task' && selection.ws === r.ws && selection.task === r.task))
      onSelectTask(r.ws, r.task)
  }

  /** Open (true), closed (false), or a leaf with nothing to fold (undefined). */
  const isExpanded = (r: NavRow): boolean | undefined => {
    if (r.kind === 'task') return !collapsed.has(`${r.ws}/${r.task}`)
    if (r.kind === 'session' || r.row.kind === 'file') return undefined
    const f = folding(r.task)
    return r.row.kind === 'repo' ? f.repoOpen(r.row.repo) : r.row.kind === 'group' ? f.groupOpen(r.row.repo, r.row.target) : f.folderOpen(r.row.repo, r.row.path, r.row.target)
  }
  const setRepoOpen = (task: string, repo: string, on: boolean) =>
    setOpenRepos((prev) => toggled(prev, `${wsName}/${task}/${repo}`, on))
  const setGroupOpen = (task: string, repo: string, target: DiffTarget, on: boolean) => {
    const key = groupKey(wsName, task, repo, target)
    if (on && groupFiles[key]?.error) setGroupFiles((prev) => { const next = { ...prev }; delete next[key]; return next })
    setOpenGroups((prev) => toggled(prev, key, on))
  }
  const setFolderOpen = (task: string, repo: string, path: string, target: DiffTarget, on: boolean) =>
    setClosedFolders((prev) => toggled(prev, `${groupKey(wsName, task, repo, target)}/${path}`, !on))
  const setExpanded = (r: NavRow, on: boolean) => {
    if (r.kind === 'task') setCollapse(r.ws, r.task, !on)
    else if (r.kind === 'diff' && r.row.kind === 'repo') setRepoOpen(r.task, r.row.repo, on)
    else if (r.kind === 'diff' && r.row.kind === 'group') setGroupOpen(r.task, r.row.repo, r.row.target, on)
    else if (r.kind === 'diff' && r.row.kind === 'folder') setFolderOpen(r.task, r.row.repo, r.row.path, r.row.target, on)
  }

  const actOnRepo = async (workspace: string, task: string, repo: string, fn: () => Promise<void>): Promise<boolean> => {
    const key = JSON.stringify([workspace, task, repo])
    if (inFlightRepos.current.has(key)) return false
    inFlightRepos.current.add(key)
    setBusyRepos((prev) => new Set(prev).add(key))
    try {
      await fn()
      return true
    } catch (e) {
      showToast(`${repo}: ${e instanceof Error ? e.message : String(e)}`)
      return false
    } finally {
      try {
        await onRefreshChanges(workspace, task)
      } catch (e) {
        showToast(`${repo}: ${String(e)}`)
      }
      inFlightRepos.current.delete(key)
      setBusyRepos((prev) => { const next = new Set(prev); next.delete(key); return next })
    }
  }

  const commitRepo = mode === 'diff' && cursorRow?.kind === 'diff'
    ? changes[`${cursorRow.ws}/${cursorRow.task}`]?.find((r) => r.repo === cursorRow.row.repo && r.dirty)
    : undefined
  const commitScope = commitRepo && cursorRow?.kind === 'diff' ? cursorRow : undefined
  const commitKey = commitScope ? JSON.stringify([commitScope.ws, commitScope.task, commitScope.row.repo]) : ''

  const diffNav = (task: string): DiffNav => ({
    ...folding(task),
    busy: (repo) => busyRepos.has(JSON.stringify([wsName, task, repo])),
    act: (repo, fn) => actOnRepo(wsName, task, repo, fn),
    setRepoOpen: (repo, on) => setRepoOpen(task, repo, on),
    setGroupOpen: (repo, target, on) => setGroupOpen(task, repo, target, on),
    setFolderOpen: (repo, path, target, on) => setFolderOpen(task, repo, path, target, on),
    cursor: cursorRow?.kind === 'diff' && cursorRow.task === task ? diffRowKey(cursorRow.row) : null,
    point: (row) => {
      moveTo({ kind: 'diff', ws: wsName, task, row })
      treeRef.current?.focus()
    },
    menu: repoMenu?.ws === wsName && repoMenu.task === task ? repoMenu : null,
    setMenu: (m) => setRepoMenu(m && { ws: wsName, task, ...m })
  })

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
    // A scope's name is its branch: committed as the branch it would become.
    const name = r?.kind === 'task' ? renameTaskDraft(r.task).name : renameDraft.trim()
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
            { title: 'Rename scope', confirmText: 'Rename' }
          ))
        )
          return
        // Only the local branch follows the rename. One already on the remote
        // stays there under the old name, with any pull request opened from it.
        const pushed = (changes[`${r.ws}/${r.task}`] ?? []).filter(
          (c) => !c.integrated && c.commits.some((k) => k.pushed)
        )
        if (
          pushed.length &&
          !(await confirmDialog(
            `Branch "${r.task}" is already pushed in: ${pushed.map((c) => c.repo).join(', ')}. ` +
              `The remote branch and its pull request keep the old name; the next push creates "${name}".`,
            { title: 'Rename scope', confirmText: 'Rename' }
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

  const renameTaskDraft = (task: string) => scopeNameInput(renameDraft, scopeNames, task)

  const cancelRename = () => {
    renameSettled.current = true
    setRenaming(null)
    treeRef.current?.focus()
  }

  const onTreeKey = (e: ReactKeyboardEvent) => {
    if (e.target !== treeRef.current || renaming || !rows.length) return
    const cur = cursorRow
    const expanded = cur && isExpanded(cur)
    switch (e.key) {
      case 'ArrowDown':
        moveTo(rows[Math.min(cursor + 1, rows.length - 1)])
        break
      case 'ArrowUp':
        moveTo(rows[Math.max(cursor - 1, 0)])
        break
      case 'ArrowRight': {
        // Expand first; on an already-expanded row, step into its children.
        if (!cur || expanded === undefined) return
        const next = rows[cursor + 1]
        if (!expanded) setExpanded(cur, true)
        else if (next && navDepth(next) > navDepth(cur)) moveTo(next)
        break
      }
      case 'ArrowLeft':
        if (!cur) return
        // Mirror of Right: collapse first, then out to the parent row.
        if (expanded) setExpanded(cur, false)
        else moveTo(rows.slice(0, cursor).reverse().find((r) => navDepth(r) < navDepth(cur)))
        break
      case 'Enter':
      case 'F2':
        // Diff rows have no name to edit — Enter folds repos and folders instead.
        if (cur?.kind === 'diff') {
          if (e.key === 'Enter' && expanded !== undefined) setExpanded(cur, !expanded)
        } else if (cur) startRename(cur)
        break
      case 'ContextMenu':
      case 'F10': {
        if (e.key === 'F10' && !e.shiftKey) return
        if (!cur || (cur.kind === 'diff' && cur.row.kind !== 'repo' && cur.row.kind !== 'group')) return
        const rect = treeRef.current?.querySelector('.cursor')?.getBoundingClientRect()
        if (!rect) return
        const pos = { x: rect.left + 20, y: rect.bottom }
        if (cur.kind === 'diff') setRepoMenu({ ws: cur.ws, task: cur.task, repo: cur.row.repo, ...(cur.row.kind === 'group' ? { target: cur.row.target } : {}), ...pos })
        else setCtxMenu({ row: cur, ...pos })
        break
      }
      // Both keys: ⌦ where the keyboard has one, ⌫ where Delete *is* backspace.
      // Neither acts on its own — the confirmation is the whole safety net.
      case 'Delete':
      case 'Backspace': {
        if (!cur || cur.kind === 'diff') return
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
            if (deleted && next) moveTo(next)
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
      <div className={`sb-head${mode === 'diff' ? ' sb-head-diff' : ''}`}>
        <div className="sb-ws">
          <span className="sb-ws-name">Scopes</span>
        </div>
        <span className="spacer" />
        {mode === 'diff' && (
          <>
            <div className="diff-layout" role="group" aria-label="Changed files layout">
              {(['list', 'tree'] as const).map((layout) => (
                <button
                  key={layout}
                  className={`icon-sq${fileLayout === layout ? ' active' : ''}`}
                  title={layout === 'list' ? 'File list' : 'File tree'}
                  aria-label={layout === 'list' ? 'File list' : 'File tree'}
                  aria-pressed={fileLayout === layout}
                  onClick={() => {
                    setFileLayout(layout)
                    localStorage.setItem('gurt.diff.fileLayout', layout)
                  }}
                >
                  <Icon name={layout === 'list' ? 'list' : 'tree'} size={13} />
                </button>
              ))}
            </div>
            <button
              className="icon-sq"
              title="Refresh changes"
              disabled={refreshing || !tasks.length}
              onClick={run(async () => {
                setRefreshing(true)
                setRefreshError('')
                try {
                  await Promise.all(tasks.map((t) => onRefreshChanges(wsName, t.name)))
                } catch (e) {
                  setRefreshError(String(e))
                } finally {
                  setRefreshing(false)
                }
              })}
            >
              <Icon name="history" size={14} className={refreshing ? 'diff-refreshing' : undefined} />
            </button>
          </>
        )}
        <ScopeSort controller={scopeList} disabled={!allTasks.length} />
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
            title={`New scope · ${bindingLabel(hotkeys.newTask)}`}
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
                  placeholder="scope name"
                  value={taskDraftName}
                  onChange={(e) => setTaskDraftName(e.target.value)}
                  onKeyDown={run((e) => e.key === 'Enter' && submitNewTask())}
                />
                <ScopeNameHint draft={taskDraft} typed={taskDraftName} />
              </div>
            </div>
          )}
        </div>
      </div>

      <ScopeFilter controller={scopeList} onFocusTree={() => treeRef.current?.focus()} />
      {mode === 'diff' && refreshError && <div className="error diff-refresh-error">{refreshError}</div>}
      <div className="sb-tree" ref={treeRef} tabIndex={0} role="tree" onKeyDown={onTreeKey}>
        {tasks.map((task) => {
          const tkey = `${wsName}/${task.name}`
          const isCollapsed = collapsed.has(tkey)
          const row: Row = { kind: 'task', ws: wsName, task: task.name }
          const taskSelected = isSelected(row)
          const editing = renaming && rowKey(renaming) === rowKey(row)
          return (
            <div key={task.name} className="sb-group">
              <ScopeRow
                name={task.name}
                open={!isCollapsed}
                selected={taskSelected}
                cursor={cursorKey === rowKey(row)}
                repos={changes[tkey] ?? []}
                editing={!!editing}
                onSelect={() => { moveTo(row); treeRef.current?.focus() }}
                onToggle={() => setCollapse(wsName, task.name, !isCollapsed)}
                onDoubleClick={() => startRename(row)}
                onContextMenu={editing ? undefined : (e) => openContextMenu(e, row)}
              >
                {editing ? (
                  <RenameInput
                    value={renameDraft}
                    error={renameTaskDraft(task.name).error}
                    onChange={setRenameDraft}
                    onCommit={run(commitRename)}
                    onCancel={cancelRename}
                  />
                ) : null}
              </ScopeRow>
              {!isCollapsed && mode === 'diff' && (
                <TaskRepositories
                  ws={wsName}
                  task={task.name}
                  changes={changes[tkey]}
                  layout={fileLayout}
                  selection={diffFile ?? null}
                  nav={diffNav(task.name)}
                />
              )}
              {!isCollapsed && mode === 'sessions' &&
                task.sessions.map((s) => {
                  const status = sessionStatus({ ...s, ...activity[s.id] })
                  const dot = SESSION_DOT[status]
                  const srow: Row = { kind: 'session', id: s.id, ws: wsName, task: task.name }
                  const selected = isSelected(srow)
                  const renamingThis = renaming && rowKey(renaming) === rowKey(srow)
                  return (
                    <div
                      key={s.id}
                      className={`sb-session ${selected ? 'selected' : ''}${cursorKey === rowKey(srow) ? ' cursor' : ''}`}
                      role="treeitem"
                      aria-selected={selected}
                      title={dot.label}
                      onClick={() => onSelectSession(s.id)}
                      onDoubleClick={() => startRename(srow)}
                      onContextMenu={renamingThis ? undefined : (e) => openContextMenu(e, srow)}
                    >
                      <Dot tone={dot.tone} pulse={dot.pulse} hollow={dot.hollow} />
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
              {!isCollapsed && mode === 'sessions' && task.sessions.length === 0 && (
                <div className="sb-empty">no sessions — “+” to add one</div>
              )}
            </div>
          )
        })}
        {!!allTasks.length && !tasks.length && <div className="sb-empty">No matching scopes</div>}
        {wsData && wsData.tasks.length === 0 && (
          <div className="sb-empty" style={{ paddingLeft: 18 }}>
            no scopes yet — “+” above to add one
          </div>
        )}
        {tree && tree.workspaces.length === 0 && (
          <div className="sb-empty" style={{ paddingLeft: 18 }}>
            no workspaces yet — create one via the workspace menu
          </div>
        )}
      </div>
      {commitScope && <GitCommitPanel key={commitKey} ws={commitScope.ws} task={commitScope.task} repo={commitScope.row.repo}
        draft={commitDrafts[commitKey]}
        onDraft={(update) => setCommitDrafts((prev) => ({ ...prev, [commitKey]: update(prev[commitKey]) }))}
        busy={busyRepos.has(commitKey)}
        act={(fn) => actOnRepo(commitScope.ws, commitScope.task, commitScope.row.repo, fn)} />}
      {ctxMenu && renderCtxMenu(ctxMenu, () => setCtxMenu(null))}
    </aside>
  )
}

/** Inline name editor for a tree row: commits on Enter or blur, drops on Escape.
 *  Its keys stop at the input so the tree's own arrow/Enter handling stays out. */
/** Every name a new scope must not clash with — agents included: a proactive
 *  agent is a scope on disk, and its name a branch like any other. */
export function scopeNamesOf(ws: Tree['workspaces'][number] | undefined): string[] {
  return [...(ws?.tasks ?? []), ...(ws?.proactive ?? [])].map((t) => t.name)
}

/** Under a scope-name field: why the name cannot be a branch, or — when typing
 *  changed it (spaces → `-`) — the branch it will be. */
function ScopeNameHint({ draft, typed }: { draft: { name: string; error: string | null }; typed: string }) {
  if (draft.error) return <div className="error scope-name-hint">{draft.error}</div>
  if (draft.name && draft.name !== typed.trim())
    return <div className="scope-name-hint">Branch: {draft.name}</div>
  return null
}

function RenameInput({
  value,
  error,
  onChange,
  onCommit,
  onCancel
}: {
  value: string
  /** Shown on the field, and Enter does nothing while it stands. */
  error?: string | null
  onChange: (v: string) => void
  onCommit: (refocus: boolean) => void
  onCancel: () => void
}) {
  return (
    <input
      autoFocus
      className={`sb-rename${error ? ' invalid' : ''}`}
      title={error ?? undefined}
      aria-invalid={!!error}
      value={value}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={() => onCommit(false)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          if (!error) onCommit(true)
        } else if (e.key === 'Escape') onCancel()
      }}
    />
  )
}

export function NameModal({
  title,
  placeholder,
  scopeNames,
  onClose,
  onSubmit
}: {
  title: string
  placeholder?: string
  /** Set when the name is a new scope's — and so a branch: the scopes it must
   *  not clash with. The field then explains what git would refuse. */
  scopeNames?: string[]
  onClose: () => void
  onSubmit: (name: string) => void
}) {
  const [typed, setTyped] = useState('')
  const draft = scopeNames ? scopeNameInput(typed, scopeNames) : { name: typed.trim(), error: null }
  const submit = () => {
    if (draft.name && !draft.error) onSubmit(draft.name)
  }
  return (
    <Modal title={title} onClose={onClose}>
      <div className="modal-body">
        <input
          autoFocus
          className="input"
          placeholder={placeholder ?? 'name'}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {scopeNames && <ScopeNameHint draft={draft} typed={typed} />}
      </div>
      <div className="modal-foot">
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!draft.name || !!draft.error} onClick={submit}>
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
          Permanently delete workspace "<strong>{ws}</strong>"? Every scope, environment, clone and
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
