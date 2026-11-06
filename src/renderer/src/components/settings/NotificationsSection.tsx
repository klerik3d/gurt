import { useEffect, useState } from 'react'
import type { NotificationPrefs, NotificationType } from '../../../../shared/notifications'
import { run } from '../../async'

// ---- Notifications — per-type on/off matrix (§4.4) ----

const NOTIFICATION_COPY: Record<NotificationType, { label: string; hint: string }> = {
  awaiting: { label: 'Awaiting', hint: 'needs your input — a permission request is pending' },
  proposal: { label: 'Proposal', hint: 'changes are ready to review' },
  error: { label: 'Error', hint: 'a session or its container failed' },
  'turn-ended': { label: 'Turn ended', hint: 'turn finished, nothing to review' }
}

const NOTIFICATION_ORDER: NotificationType[] = ['awaiting', 'proposal', 'error', 'turn-ended']

export function NotificationsSection() {
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    window.gurt.getNotificationPrefs().then(setPrefs).catch((e: unknown) => setError(String(e)))
  }, [])

  const toggle = async (type: NotificationType, key: 'inApp' | 'external') => {
    if (!prefs) return
    const prior = prefs
    const next: NotificationPrefs = { ...prefs, [type]: { ...prefs[type], [key]: !prefs[type][key] } }
    setPrefs(next)
    setError('')
    try {
      await window.gurt.setNotificationPrefs(next)
    } catch (e) {
      setPrefs(prior)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      <div className="set-head">
        <div className="set-title-wrap">
          <span className="set-title">Notifications</span>
          <span className="set-count mono">applies across every workspace</span>
        </div>
      </div>
      <div className="set-list notif-prefs">
        <div className="notif-prefs-row notif-prefs-head">
          <span className="seclabel">TYPE</span>
          <span className="seclabel">IN-APP</span>
          <span className="seclabel">
            EXTERNAL <span className="fld-hint">— stub — not sent anywhere yet</span>
          </span>
        </div>
        {NOTIFICATION_ORDER.map((type) => {
          const p = prefs?.[type]
          const copy = NOTIFICATION_COPY[type]
          return (
            <div key={type} className="notif-prefs-row">
              <span className="set-row-label">
                {copy.label}
                <div className="fld-hint">{copy.hint}</div>
              </span>
              <button
                className={`chip-btn ${p?.inApp ? 'on' : ''}`}
                disabled={!prefs}
                onClick={run(() => toggle(type, 'inApp'))}
              >
                {p?.inApp ? 'on' : 'off'}
              </button>
              <button
                className={`chip-btn ${p?.external ? 'on' : ''}`}
                disabled={!prefs}
                onClick={run(() => toggle(type, 'external'))}
              >
                {p?.external ? 'on' : 'off'}
              </button>
            </div>
          )
        })}
      </div>
      {error && <div className="error">{error}</div>}
    </>
  )
}
