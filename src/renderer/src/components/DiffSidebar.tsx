import { useMemo, useRef, useState } from 'react'
import type { ChangedFile, RepoChanges } from '../../../shared/types'
import { isActionable, isDelivered } from '../../../shared/types'
import { run } from '../async'
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

export function TaskRepositories({ ws, task, changes, layout, selection, onSelect, onRefresh }: {
  ws: string
  task: string
  changes: RepoChanges[] | undefined
  layout: FileLayout
  selection: DiffFileSelection | null
  onSelect: (file: DiffFileSelection) => void
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
          activePath={selection?.ws === ws && selection.task === task && selection.repo === repo.repo
            ? selection.path : null}
          onSelect={(path) => onSelect({ ws, task, repo: repo.repo, path })}
          onRefresh={onRefresh}
        />
      ))}
    </div>
  )
}

function Repository({ ws, task, repo: r, layout, activePath, onSelect, onRefresh }: {
  ws: string
  task: string
  repo: RepoChanges
  layout: FileLayout
  activePath: string | null
  onSelect: (path: string) => void
  onRefresh: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [committing, setCommitting] = useState(false)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [error, setError] = useState('')
  const hasChanges = isActionable(r) || isDelivered(r)
  const nodes = useMemo(() => fileTree(r.files), [r.files])
  const act = async (fn: () => Promise<void>) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      try {
        await onRefresh()
      } catch (e) {
        setError(String(e))
      }
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <div className="diff-repo" aria-busy={busy}>
      <button
        className={`diff-repo-row${activePath ? ' here' : ''}`}
        aria-expanded={open}
        title={`${r.repo} · ${r.files.length} changed files${busy ? ' · working…' : ''}`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') { e.preventDefault(); setOpen(true) }
          if (e.key === 'ArrowLeft') { e.preventDefault(); setOpen(false) }
          if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            e.preventDefault()
            const rect = e.currentTarget.getBoundingClientRect()
            setMenu({ x: rect.left + 20, y: rect.bottom })
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
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
      {error && <div className="error diff-repo-error">{error}</div>}
      {open && (
        <div className="diff-files" role="group" aria-label={`Changed files in ${r.repo}`}>
          {r.files.length === 0 && (
            <div className="diff-files-empty">
              {r.commits.some((c) => !c.pushed) && !r.integrated
                ? 'No uncommitted files · ready to push'
                : 'No uncommitted files'}
            </div>
          )}
          {layout === 'list'
            ? [...r.files].sort((a, b) => a.path.localeCompare(b.path)).map((file) => (
                <FileRow key={file.path} file={file} depth={0} flat active={activePath === file.path} onSelect={onSelect} />
              ))
            : <FileTree nodes={nodes} depth={0} activePath={activePath} onSelect={onSelect} />}
        </div>
      )}
      {menu && (
        <RowContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button
            className="menu-item diff-menu-action"
            disabled={busy || r.conflicted}
            onClick={run(async () => {
              setMenu(null)
              await act(() => window.gurt.changesUpdateFromMain(ws, task, r.repo))
            })}
          >
            <Icon name="history" size={13} /> Update from {r.defaultBranch}
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

function FileTree({ nodes, depth, activePath, onSelect }: {
  nodes: FileNode[]
  depth: number
  activePath: string | null
  onSelect: (path: string) => void
}) {
  return [...nodes]
    .sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name))
    .map((node) => node.file
      ? <FileRow key={node.path} file={node.file} depth={depth} active={node.path === activePath} onSelect={onSelect} />
      : <Folder key={node.path} node={node} depth={depth} activePath={activePath} onSelect={onSelect} />)
}

function Folder({ node, depth, activePath, onSelect }: {
  node: FileNode
  depth: number
  activePath: string | null
  onSelect: (path: string) => void
}) {
  const [open, setOpen] = useState(true)
  return (
    <div>
      <button className="diff-file-row diff-folder" style={{ paddingLeft: 42 + depth * 14 }} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="chevron" size={10} style={open ? undefined : { transform: 'rotate(-90deg)' }} />
        <Icon name="folder" size={12} />
        <span className="diff-file-name">{node.name}</span>
      </button>
      {open && <FileTree nodes={[...node.children.values()]} depth={depth + 1} activePath={activePath} onSelect={onSelect} />}
    </div>
  )
}

function FileRow({ file, depth, flat, active, onSelect }: {
  file: ChangedFile
  depth: number
  flat?: boolean
  active: boolean
  onSelect: (path: string) => void
}) {
  const slash = file.path.lastIndexOf('/')
  return (
    <button
      className={`diff-file-row${active ? ' selected' : ''}`}
      style={{ paddingLeft: 42 + depth * 14 }}
      title={file.path}
      aria-pressed={active}
      onClick={() => onSelect(file.path)}
    >
      <Icon name="file" size={12} className="faint" />
      <span className="diff-file-name">{file.path.slice(slash + 1)}</span>
      {flat && slash >= 0 && <span className="diff-file-dir">{file.path.slice(0, slash)}</span>}
      <span className={`file-status st-${file.status}`}>{file.status}</span>
    </button>
  )
}
