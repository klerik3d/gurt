import { useEffect, useState } from 'react'
import type { ArchiveProgress as Progress } from '../../../shared/archive'
import { Icon } from './icons'

export function ArchiveProgress() {
  const [operation, setOperation] = useState<(Progress & { started: number }) | null>(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => window.gurt.onArchiveProgress((event) => {
    setNow(Date.now())
    setOperation((previous) => ({ ...event, started: previous?.id === event.id ? previous.started : Date.now() }))
  }), [])
  useEffect(() => {
    if (!operation || operation.done) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [operation?.id, operation?.done]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!operation) return null
  return <div className="archive-progress notification-popup" role="status" aria-live="polite">
    <Icon name="archive" size={18} />
    <div className="archive-progress-copy">
      <strong>{operation.label}</strong>
      <span>{operation.stage}{operation.bytes !== undefined ? ` · ${(operation.bytes / 1048576).toFixed(1)} MB processed` : ''}</span>
      {operation.error ? <span className="error">{operation.error}</span>
        : !operation.done && <><progress aria-label="Archiving in progress" /><span className="faint">Elapsed: {Math.floor((now - operation.started) / 1000)} s</span></>}
    </div>
    {operation.done && <button className="notif-dismiss" aria-label="Dismiss archive status" onClick={() => setOperation(null)}><Icon name="x" size={12} /></button>}
  </div>
}
