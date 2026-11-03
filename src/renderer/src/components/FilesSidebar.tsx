import { useEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry, ScopeFile } from '../../../shared/files'
import type { RepoChanges, Tree } from '../../../shared/types'
import { fileKey } from '../../../shared/files'
import { usePreference, z } from '../persisted'
import { Icon } from './icons'
import { sortTasks, type ScopeListController } from '../useScopeList'
import { ScopeFilter, ScopeSort } from './ScopeControls'
import { ScopeRow } from './ScopeRow'
import { RowContextMenu } from './RowContextMenu'
import { confirmDialog } from '../dialog'
import type { FilesController } from '../useFiles'
import { FileTreeRow } from './FileTreeRow'

type FolderState = { entries?: FileEntry[]; error?: string }
type TreeRow = { task: string; path: string; name: string; kind: 'scope' | FileEntry['kind']; depth: number }
const folderKey = (ws: string, task: string, path: string): string => JSON.stringify([ws, task, path])
const folderSchema = z.array(z.string().refine((key) => {
  try {
    const value: unknown = JSON.parse(key)
    return Array.isArray(value) && value.length === 3 && value.every((part) => typeof part === 'string')
  } catch { return false }
}))

export function FilesSidebar({ controller, tree, collapsed, setCollapse, changes, scopeList, ws, width, focusSignal, selection, onSelectTask, onOpen, onNewTask }: {
  controller: FilesController
  tree: Tree | null
  collapsed: Set<string>
  setCollapse: (ws: string, task: string, on: boolean) => void
  changes: Record<string, RepoChanges[]>
  scopeList: ScopeListController
  ws: string | null
  width: number
  focusSignal: number
  selection: ScopeFile | null
  onSelectTask: (ws: string, task: string) => void
  onOpen: (file: ScopeFile) => void
  onNewTask: () => void
}) {
  const [expanded, setExpanded] = usePreference('fileFolders', [], folderSchema)
  const [folders, setFolders] = useState<Record<string, FolderState>>({})
  const [menu, setMenu] = useState<{ x: number; y: number; row: TreeRow } | null>(null)
  const [rename, setRename] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState(false)
  const [cursor, setCursor] = useState('')
  const [revision, setRevision] = useState(0)
  const loading = useRef(new Set<string>())
  const generation = useRef(0)
  const treeRef = useRef<HTMLDivElement>(null)
  const tasks = useMemo(() => tree?.workspaces.find((w) => w.name === ws)?.tasks ?? [], [tree, ws])
  const name = ws ?? ''
  // Scope folding belongs to App; this preference holds repository folders only.
  const openFolders = useMemo(() => [
    ...expanded.filter((key) => {
      const [workspace, task, path] = JSON.parse(key) as [string, string, string]
      return workspace === name && path !== '' && !collapsed.has(`${workspace}/${task}`)
    }),
    ...tasks.filter((task) => !collapsed.has(`${name}/${task.name}`)).map((task) => folderKey(name, task.name, ''))
  ], [expanded, tasks, collapsed, name])

  useEffect(() => {
    const refresh = () => { generation.current++; loading.current.clear(); setFolders({}); setRevision(generation.current) }
    const offTurn = window.gurt.onSessionTurn(({ ref, phase }) => { if (phase === 'ended' && ref.workspace === ws) refresh() })
    window.addEventListener('focus', refresh)
    return () => { offTurn(); window.removeEventListener('focus', refresh) }
  }, [ws])

  useEffect(() => { if (focusSignal) treeRef.current?.focus() }, [focusSignal])
  useEffect(() => {
    for (const key of openFolders) {
      const parsed: unknown = JSON.parse(key)
      if (!Array.isArray(parsed) || parsed.length !== 3 || !parsed.every((v) => typeof v === 'string')) continue
      const [workspace, task, path] = parsed as [string, string, string]
      if (workspace !== ws || !tasks.some((t) => t.name === task) || folders[key] || loading.current.has(key)) continue
      loading.current.add(key)
      window.gurt.listTaskFiles(workspace, task, path).then(
        (entries) => { if (revision === generation.current) setFolders((prev) => ({ ...prev, [key]: { entries } })) },
        (error: unknown) => { if (revision === generation.current) setFolders((prev) => ({ ...prev, [key]: { error: String(error) } })) }
      ).finally(() => loading.current.delete(key))
    }
  }, [openFolders, folders, ws, tasks, revision])

  // Reveal folders without overriding a scope explicitly folded in another mode.
  const selectedKey = selection ? fileKey(selection) : ''
  useEffect(() => {
    if (!selectedKey) return
    const [workspace, task, path] = JSON.parse(selectedKey) as [string, string, string]
    if (workspace !== ws) return
    const segments = path.split('/')
    const ancestors = segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'))
    setExpanded((prev) => [...new Set([...prev, ...ancestors.map((p) => folderKey(workspace, task, p))])])
    setCursor(folderKey(workspace, task, path))
  }, [selectedKey, ws, setExpanded])

  const rows: TreeRow[] = []
  const append = (task: string, path: string, depth: number): void => {
    if (path ? !expanded.includes(folderKey(name, task, path)) : collapsed.has(`${name}/${task}`)) return
    for (const entry of folders[folderKey(name, task, path)]?.entries ?? []) {
      rows.push({ task, ...entry, depth })
      if (entry.kind === 'directory') append(task, entry.path, depth + 1)
    }
  }
  const visibleTasks = sortTasks(tasks, scopeList.sort).filter((task) => !scopeList.pattern || scopeList.pattern.test(task.name))
  for (const task of visibleTasks) {
    rows.push({ task: task.name, path: '', name: task.name, kind: 'scope', depth: 0 })
    append(task.name, '', 1)
  }
  const keyOf = (row: TreeRow): string => folderKey(name, row.task, row.path)
  const expandable = (row: TreeRow): boolean => row.kind === 'directory' || row.kind === 'scope'
  const isOpen = (row: TreeRow): boolean => row.kind === 'scope'
    ? !collapsed.has(`${name}/${row.task}`) : row.kind === 'directory' && expanded.includes(keyOf(row))
  const toggle = (row: TreeRow, open: boolean) => {
    const key = keyOf(row)
    if (row.kind === 'scope') setCollapse(name, row.task, !open)
    else setExpanded((prev) => open ? [...new Set([...prev, key])] : prev.filter((k) => k !== key))
    if (open && folders[key]?.error) setFolders((prev) => { const next = { ...prev }; delete next[key]; return next })
  }
  const activate = (row: TreeRow) => {
    setCursor(keyOf(row))
    treeRef.current?.focus()
    if (row.kind === 'file') onOpen({ ws: name, task: row.task, path: row.path })
    else if (expandable(row)) {
      if (row.kind === 'scope') onSelectTask(name, row.task)
      toggle(row, !isOpen(row))
    }
  }

  const openMenu = (row: TreeRow, x: number, y: number) => {
    if (row.kind === 'scope' || row.kind === 'symlink') return
    setCursor(keyOf(row)); treeRef.current?.focus()
    setRenaming(false); setRename(row.name); setActionError(''); setMenu({ row, x, y })
  }
  const action = async (kind: 'rename' | 'delete' | 'relative' | 'absolute') => {
    if (!menu || busy) return
    const { row } = menu
    const file = { ws: name, task: row.task, path: row.path }
    setBusy(true); setActionError('')
    try {
      if (kind === 'relative' || kind === 'absolute') {
        await navigator.clipboard.writeText(kind === 'absolute' ? await window.gurt.taskFilePath(name, row.task, row.path) : row.path.split('/').slice(1).join('/') || '.')
      } else {
        const affected = controller.tabs.filter((tab) => tab.file.ws === name && tab.file.task === row.task && (tab.file.path === row.path || tab.file.path.startsWith(row.path + '/')))
        if (affected.some((tab) => tab.loading || tab.saving)) throw new Error('Wait for files to finish loading or saving')
        if (kind === 'delete') {
          if (!await confirmDialog(`Delete ${row.path}?${affected.some((tab) => tab.content !== tab.saved) ? ' Unsaved changes will be lost.' : ''}`, { title: 'Delete file', confirmText: 'Delete', danger: true })) return
          await window.gurt.deleteTaskFile(name, row.task, row.path)
          controller.movePath(file)
        } else {
          const destination = await window.gurt.renameTaskFile(name, row.task, row.path, rename)
          controller.movePath(file, destination)
          setCursor(folderKey(name, row.task, destination))
        }
        generation.current++; loading.current.clear(); setFolders({}); setRevision(generation.current)
      }
      setMenu(null)
    } catch (error) { setActionError(String(error)) } finally { setBusy(false) }
  }

  useEffect(() => { treeRef.current?.querySelector('.cursor')?.scrollIntoView({ block: 'nearest' }) }, [cursor])
  const allCollapsed = visibleTasks.length > 0 && visibleTasks.every((task) => collapsed.has(`${name}/${task.name}`))

  return <aside className="sidebar files-sidebar" style={{ width }}>
    <div className="sb-head">
      <div className="sb-ws"><span className="sb-ws-name">Scopes</span></div>
      <span className="spacer" />
      <button className="icon-sq" title="Refresh files" aria-label="Refresh files" onClick={() => { generation.current++; loading.current.clear(); setFolders({}); setRevision(generation.current) }}><Icon name="history" size={14} /></button>
      <ScopeSort controller={scopeList} disabled={!tasks.length} />
      <button className="icon-sq" title={allCollapsed ? 'Expand all' : 'Collapse all'} disabled={!visibleTasks.length}
        onClick={() => { for (const task of visibleTasks) setCollapse(name, task.name, !allCollapsed) }}>
        <Icon name="fold" size={14} style={allCollapsed ? { transform: 'rotate(180deg)' } : undefined} />
      </button>
      <button className="icon-sq" title="New scope" onClick={onNewTask}><Icon name="plus" size={14} /></button>
    </div>
    <ScopeFilter controller={scopeList} onFocusTree={() => treeRef.current?.focus()} />
    <div className="sb-tree file-tree" ref={treeRef} tabIndex={0} role="tree" aria-label="Scope files" aria-activedescendant={rows.some((r) => keyOf(r) === cursor) ? `file-tree-row-${rows.findIndex((r) => keyOf(r) === cursor)}` : undefined} onKeyDown={(event) => {
      if (event.target !== treeRef.current || !rows.length) return
      const at = rows.findIndex((r) => keyOf(r) === cursor)
      const row = rows[at]
      let next: TreeRow | undefined
      if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) && row) { const rect = treeRef.current?.querySelector('.cursor')?.getBoundingClientRect(); event.preventDefault(); openMenu(row, rect?.left ?? 0, rect?.bottom ?? 0); return }
      if (event.key === 'ArrowDown') next = rows[Math.min(at + 1, rows.length - 1)]
      else if (event.key === 'ArrowUp') next = rows[Math.max(at - 1, 0)]
      else if (event.key === 'Home') next = rows[0]
      else if (event.key === 'End') next = rows.at(-1)
      else if (event.key === 'ArrowRight' && row && expandable(row)) {
        if (!isOpen(row)) toggle(row, true)
        else if (rows[at + 1]?.depth === row.depth + 1) next = rows[at + 1]
      } else if (event.key === 'ArrowLeft' && row) {
        if (expandable(row) && isOpen(row)) toggle(row, false)
        else next = rows.slice(0, at).reverse().find((r) => r.depth < row.depth)
      } else if ((event.key === 'Enter' || event.key === ' ') && row) activate(row)
      else return
      event.preventDefault()
      if (next) setCursor(keyOf(next))
    }}>
      {rows.map((row, index) => {
        const key = keyOf(row)
        const open = isOpen(row)
        const selected = selection?.ws === name && selection.task === row.task && selection.path === row.path
        const folder = folders[key]
        return <div key={key} className={row.kind === 'scope' ? 'file-scope-group' : undefined}>
          {row.kind === 'scope' ? <ScopeRow name={row.name} open={open} selected={false} cursor={cursor === key}
            repos={changes[`${name}/${row.task}`] ?? []} id={`file-tree-row-${index}`} title={row.task} aria-level={1}
            onSelect={() => { setCursor(key); treeRef.current?.focus(); onSelectTask(name, row.task) }}
            onToggle={() => { setCursor(key); treeRef.current?.focus(); toggle(row, !open) }} /> : <FileTreeRow
            label={row.name} depth={row.depth} icon={expandable(row) ? 'folder' : 'file'}
            open={expandable(row) ? open : undefined} selected={selected} cursor={cursor === key}
            id={`file-tree-row-${index}`} disabled={row.kind === 'symlink'}
            title={row.kind === 'symlink' ? `${row.path} · Symbolic links cannot be opened` : row.path || row.task}
            onContextMenu={(event) => { event.preventDefault(); openMenu(row, event.clientX, event.clientY) }}
            onClick={() => activate(row)} />}
          {open && (!folder || folder.error || !folder.entries?.length) && <div className={`file-tree-note${folder?.error ? ' error' : ''}`} style={{ paddingLeft: 38 + row.depth * 14 }}>
            {folder?.error ?? (!folder ? 'Loading…' : row.kind === 'scope' ? 'No repository clones yet' : 'Empty folder')}
          </div>}
        </div>
      })}
      {tree && !tasks.length && <div className="file-tree-note">Create a scope to browse its files.</div>}
      {!!tasks.length && !visibleTasks.length && <div className="file-tree-note">No matching scopes</div>}
    </div>
    {menu && <RowContextMenu x={menu.x} y={menu.y} onClose={() => { if (!busy) setMenu(null) }}>
      {renaming ? <form onSubmit={(event) => { event.preventDefault(); void action('rename') }}><input aria-label="New file name" className="sb-rename" autoFocus value={rename} onChange={(event) => setRename(event.target.value)} /><button className="menu-item" disabled={busy || !rename.trim()} type="submit">Rename</button></form> : <button className="menu-item" disabled={busy || !menu.row.path.includes('/')} onClick={() => setRenaming(true)}>Rename</button>}
      <button className="menu-item" disabled={busy} onClick={() => { void action('relative') }}>Copy path from repository root</button>
      <button className="menu-item" disabled={busy} onClick={() => { void action('absolute') }}>Copy absolute path</button>
      <button className="menu-item danger" disabled={busy || !menu.row.path.includes('/')} onClick={() => { void action('delete') }}>Delete</button>
      {actionError && <div className="file-tree-note error" role="alert">{actionError}</div>}
    </RowContextMenu>}
  </aside>
}
