import { useEffect, useRef, useState } from 'react'
import type { InterruptedSession } from '../../../shared/types'
import { run } from '../async'
import { Icon } from './icons'
import { Modal } from './Modal'

export function SessionRecoveryModal({ sessions, onResumed, onClose }: {
  sessions: InterruptedSession[]
  onResumed: (id: string) => void
  onClose: () => void
}) {
  const [selected, setSelected] = useState(() => new Set(sessions.map((s) => s.id)))
  const [busy, setBusy] = useState(false)
  const [resuming, setResuming] = useState<string | null>(null)
  const [error, setError] = useState('')
  const bodyRef = useRef<HTMLDivElement>(null)
  const chosen = sessions.filter((s) => selected.has(s.id))
  const allSelected = chosen.length === sessions.length

  // Keep keyboard navigation inside this startup prompt and return focus when
  // it closes. The regular modal handles Escape and backdrop dismissal.
  useEffect(() => {
    const previous = document.activeElement
    const dialog = bodyRef.current?.closest<HTMLElement>('.modal')
    if (!dialog) return
    bodyRef.current?.querySelector<HTMLInputElement>('input')?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')]
      const first = controls[0]
      const last = controls.at(-1)
      if (!first || !last) { event.preventDefault(); return }
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault()
        first.focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  const resume = async () => {
    if (busy || !chosen.length) return
    setBusy(true)
    setError('')
    let current: InterruptedSession | undefined
    try {
      for (const session of chosen) {
        current = session
        setResuming(session.id)
        await window.gurt.resumeInterruptedSession(session.id)
        onResumed(session.id)
      }
      onClose()
    } catch (e) {
      const detail = (e instanceof Error ? e.message : String(e))
        .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
      setError(`Could not resume “${current?.title ?? 'session'}”${current ? ` (${current.workspace} / ${current.task})` : ''}. ${detail}`)
    } finally {
      setResuming(null)
      setBusy(false)
    }
  }

  return <Modal title="Resume sessions" width={560} dismissible={!busy} onClose={onClose}>
    <div className="modal-body recovery-body" ref={bodyRef} aria-busy={busy}>
      <div className="recovery-intro">
        <span className="recovery-icon"><Icon name="history" size={22} /></span>
        <div>
          <p className="recovery-heading">Pick up where you left off</p>
          <p className="recovery-description">These sessions had unfinished work when the app closed. Choose which ones to continue.</p>
        </div>
      </div>
      <div className="recovery-list-head">
        <span className="seclabel">SESSIONS <span className="recovery-total">{sessions.length}</span></span>
        <button className="btn btn-xs" disabled={busy} onClick={() => setSelected(allSelected ? new Set() : new Set(sessions.map((s) => s.id)))}>
          {allSelected ? 'Clear selection' : 'Select all'}
        </button>
      </div>
      <div className="recovery-list" role="group" aria-label="Sessions to resume">
        {sessions.map((session) => <label key={session.id} className={`recovery-session${selected.has(session.id) ? ' selected' : ''}${busy ? ' busy' : ''}`}>
          <input type="checkbox" checked={selected.has(session.id)} disabled={busy}
            onChange={(e) => setSelected((previous) => {
              const next = new Set(previous)
              if (e.target.checked) next.add(session.id)
              else next.delete(session.id)
              return next
            })} />
          <span className="recovery-session-info">
            <span className="recovery-session-title">{session.title}</span>
            <span className="recovery-scope" title={`${session.workspace} / ${session.task}`}>
              <Icon name="folder" size={12} />
              <span>{session.workspace}</span><span className="faint">/</span><strong>{session.task}</strong>
            </span>
          </span>
          {resuming === session.id && <span className="recovery-status" role="status">Resuming…</span>}
        </label>)}
      </div>
      {error && <div className="recovery-error" role="alert"><Icon name="info" size={15} /><span>{error}</span></div>}
      <p className="recovery-note">Sessions you leave for later stay paused. You can resume them from the top bar.</p>
    </div>
    <div className="modal-foot recovery-foot">
      <span className="recovery-count" aria-live="polite">{chosen.length} of {sessions.length} selected</span>
      <span className="spacer" />
      <button className="btn" disabled={busy} onClick={onClose}>Later</button>
      <button className="btn btn-primary" disabled={busy || !chosen.length} onClick={run(resume)}>
        <Icon name="play" size={13} /> {busy ? 'Resuming…' : `Resume selected${chosen.length ? ` (${chosen.length})` : ''}`}
      </button>
    </div>
  </Modal>
}
