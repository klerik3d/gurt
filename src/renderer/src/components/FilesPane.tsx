import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { EditorView } from '@codemirror/view'
import type { FileLocation, FileNavigationResult } from '../../../shared/files'
import { fileKey } from '../../../shared/files'
import type { FilesController } from '../useFiles'
import { isDirty } from '../useFiles'
import { RowContextMenu } from './RowContextMenu'
import { Icon } from './icons'
import { bindingLabel } from '../../../shared/hotkeys'

const shortcut = (code: string) => bindingLabel({ code, mod: true, shift: false, alt: false })
const FileEditor = lazy(() => import('./FileEditor').then((module) => ({ default: module.FileEditor })))

export function FilesPane({ controller, scope, visible }: {
  controller: FilesController
  scope: { ws: string; task: string } | null
  visible: boolean
}) {
  const { activeTab: tab, scoped: tabs, open, close, save, reload, refresh } = controller
  const viewRef = useRef<EditorView | null>(null)
  const onView = useCallback((view: EditorView | null) => { viewRef.current = view }, [])
  const [navigation, setNavigation] = useState<{ kind: 'definition' | 'references'; result?: FileNavigationResult; error?: string; busy?: boolean } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const navSeq = useRef(0)
  const scopeId = scope ? JSON.stringify([scope.ws, scope.task]) : ''
  const activeKey = tab ? fileKey(tab.file) : ''

  useEffect(() => { navSeq.current++; setNavigation(null) }, [scopeId])
  useEffect(() => { navSeq.current++; setNavigation((previous) => previous?.busy ? null : previous) }, [activeKey])
  useEffect(() => {
    if (!visible || !activeKey) return
    void refresh(activeKey)
    const onFocus = () => { void refresh(activeKey) }
    window.addEventListener('focus', onFocus)
    const offTurn = window.gurt.onSessionTurn(({ ref, phase }) => {
      if (phase === 'ended' && ref.workspace === scope?.ws && ref.task === scope.task) void refresh(activeKey)
    })
    return () => { window.removeEventListener('focus', onFocus); offTurn() }
  }, [visible, activeKey, refresh, scope?.ws, scope?.task])

  const openLocation = useCallback((location: FileLocation) => {
    if (scope) open({ ...scope, path: location.path }, location)
  }, [scope, open])

  const navigate = useCallback((kind: 'definition' | 'references', position?: number) => {
    const view = viewRef.current
    if (!tab || !view) return
    const seq = ++navSeq.current
    setNavigation({ kind, busy: true })
    void window.gurt.navigateTaskFile(tab.file.ws, tab.file.task, tab.file.path, {
      kind,
      position: view.state.sliceDoc(0, position ?? view.state.selection.main.head).length,
      documents: tabs.filter((t) => t.version && !t.loading && (isDirty(t) || fileKey(t.file) === activeKey)).map((t) => ({ path: t.file.path, content: t.content }))
    }).then((result) => {
      if (seq !== navSeq.current) return
      if (kind === 'definition' && result.locations.length === 1) { openLocation(result.locations[0]!); setNavigation(null) }
      else setNavigation({ kind, result })
    }).catch((error: unknown) => {
      if (seq === navSeq.current) setNavigation({ kind, error: String(error) })
    })
  }, [tab, tabs, activeKey, openLocation])

  return <div className="files-pane" onContextMenu={(event) => { if (tab) { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY }) } }} hidden={!visible} onKeyDown={(event) => {
    if (!(event.metaKey || event.ctrlKey) || !tab) return
    if (event.code === 'KeyS') { event.preventDefault(); void save(activeKey) }
    else if (event.shiftKey && event.code === 'KeyR') { event.preventDefault(); void reload(activeKey) }
    else if (event.code === 'KeyW') { event.preventDefault(); void close(activeKey) }
  }}>
    {!scope ? <div className="placeholder">Select a scope to browse its files.</div> : <>
      <div className="file-tabs" role="tablist" aria-label="Open files">
        {tabs.map((item) => {
          const key = fileKey(item.file)
          const selected = key === activeKey
          return <div className={`file-tab${selected ? ' active' : ''}`} key={key} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); open(item.file); setMenu({ x: event.clientX, y: event.clientY }) }}>
            <button role="tab" aria-selected={selected} aria-controls="file-document" title={item.file.path}
              tabIndex={selected ? 0 : -1} onClick={() => open(item.file)} onKeyDown={(event) => {
                const index = tabs.indexOf(item)
                const next = event.key === 'ArrowRight' ? tabs[(index + 1) % tabs.length] : event.key === 'ArrowLeft' ? tabs[(index - 1 + tabs.length) % tabs.length] : undefined
                if (next) { event.preventDefault(); open(next.file); const buttons = event.currentTarget.closest('[role=tablist]')?.querySelectorAll<HTMLButtonElement>('[role=tab]'); buttons?.[tabs.indexOf(next)]?.focus() }
              }}>
              <Icon name="file" size={12} /><span>{item.file.path.split('/').at(-1)}</span>{isDirty(item) && <span className="file-dirty" title="Unsaved changes">●</span>}
            </button>
            <button className="file-tab-close" aria-label={`Close ${item.file.path}`} title={`Close · ${shortcut('KeyW')}`} disabled={item.saving} onClick={() => { void close(key) }}><Icon name="x" size={12} /></button>
          </div>
        })}
      </div>
      {!tab ? <div className="placeholder">Open a file from the tree.</div> : <div className="file-document" id="file-document" role="tabpanel" aria-label={tab.file.path}>
        {tab.error && <div className="file-error" role="alert">{tab.error}</div>}
        {tab.loading ? <div className="placeholder">Loading file…</div> : tab.version ? <Suspense fallback={<div className="placeholder">Loading editor…</div>}><FileEditor key={activeKey} tab={tab} controller={controller} onView={onView} onNavigate={navigate} /></Suspense> : <div className="placeholder">This file could not be opened.</div>}
      </div>}
      {menu && tab && <RowContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
        <button className="menu-item" disabled={tab.loading || tab.saving || !isDirty(tab)} onClick={() => { setMenu(null); void save(activeKey) }}>Save · {shortcut('KeyS')}</button>
        <button className="menu-item" disabled={tab.loading || tab.saving} onClick={() => { setMenu(null); void reload(activeKey) }}>Reload · {bindingLabel({ code: 'KeyR', mod: true, shift: true, alt: false })}</button>
        <button className="menu-item" disabled={!tab.version || !/\.[cm]?[jt]sx?$/i.test(tab.file.path)} onClick={() => { setMenu(null); navigate('definition') }}>Go to definition · F12</button>
        <button className="menu-item" disabled={!tab.version} onClick={() => { setMenu(null); navigate('references') }}>Find references · Shift+F12</button>
        <button className="menu-item" onClick={() => { setMenu(null); void close(activeKey) }}>Close · {shortcut('KeyW')}</button>
      </RowContextMenu>}
      {navigation && <div className="file-navigation" aria-label="Code navigation results">
        <div className="file-navigation-head"><strong>{navigation.kind === 'definition' ? 'Definitions' : navigation.result?.semantic === false ? 'Word matches' : 'References'}</strong>
          <span className="dim">{navigation.busy ? 'Searching…' : navigation.result ? `${navigation.result.locations.length} results${navigation.result.limited ? ' · search limit reached' : ''}` : ''}</span><span className="spacer" />
          <button className="icon-sq" aria-label="Close navigation results" onClick={() => { navSeq.current++; setNavigation(null) }}><Icon name="x" size={12} /></button></div>
        {navigation.error && <div className="file-tree-note error">{navigation.error}</div>}
        {navigation.result?.semantic === false && <div className="file-tree-note">{navigation.kind === 'definition' ? 'Go to definition is available for JavaScript and TypeScript.' : 'Text search in this repository; matches may include comments and unrelated symbols.'}</div>}
        {navigation.result?.locations.length === 0 && <div className="file-tree-note">No matches found in the indexed repository files.</div>}
        <div className="file-navigation-list">{navigation.result?.locations.map((location, index) => <button key={`${location.path}:${location.from}:${index}`} className="file-location" onClick={() => openLocation(location)}>
          <span>{location.path}:{location.line}:{location.column}</span><code>{location.preview}</code>
        </button>)}</div>
      </div>}
    </>}
  </div>
}
