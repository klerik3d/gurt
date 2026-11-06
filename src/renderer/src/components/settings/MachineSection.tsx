import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { PREPARE_LOG_KEY, WELCOME_MODES } from '../../../../shared/doctor'
import { logErr } from '../../log'
import type { WelcomeMode } from '../../../../shared/doctor'
import type { GcResult, GcSettings } from '../../../../shared/gc'
import { GC_DISK_MAX, GC_DISK_MIN, GC_HOURS_MAX, GC_HOURS_MIN } from '../../../../shared/gc'
import { MachineChecklist } from '../Welcome'
import { run } from '../../async'

/** The checklist's permanent home — the same component the welcome screen
 *  embeds, so a machine that lost Docker after setup does not need an empty
 *  store to reach the rows (docs/requirements-first-run.md §2.2). */
export function MachineSection(): JSX.Element {
  const [log, setLog] = useState<string[]>([])
  const [mode, setMode] = useState<WelcomeMode | null>(null)
  const [modeError, setModeError] = useState('')
  useEffect(
    () =>
      window.gurt.onProvisionLog(({ key, line }) => {
        if (key === PREPARE_LOG_KEY) setLog((prev) => [...prev.slice(-500), line])
      }),
    []
  )
  useEffect(() => {
    window.gurt.getWelcomeMode().then(setMode).catch(logErr('getWelcomeMode'))
  }, [])
  const pick = (next: WelcomeMode) =>
    void window.gurt
      .setWelcomeMode(next)
      .then(() => {
        setMode(next)
        setModeError('')
      })
      .catch((e: unknown) => setModeError(e instanceof Error ? e.message : String(e)))
  // A fragment, like every other section: `.set-head` and `.set-list` carry
  // this page's own horizontal padding, and a wrapper between them and
  // `.set-content` is what knocks it out of alignment.
  return (
    <>
      <div className="set-head">
        <div className="set-title-wrap">
          <span className="set-title">Machine</span>
          <span className="set-count mono">what a session needs from this host</span>
        </div>
      </div>
      {/* The checklist's own head is suppressed here: this section already has
          one, and two headings stacked ("Machine" over "This machine") was
          exactly the mess. Its Re-check lives inside the list instead. */}
      <div className="set-list">
        <MachineChecklist heading={null} log={log} />
      </div>
      {/* When the welcome screen shows itself
          (docs/requirements-first-run.md §2.1.1). `always` is what a demo
          machine wants; `never` is the way out for someone who deleted their
          last session and does not want the screen back. Either way ⌘K →
          "Welcome & machine setup" still reaches it. */}
      <div className="set-list">
        <div className="set-row">
          <span className="set-row-label">Welcome screen</span>
          <span className="spacer" />
          {WELCOME_MODES.map((m) => (
            <button
              key={m}
              type="button"
              className={`btn-link ${mode === m ? 'active' : ''}`}
              title={WELCOME_MODE_HINT[m]}
              disabled={mode === null}
              onClick={() => pick(m)}
            >
              {mode === m ? `${m} ✓` : m}
            </button>
          ))}
        </div>
        <div className="set-note">
          {mode ? WELCOME_MODE_HINT[mode] : 'loading…'} · <span className="mono">GURT_WELCOME</span>{' '}
          overrides this for one run.
        </div>
        {modeError && <div className="error">{modeError}</div>}
      </div>
    </>
  )
}

/** Retention policy for the Docker resources gurt creates, and the "clean now"
 *  button. The same pass runs on its own at startup and every few hours. */
