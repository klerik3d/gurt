import { useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { ChangedFile, RepoChanges } from '../../../shared/types'
import { isActionable, isDelivered } from '../../../shared/types'
import { run } from '../async'
import { showToast } from '../toast'
import { Icon } from './icons'
import { RowContextMenu } from './RowContextMenu'
import { CommitModal } from './TaskPane'

export type FileLayout = 'list' | 'tree'
export interface DiffFileSelection {
  ws: string
  task: string
  repo: string
  path: string
}

interface FileNode {
  name: string
  path: string
  file?: ChangedFile
  children: Map<string, FileNode>
}

function fileTree(files: ChangedFile[]): FileNode[] {
  const root = new Map<string, FileNode>()
  for (const file of files) {
    let children = root
    let path = ''
    const parts = file.path.split('/')
    parts.forEach((name, i) => {
      path = path ? `${path}/${name}` : name
      let node = children.get(name)
      if (!node) {
        node = { name, path, children: new Map() }
        children.set(name, node)
      }
      if (i === parts.length - 1) node.file = file
      children = node.children
    })
  }
  return [...root.values()]
}

/** One visible line under a task in diff mode — the rows the sidebar's arrow
 *  keys walk, built by the same function the rendering reads so the two can't
 *  drift apart. */
export type DiffRow =
  | { kind: 'repo'; repo: string }
  | { kind: 'folder'; repo: string; path: string; name: string; depth: number }
  | { kind: 'file'; repo: string; path: string; file: ChangedFile; depth: number; flat: boolean }

export const diffRowKey = (r: { kind: DiffRow['kind']; repo: string; path?: string }): string =>
  r.kind === 'repo' ? `repo:${r.repo}` : `${r.kind}:${r.repo}:${r.path}`

/** Folding the sidebar owns — repos start closed, folders open. */
export interface DiffFolding {
  repoOpen: (repo: string) => boolean
  folderOpen: (repo: string, path: string) => boolean
}

/** Everything a task's repositories need from the tree they sit in. */
export interface DiffNav extends DiffFolding {
  setRepoOpen: (repo: string, open: boolean) => void
  setFolderOpen: (repo: string, path: string, open: boolean) => void
  /** Key of the row the tree's cursor is on, when it is in this task. */
  cursor: string | null
  /** A click landed on this row: move the cursor there, focus back on the tree. */
  point: (row: DiffRow) => void
  menu: { repo: string; x: number; y: number } | null
  setMenu: (menu: { repo: string; x: number; y: number } | null) => void
}

export function diffRows(changes: RepoChanges[], layout: FileLayout, folding: DiffFolding): DiffRow[] {
  return changes.flatMap((r): DiffRow[] => [
    { kind: 'repo', repo: r.repo },
    ...(folding.repoOpen(r.repo) ? fileRows(r, layout, folding) : [])
  ])
}

function fileRows(r: RepoChanges, layout: FileLayout, folding: DiffFolding): DiffRow[] {
  if (layout === 'list')
    return [...r.files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file) => ({ kind: 'file', repo: r.repo, path: file.path, file, depth: 0, flat: true }))
  const out: DiffRow[] = []
  const walk = (nodes: FileNode[], depth: number) => {
    for (const node of [...nodes].sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name))) {
      if (node.file) {
        out.push({ kind: 'file', repo: r.repo, path: node.path, file: node.file, depth, flat: false })
        continue
      }
      out.push({ kind: 'folder', repo: r.repo, path: node.path, name: node.name, depth })
      if (folding.folderOpen(r.repo, node.path)) walk([...node.children.values()], depth + 1)
    }
  }
  walk(fileTree(r.files), 0)
  return out
}

/** Rows are buttons for the click, not for focus: the tree holds the caret and
 *  walks them with its own cursor, so a click must not leave focus on one. */
const keepTreeFocus = (e: ReactMouseEvent) => e.preventDefault()

export function TaskRepositories({ ws, task, changes, layout, selection, nav, onRefresh }: {
  ws: string
  task: string
  changes: RepoChanges[] | undefined
  layout: FileLayout
  selection: DiffFileSelection | null
  nav: DiffNav
  onRefresh: () => Promise<void>
}) {
  if (!changes) return <div className="sb-empty">loading repositories…</div>
  if (!changes.length) return <div className="sb-empty">no repositories yet</div>
  return (
    <div role="group">
      {changes.map((repo) => (
        <Repository
          key={repo.repo}
          ws={ws}
          task={task}
          repo={repo}
          layout={layout}
          nav={nav}
          activePath={selection?.ws === ws && selection.task === task && selection.repo === repo.repo
            ? selection.path : null}
          onRefresh={onRefresh}
        />
      ))}
    </div>
  )
}

