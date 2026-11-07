import { useEffect, useRef, useState } from 'react'
import type { ArchiveSettings } from '../../../../shared/archive'

export function ArchiveSection() {
  const [settings, setSettings] = useState<ArchiveSettings | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const pendingSave = useRef(Promise.resolve())
  useEffect(() => {
    void window.gurt.getArchiveSettings().then(setSettings).catch((e: unknown) => setError(String(e)))
  }, [])
  const save = async (patch: Partial<ArchiveSettings>): Promise<void> => {
    if (!settings) return
    const next = { ...settings, ...patch }
    setSettings(next)
    setResult('')
    const operation = pendingSave.current.catch(() => {}).then(() => window.gurt.setArchiveSettings(next))
    pendingSave.current = operation
    try { await operation } catch (e) { setError(String(e)) }
  }
  const runNow = async (): Promise<void> => {
    setBusy(true)
    setError('')
    setResult('Checking archive rules…')
    try {
      await pendingSave.current
      const r = await window.gurt.runArchivePolicy()
      setResult(r.archived || r.deleted
        ? `Done. Archived: ${r.archived}. Deleted: ${r.deleted}.`
        : 'Check complete. No scopes or archives match the enabled rules.')
      if (r.errors.length) setError(r.errors.join('\n'))
    } catch (e) { setResult(''); setError(String(e)) } finally { setBusy(false) }
  }
  return <>
    <div className="set-head"><div className="set-title-wrap">
      <span className="set-title">Archive</span>
      <span className="set-count mono">applies across every workspace</span>
    </div></div>
    <div className="set-list archive-settings">
    <div className="set-note">Keep completed scopes and sessions in the archive to free up disk space.
      Only configuration, chats and session history are kept. Repository files, dependencies and build output are excluded.</div>
      <div className="set-row">
        <span className="set-row-label">Automatically archive inactive scopes
          <div className="fld-hint">Archives scopes after all chats have been read and activity has stopped. Skips scopes with repository changes, unpushed commits, pending work or open terminals. Checks every five minutes.</div>
        </span>
        <button className={`chip-btn${settings?.autoArchive ? ' on' : ''}`} disabled={!settings || busy}
          onClick={() => { void save({ autoArchive: !settings?.autoArchive }) }}>{settings?.autoArchive ? 'on' : 'off'}</button>
      </div>
      <div className="set-row"><label className="set-row-label" htmlFor="archive-hours">No activity for (hours)</label>
        <input key={`hours-${settings?.inactiveHours}`} id="archive-hours" type="number"
          className="input archive-number" min={1} max={87600} defaultValue={settings?.inactiveHours} disabled={!settings || busy}
          onBlur={(e) => { if (e.target.value) void save({ inactiveHours: Number(e.target.value) }) }} /></div>
      <div className="set-row">
        <span className="set-row-label">Automatically delete old archives
          <div className="fld-hint">Permanently deletes unpinned archives, including their chats and session history. Age is counted from the archive date.</div>
        </span>
        <button className={`chip-btn${settings?.autoDelete ? ' on' : ''}`} disabled={!settings || busy}
          onClick={() => { void save({ autoDelete: !settings?.autoDelete }) }}>{settings?.autoDelete ? 'on' : 'off'}</button>
      </div>
      <div className="set-row"><label className="set-row-label" htmlFor="archive-days">Delete after (days)</label>
        <input key={`days-${settings?.retentionDays}`} id="archive-days" type="number"
          className="input archive-number" min={1} max={36500} defaultValue={settings?.retentionDays} disabled={!settings || busy}
          onBlur={(e) => { if (e.target.value) void save({ retentionDays: Number(e.target.value) }) }} /></div>
      <div className="archive-policy-actions">
        <button className="btn" disabled={!settings || busy || (!settings.autoArchive && !settings.autoDelete)}
          onClick={() => { void runNow() }}>{busy ? 'Working…' : 'Run rules now'}</button>
        <span className="set-note" role="status">{result || (!settings?.autoArchive && !settings?.autoDelete
          ? 'Enable a rule to run it now.' : 'Runs the enabled rules across all workspaces.')}</span>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
    </div>
  </>
}
