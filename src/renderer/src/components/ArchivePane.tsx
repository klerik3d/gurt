import { useCallback, useEffect, useState } from 'react'
import type { ScopeArchive } from '../../../shared/archive'
import type { ChatEntry } from '../../../shared/types'
import { ArchiveChat } from './Chat'
import { Icon } from './icons'
import { ScopeRow } from './ScopeRow'
import { confirmDialog } from '../dialog'

const date = (value: string): string => new Date(value).toLocaleString()
const size = (bytes: number): string => bytes >= 1024 * 1024
  ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`

export function ArchivePane({ workspace, width }: { workspace: string | null; width: number }) {
  const [archives, setArchives] = useState<ScopeArchive[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [session, setSession] = useState<string | null>(null)
  const [entries, setEntries] = useState<ChatEntry[] | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const load = useCallback(() => {
    void window.gurt.listArchives().then(setArchives).catch((e: unknown) => setError(String(e))).finally(() => setLoading(false))
  }, [])
  useEffect(() => { load(); return window.gurt.onTreeChanged(load) }, [load])
  const visible = archives.filter((a) => (a.workspace === workspace) &&
    `${a.task} ${a.sessions.map((s) => s.title).join(' ')}`.toLowerCase().includes(query.toLowerCase()))
  const active = visible.find((a) => a.id === selected)
  const activeSession = active?.sessions.find((s) => s.id === session)

  useEffect(() => {
    let cancelled = false
    setEntries(null)
    if (active && activeSession) {
      void window.gurt.readArchiveSession(active.id, activeSession.id)
        .then((value) => { if (!cancelled) setEntries(value) })
        .catch((e: unknown) => { if (!cancelled) setError(String(e)) })
    }
    return () => { cancelled = true }
  }, [active?.id, activeSession?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError('')
    try { await action(); load() } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }

  return <>
    <aside className="sidebar archive-sidebar" style={{ width }}>
      <div className="sb-head"><span>Archive</span><span className="spacer" />
        <button className="icon-sq" title="Refresh archive" onClick={load}><Icon name="history" size={14} /></button>
      </div>
      <div className="sb-filter-wrap"><input className="input" aria-label="Filter archives" placeholder="Filter archives…"
        value={query} onChange={(e) => setQuery(e.target.value)} /></div>
      <div className="archive-tree" role="tree" aria-label="Archived scopes">
        {visible.map((archive) => <div key={archive.id} role="none">
          <ScopeRow name={archive.task} open={expanded.has(archive.id)} selected={selected === archive.id}
            cursor={false} repos={[]}
            onSelect={() => { setSelected(archive.id); setSession(null); setError('') }}
            onToggle={() => setExpanded((previous) => {
              const next = new Set(previous)
              if (next.has(archive.id)) next.delete(archive.id)
              else next.add(archive.id)
              return next
            })}>
            <Icon name="archive" size={13} /><span className="sb-task-name">{archive.task}{archive.kind === 'session' ? ` / ${archive.sessions[0]?.title ?? 'session'}` : ''}</span>
            {archive.pinned && <span className="archive-pinned" title="Pinned — protected from deletion">Pinned</span>}
          </ScopeRow>
          {expanded.has(archive.id) && <div role="group">{archive.sessions.map((s) =>
            <button key={s.id} role="treeitem" aria-selected={session === s.id}
              className={`sb-session${session === s.id ? ' selected' : ''}`}
              onClick={() => { setSelected(archive.id); setSession(s.id); setError('') }}>
              <Icon name="message" size={12} /><span className="sb-session-name">{s.title}</span>
            </button>)}
          </div>}
        </div>)}
        {!visible.length && <div className="archive-empty-list">{loading ? 'Loading archive…' : 'No archived scopes.'}</div>}
      </div>
    </aside>
    <main className="main archive-main">
      {error && <div className="error" role="alert">{error}</div>}
      {active ? <>
        <div className="archive-head">
          <Icon name="archive" size={18} />
          <span className="chat-title archive-title">{active.task}{activeSession ? ` / ${activeSession.title}` : ''}</span>
          <span className="spacer" />
          <button className={`btn${active.pinned ? ' active' : ''}`} disabled={busy}
            onClick={() => { void act(() => window.gurt.pinArchive(active.id, !active.pinned)) }}>
            {active.pinned ? 'Unpin' : 'Pin'}
          </button>
          <button className="btn" disabled={busy} onClick={() => { void act(() => window.gurt.restoreArchive(active.id)) }}>
            {busy ? 'Working…' : 'Restore'}
          </button>
          <button className="btn danger" disabled={busy || active.pinned}
            title={active.pinned ? 'Unpin before deleting' : 'Permanently delete archive'}
            onClick={() => { void act(async () => {
              if (await confirmDialog(`Permanently delete the archive of "${active.task}" and its chats?`,
                { title: 'Delete archive', confirmText: 'Delete', danger: true })) await window.gurt.deleteArchive(active.id)
            }) }}><Icon name="trash" size={13} /></button>
        </div>
        <dl className="archive-meta">
          <div><dt>Created</dt><dd>{date(active.createdAt)}</dd></div>
          <div><dt>Archived</dt><dd>{date(active.archivedAt)}</dd></div>
          <div><dt>Archive size</dt><dd>{size(active.compressedBytes)}</dd></div>
          {active.originalBytes > 0 && <div><dt>Original size</dt><dd>{size(active.originalBytes)}</dd></div>}
          {active.pinned && <div><dt>Retention</dt><dd>Protected from deletion</dd></div>}
        </dl>
        {activeSession ? entries
          ? <ArchiveChat key={`${active.id}/${activeSession.id}`} entries={entries} sessionId={activeSession.id} />
          : <div className="archive-empty">{error ? 'Could not load archived chat.' : 'Loading chat…'}</div>
          : <section className="archive-overview">
              <h2>Sessions <span className="faint">{active.sessions.length}</span></h2>
              {active.sessions.length ? <div className="archive-session-list">{active.sessions.map((s) =>
                <button className="archive-session-card" key={s.id} onClick={() => { setSession(s.id); setError('') }}>
                  <Icon name="message" size={16} /><span>{s.title}</span><Icon name="chevron" size={14} style={{ transform: 'rotate(-90deg)' }} />
                </button>)}</div> : <p className="set-note">No sessions in this archive.</p>}
            </section>}
      </> : <div className="archive-empty">Select an archived scope.</div>}
    </main>
  </>
}
