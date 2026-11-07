import { useEffect, useState } from 'react'
import type { ArchiveSettings } from '../../../../shared/archive'

export function ArchiveSection() {
  const [settings, setSettings] = useState<ArchiveSettings | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  useEffect(() => {
    void window.gurt.getArchiveSettings().then(setSettings).catch((e: unknown) => setError(String(e)))
  }, [])
  const save = async (patch: Partial<ArchiveSettings>): Promise<void> => {
    if (!settings) return
    setBusy(true)
    setError('')
    try {
      await window.gurt.setArchiveSettings({ ...settings, ...patch })
      setSettings(await window.gurt.getArchiveSettings())
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  return <>
    <div className="set-title">Archive</div>
    <div className="set-note">Archive keeps chats, agent history and repository data in compressed form.
      Containers and generated session mounts are recreated after restoring. Pinned archives are protected from deletion.</div>
    <div className="set-card">
      <div className="set-row">
        <span className="set-row-label">Automatically archive inactive scopes
          <div className="fld-hint">Only read scopes with clean repositories and no unpushed work, queued prompts or open terminals. Checked every five minutes.</div>
        </span><span className="spacer" />
        <button className={`chip-btn${settings?.autoArchive ? ' on' : ''}`} disabled={!settings || busy}
          onClick={() => { void save({ autoArchive: !settings?.autoArchive }) }}>{settings?.autoArchive ? 'on' : 'off'}</button>
      </div>
      <div className="set-row"><label className="set-row-label" htmlFor="archive-hours">No activity for (hours)</label>
        <span className="spacer" /><input key={`hours-${settings?.inactiveHours}`} id="archive-hours" type="number"
          className="input" min={1} max={87600} defaultValue={settings?.inactiveHours} disabled={!settings || busy}
          onBlur={(e) => { if (e.target.value) void save({ inactiveHours: Number(e.target.value) }) }} /></div>
      <div className="set-row">
        <span className="set-row-label">Automatically delete old archives
          <div className="fld-hint">Permanently deletes unpinned archives, including their chats and repositories. Age is counted from the archive date.</div>
        </span><span className="spacer" />
        <button className={`chip-btn${settings?.autoDelete ? ' on' : ''}`} disabled={!settings || busy}
          onClick={() => { void save({ autoDelete: !settings?.autoDelete }) }}>{settings?.autoDelete ? 'on' : 'off'}</button>
      </div>
      <div className="set-row"><label className="set-row-label" htmlFor="archive-days">Delete after (days)</label>
        <span className="spacer" /><input key={`days-${settings?.retentionDays}`} id="archive-days" type="number"
          className="input" min={1} max={36500} defaultValue={settings?.retentionDays} disabled={!settings || busy}
          onBlur={(e) => { if (e.target.value) void save({ retentionDays: Number(e.target.value) }) }} /></div>
      <div className="set-row"><button className="btn" disabled={!settings || busy} onClick={() => {
        setBusy(true); setError('')
        void window.gurt.runArchivePolicy().then((r) => setResult(`Archived ${r.archived}; deleted ${r.deleted}.`))
          .catch((e: unknown) => setError(String(e))).finally(() => setBusy(false))
      }}>{busy ? 'Working…' : 'Run rules now'}</button><span className="fld-hint">{result}</span></div>
    </div>
    {error && <div className="error" role="alert">{error}</div>}
  </>
}