export function DockerCleanupSection(): JSX.Element {
  const [settings, setSettings] = useState<GcSettings | null>(null)
  const [result, setResult] = useState<GcResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    window.gurt.getGcSettings().then(setSettings).catch((e: unknown) => setError(String(e)))
  }, [])

  const save = async (patch: Partial<GcSettings>) => {
    if (!settings) return
    const prior = settings
    const next = { ...settings, ...patch }
    setSettings(next)
    setError('')
    try {
      await window.gurt.setGcSettings(next)
    } catch (e) {
      setSettings(prior)
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const cleanNow = async () => {
    setBusy(true)
    setError('')
    try {
      setResult(await window.gurt.gcRunNow())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const hoursField = (label: string, hint: string, key: 'stoppedContainerHours' | 'buildCacheHours') => (
    <div className="set-row">
      <span className="set-row-label">
        {label}
        <div className="fld-hint">{hint}</div>
      </span>
      <span className="spacer" />
      <input
        className="input"
        type="number"
        style={{ width: 80 }}
        min={GC_HOURS_MIN}
        max={GC_HOURS_MAX}
        disabled={!settings}
        value={settings?.[key] ?? ''}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (Number.isFinite(n) && n >= GC_HOURS_MIN) void save({ [key]: n })
        }}
      />
      <span className="faint">hours</span>
    </div>
  )
  return (
    <>
      <div className="set-head">
        <div className="set-title-wrap">
          <span className="set-title">Docker cleanup</span>
          <span className="set-count mono">frees disk used by stopped sessions, old env images and build cache</span>
        </div>
      </div>
      <div className="set-list">
        <div className="set-row">
          <span className="set-row-label">
            Automatic cleanup
            <div className="fld-hint">runs a minute after launch and every 6 hours</div>
          </span>
          <span className="spacer" />
          <button
            className={`chip-btn ${settings?.enabled ? 'on' : ''}`}
            disabled={!settings}
            onClick={run(() => save({ enabled: !settings?.enabled }))}
          >
            {settings?.enabled ? 'on' : 'off'}
          </button>
        </div>
        {hoursField(
          'Remove stopped containers after',
          'the session and its clone stay; the next start creates a fresh container',
          'stoppedContainerHours'
        )}
        <div className="set-row">
          <span className="set-row-label">
            Prune build cache
            <div className="fld-hint">
              daemon-wide — Docker cannot tell whose cache is whose, so on a shared Docker this
              also clears other projects’ build cache
            </div>
          </span>
          <span className="spacer" />
          <button
            className={`chip-btn ${settings?.pruneBuildCache ? 'on' : ''}`}
            disabled={!settings}
            onClick={run(() => save({ pruneBuildCache: !settings?.pruneBuildCache }))}
          >
            {settings?.pruneBuildCache ? 'on' : 'off'}
          </button>
        </div>
        {settings?.pruneBuildCache &&
          hoursField('Build cache older than', 'only cache unused for this long is pruned', 'buildCacheHours')}
        <div className="set-row">
          <span className="set-row-label">
            Disk-full threshold
            <div className="fld-hint">
              above this, a pass ignores the time limits: every stopped container goes and all
              unused build cache is pruned
            </div>
          </span>
          <span className="spacer" />
          <input
            className="input"
            type="number"
            style={{ width: 80 }}
            min={GC_DISK_MIN}
            max={GC_DISK_MAX}
            disabled={!settings}
            value={settings?.diskThresholdPercent ?? ''}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n) && n >= GC_DISK_MIN && n <= GC_DISK_MAX) void save({ diskThresholdPercent: n })
            }}
          />
          <span className="faint">% used</span>
        </div>
        <div className="set-note">
          Also removed on every pass: env images no container uses (only the newest build per
          environment is kept).
        </div>
        <div className="set-row">
          <button className="btn" disabled={busy} onClick={run(cleanNow)}>
            {busy ? 'Cleaning…' : 'Clean now'}
          </button>
          {result && (
            <span className="fld-hint">
              {result.skipped
                ? `skipped: ${result.skipped}`
                : `removed ${result.containers} container(s), ${result.images} image(s)` +
                  (result.buildCacheReclaimed ? `; build cache ${result.buildCacheReclaimed}` : '') +
                  (result.emergency ? ` · disk ${result.diskPercent}% full — time limits ignored` : '') +
                  ` · ${(result.ms / 1000).toFixed(1)}s`}
            </span>
          )}
        </div>
      </div>
      {error && <div className="error">{error}</div>}
    </>
  )
}

const WELCOME_MODE_HINT: Record<WelcomeMode, string> = {
  auto: 'shown until this machine has its first session',
  always: 'shown on every launch',
  never: 'only from the command palette'
}