function Repository({ ws, task, repo: r, layout, nav, activePath, onRefresh }: {
  ws: string
  task: string
  repo: RepoChanges
  layout: FileLayout
  nav: DiffNav
  activePath: string | null
  onRefresh: () => Promise<void>
}) {
  const open = nav.repoOpen(r.repo)
  const menu = nav.menu?.repo === r.repo ? nav.menu : null
  const setMenu = (m: { x: number; y: number } | null) => nav.setMenu(m && { repo: r.repo, ...m })
  const repoRow: DiffRow = { kind: 'repo', repo: r.repo }
  const [committing, setCommitting] = useState(false)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const hasChanges = isActionable(r) || isDelivered(r)
  const act = async (fn: () => Promise<void>) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      showToast(`${r.repo}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      try {
        await onRefresh()
      } catch (e) {
        showToast(`${r.repo}: ${String(e)}`)
      }
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <div className="diff-repo" aria-busy={busy}>
      <button
        className={`diff-repo-row${activePath ? ' here' : ''}${nav.cursor === diffRowKey(repoRow) ? ' cursor' : ''}`}
        tabIndex={-1}
        aria-expanded={open}
        title={`${r.repo} · ${r.files.length} changed files${busy ? ' · working…' : ''}`}
        onMouseDown={keepTreeFocus}
        onClick={() => {
          nav.point(repoRow)
          nav.setRepoOpen(r.repo, !open)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          nav.point(repoRow)
          setMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        <Icon name="chevron" size={11} className="faint" style={open ? undefined : { transform: 'rotate(-90deg)' }} />
        <Icon name="branch" size={12} className="faint" />
        <span className="diff-repo-name">{r.repo}</span>
        <span
          className={`diff-repo-dot${hasChanges ? ' changed' : ''}${isDelivered(r) ? ' delivered' : ''}`}
          title={isActionable(r) ? 'Uncommitted or unpushed changes' : isDelivered(r) ? 'Pushed · awaiting merge' : 'No changes'}
        />
        <span className="spacer" />
        <span className="diff-counts mono" title="Uncommitted tracked lines">
          <span className="ins">+{r.insertions}</span>
          <span className="del">−{r.deletions}</span>
        </span>
        <span
          className={`diff-behind mono${r.behind ? ' behind' : ''}${r.conflicted ? ' red' : ''}`}
          title={r.conflicted ? 'Merge conflicts — resolve and commit' : `${r.behind} commits behind ${r.defaultBranch}`}
        >
          {r.conflicted ? '!' : `↓${r.behind}`}
        </span>
      </button>
      {open && (
        <div className="diff-files" role="group" aria-label={`Changed files in ${r.repo}`}>
          {r.files.length === 0 && (
            <div className="diff-files-empty">
              {r.commits.some((c) => !c.pushed) && !r.integrated
                ? 'No uncommitted files · ready to push'
                : 'No uncommitted files'}
            </div>
          )}
          {fileRows(r, layout, nav).map((row) => row.kind === 'folder'
            ? <Folder key={row.path} row={row} nav={nav} />
            : row.kind === 'file' && <FileRow key={row.path} row={row} nav={nav} active={activePath === row.path} />)}
        </div>
      )}
      {menu && (
        <RowContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button
            className="menu-item diff-menu-action"
            disabled={busy || r.conflicted}
            onClick={run(async () => {
              setMenu(null)
              await act(() => window.gurt.changesUpdateFromMain(ws, task, r.repo, 'merge'))
            })}
          >
            <Icon name="history" size={13} /> Merge pull from {r.defaultBranch}
          </button>
          <button
            className="menu-item diff-menu-action"
            disabled={busy || r.conflicted}
            onClick={run(async () => {
              setMenu(null)
              await act(() => window.gurt.changesUpdateFromMain(ws, task, r.repo, 'rebase'))
            })}
          >
            <Icon name="branch" size={13} /> Rebase onto {r.defaultBranch}
          </button>
          <button className="menu-item diff-menu-action" disabled={busy || !r.dirty} onClick={() => {
            setMenu(null)
            setCommitting(true)
          }}>
            <Icon name="plus" size={13} /> Commit changes…
          </button>
          <button
            className="menu-item diff-menu-action"
            disabled={busy || r.integrated || !r.commits.some((c) => !c.pushed)}
            onClick={run(async () => {
              setMenu(null)
              await act(() => window.gurt.changesPush(ws, task, r.repo))
            })}
          >
            <Icon name="send" size={13} /> Push changes
          </button>
        </RowContextMenu>
      )}
      {committing && (
        <CommitModal ws={ws} task={task} repo={r.repo} onClose={() => setCommitting(false)} onCommit={(message) => {
          setCommitting(false)
          void act(() => window.gurt.changesCommit(ws, task, r.repo, message))
        }} />
      )}
    </div>
  )
}

function Folder({ row, nav }: { row: Extract<DiffRow, { kind: 'folder' }>; nav: DiffNav }) {
  const open = nav.folderOpen(row.repo, row.path)
  return (
    <button
      className={`diff-file-row diff-folder${nav.cursor === diffRowKey(row) ? ' cursor' : ''}`}
      style={{ paddingLeft: 42 + row.depth * 14 }}
      tabIndex={-1}
      aria-expanded={open}
      onMouseDown={keepTreeFocus}
      onClick={() => {
        nav.point(row)
        nav.setFolderOpen(row.repo, row.path, !open)
      }}
    >
      <Icon name="chevron" size={10} style={open ? undefined : { transform: 'rotate(-90deg)' }} />
      <Icon name="folder" size={12} />
      <span className="diff-file-name">{row.name}</span>
    </button>
  )
}

function FileRow({ row, nav, active }: {
  row: Extract<DiffRow, { kind: 'file' }>
  nav: DiffNav
  active: boolean
}) {
  const { file, flat } = row
  const slash = file.path.lastIndexOf('/')
  return (
    <button
      className={`diff-file-row${active ? ' selected' : ''}${nav.cursor === diffRowKey(row) ? ' cursor' : ''}`}
      style={{ paddingLeft: 42 + row.depth * 14 }}
      tabIndex={-1}
      title={file.path}
      aria-pressed={active}
      onMouseDown={keepTreeFocus}
      onClick={() => nav.point(row)}
    >
      <Icon name="file" size={12} className="faint" />
      <span className="diff-file-name">{file.path.slice(slash + 1)}</span>
      {flat && slash >= 0 && <span className="diff-file-dir">{file.path.slice(0, slash)}</span>}
      <span className={`file-status st-${file.status}`}>{file.status}</span>
    </button>
  )
}
