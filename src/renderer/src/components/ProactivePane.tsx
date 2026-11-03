import { useEffect, useState } from 'react'
import type { SessionSnapshot, Tree } from '../../../shared/types'
import type { ProactiveConfig, ProactiveRun } from '../../../shared/proactive'
import { PROACTIVE_BOUNDS, isPendingScope } from '../../../shared/proactive'
import { alertDialog, confirmDialog } from '../dialog'
import { logErr } from '../log'
import { run } from '../async'
import { ConfigTab } from './ConfigTab'
import { Dot, Icon } from './icons'
import { everyLabel, proactiveDot } from './ProactiveSidebar'

type NumberKey = keyof typeof PROACTIVE_BOUNDS

/** The settings row, in the order they are read: when it runs, then what it
 *  may do per run, then what it keeps. */
const NUMBER_FIELDS: { key: NumberKey; label: string; hint: string }[] = [
  { key: 'everyMinutes', label: 'every (minutes)', hint: 'one run this often, counted from the last run’s start' },
  { key: 'maxScopesPerRun', label: 'scopes per run', hint: 'how many scopes one run may raise' },
  {
    key: 'maxPendingScopes',
    label: 'waiting scopes',
    hint: 'scopes you have not acted on yet (every session still a draft); at this many the agent defers instead of raising more'
  },
  { key: 'maxRunMinutes', label: 'run timeout (minutes)', hint: 'a run still going after this long is cancelled' },
  { key: 'keepRuns', label: 'runs kept', hint: 'finished run sessions kept for inspection; older ones are deleted, their summary stays below' }
]

const time = (iso: string | undefined): string =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—'

const OUTCOME_TONE: Record<ProactiveRun['outcome'], 'green' | 'yellow' | 'red' | 'accent' | 'faint'> = {
  running: 'accent',
  finished: 'green',
  incomplete: 'yellow',
  failed: 'red',
  timeout: 'red',
  cancelled: 'faint',
  interrupted: 'faint'
}

/** One proactive agent: its schedule, its template's instructions and
 *  configuration, its runs, and what it raised (docs/design-proactive-agents.md
 *  §7). */
export function ProactivePane({
  tree,
  ws,
  name,
  snapshots,
  onSelectSession,
  onSelectTask,
  onDeleted
}: {
  tree: Tree | null
  ws: string
  name: string
  snapshots: Record<string, SessionSnapshot>
  onSelectSession: (id: string) => void
  onSelectTask: (ws: string, task: string) => void
  onDeleted: () => void
}) {
  const wsData = tree?.workspaces.find((w) => w.name === ws)
  const agent = wsData?.proactive.find((a) => a.name === name)
  const templateId = agent?.config.templateId
  const template = agent?.sessions.find((s) => s.id === templateId)
  const runSessions = new Set(agent?.sessions.map((s) => s.id) ?? [])

  // The template's full snapshot (ConfigTab reads one); kept fresh by the
  // `session-changed` pushes App folds into `snapshots`.
  const [fetched, setFetched] = useState<SessionSnapshot | undefined>(undefined)
  useEffect(() => {
    setFetched(undefined)
    if (!templateId) return
    let live = true
    window.gurt
      .sessionSnapshot(templateId)
      .then((s) => live && setFetched(s))
      .catch(logErr('sessionSnapshot'))
    return () => {
      live = false
    }
  }, [templateId])
  const snapshot = (templateId && snapshots[templateId]) || fetched

  const [numbers, setNumbers] = useState<Record<NumberKey, string>>(
    {} as Record<NumberKey, string>
  )
  const configKey = agent ? JSON.stringify(agent.config) : ''
  useEffect(() => {
    if (!agent) return
    setNumbers(
      Object.fromEntries(NUMBER_FIELDS.map((f) => [f.key, String(agent.config[f.key])])) as Record<NumberKey, string>
    )
    // Re-seeded whenever the stored config changes, and only then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey])

  const [prompt, setPrompt] = useState(template?.startPrompt ?? '')
  useEffect(() => setPrompt(template?.startPrompt ?? ''), [template?.startPrompt])

  if (!agent) return <div className="placeholder">proactive agent not found</div>

  const update = (patch: Partial<ProactiveConfig>): void => {
    window.gurt.proactiveUpdate(ws, name, patch).catch((e: unknown) => alertDialog(String(e)))
  }
  const commitNumber = (key: NumberKey): void => {
    const n = Number(numbers[key])
    if (!Number.isFinite(n) || numbers[key].trim() === '') {
      setNumbers((prev) => ({ ...prev, [key]: String(agent.config[key]) }))
      return
    }
    if (n !== agent.config[key]) update({ [key]: n })
  }

  const dot = proactiveDot(agent)
  const scopes = (wsData?.tasks ?? [])
    .filter((t) => t.origin?.agent === name)
    .sort((a, b) => (b.origin?.createdAt ?? '').localeCompare(a.origin?.createdAt ?? ''))
  const now = Date.now()
  const deferrals = agent.state.deferrals.filter((d) => Date.parse(d.until) > now)
  const tombstones = agent.state.tombstones

  const del = async (): Promise<void> => {
    const ok = await confirmDialog(
      `Delete the proactive agent "${name}"? Its template, its runs and its history go with it. ` +
        'The scopes it raised stay.',
      { title: 'Delete proactive agent', confirmText: 'Delete', danger: true }
    )
    if (!ok) return
    await window.gurt.removeTask(ws, name)
    onDeleted()
  }

  return (
    <div className="task-pane">
      <div className="chat-head">
        <span className="chat-title">
          <span className="dim" style={{ fontWeight: 400 }}>
            {ws} /
          </span>{' '}
          {name}
        </span>
        <Dot tone={dot.tone} pulse={dot.pulse} hollow={dot.hollow} />
        <span className="dim pa-head-status">
          {agent.activeRun
            ? 'running now'
            : agent.config.enabled
              ? `${everyLabel(agent.config.everyMinutes)} · next ${time(agent.nextRunAt)}`
              : 'off'}
        </span>
        <span className="spacer" />
        <button
          className={`btn btn-sm ${agent.config.enabled ? '' : 'btn-primary'}`}
          onClick={() => update({ enabled: !agent.config.enabled })}
          title={agent.config.enabled ? 'stop running on schedule' : 'start running on schedule'}
        >
          {agent.config.enabled ? 'Turn off' : 'Turn on'}
        </button>
        <button
          className="btn btn-sm"
          disabled={!!agent.activeRun}
          title={agent.activeRun ? 'a run is going' : 'start one run now, whatever the schedule says'}
          onClick={run(() =>
            window.gurt
              .proactiveRunNow(ws, name)
              .then(() => undefined)
              .catch((e: unknown) => alertDialog(String(e)))
          )}
        >
          Run now
        </button>
        <button className="icon-sq bordered" title="delete this proactive agent" onClick={run(del)}>
          <Icon name="trash" size={13} />
        </button>
      </div>

      <div className="tp-body">
        <div className="tp-section">
          <span className="seclabel">SCHEDULE AND LIMITS</span>
          <div className="pa-numbers">
            {NUMBER_FIELDS.map((f) => (
              <label key={f.key} className="pa-number" title={f.hint}>
                <span className="tp-sec-hint">{f.label}</span>
                <input
                  type="number"
                  className="tp-cap-input"
                  min={PROACTIVE_BOUNDS[f.key][0]}
                  max={PROACTIVE_BOUNDS[f.key][1]}
                  value={numbers[f.key] ?? ''}
                  onChange={(e) => setNumbers((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  onBlur={() => commitNumber(f.key)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                />
              </label>
            ))}
          </div>
          <div className="tp-sec-hint">
            Runs start only while gurt is open; runs missed while it was closed become one run. Its
            runs start by themselves — everything a run raises waits for you as a draft.
          </div>
        </div>

        <div className="tp-sep" />

        <div className="tp-section">
          <div className="tp-sec-head">
            <span className="seclabel">INSTRUCTIONS</span>
            <span className="tp-sec-hint">· what to watch, what to raise, what to defer</span>
          </div>
          <textarea
            className="draft-prompt"
            rows={8}
            value={prompt}
            disabled={!template}
            onChange={(e) => setPrompt(e.target.value)}
            onBlur={() => {
              if (template && prompt !== template.startPrompt)
                window.gurt.sessionEditPrompt(template.id, prompt).catch(logErr('sessionEditPrompt'))
            }}
          />
        </div>

        <div className="tp-sep" />

        <div className="tp-section">
          <div className="tp-sec-head">
            <span className="seclabel">RUN CONFIGURATION</span>
            <span className="tp-sec-hint">
              · each run is a copy of this; MCP servers are its sources, repos are read-only context
            </span>
          </div>
          {snapshot && tree ? (
            <ConfigTab tree={tree} snapshot={snapshot} />
          ) : (
            <div className="tp-empty">{template ? 'loading…' : 'the template session is missing'}</div>
          )}
        </div>

        <div className="tp-sep" />

        <div className="tp-section">
          <span className="seclabel">RUNS</span>
          {!agent.state.runs.length && <div className="tp-dashed">no runs yet</div>}
          {agent.state.runs.map((r) => (
            <div key={r.id} className="queue-row pa-run">
              <Dot tone={OUTCOME_TONE[r.outcome]} pulse={r.outcome === 'running'} />
              <span
                className={`queue-title mono ${runSessions.has(r.id) ? 'clickable' : ''}`}
                title={runSessions.has(r.id) ? 'open the run session' : 'the run session was collected'}
                onClick={() => runSessions.has(r.id) && onSelectSession(r.id)}
              >
                {time(r.startedAt)}
              </span>
              <span className="tag">{r.outcome}</span>
              <span className="dim mono pa-counts">
                +{r.proposed.length} raised · {r.attached.length} attached · {r.deferred} deferred
              </span>
              <span className="pa-summary dim" title={r.error ?? r.summary}>
                {r.error ?? r.summary ?? ''}
              </span>
            </div>
          ))}
        </div>

        <div className="tp-sep" />

        <div className="tp-section">
          <span className="seclabel">RAISED SCOPES</span>
          {!scopes.length && <div className="tp-dashed">nothing raised yet</div>}
          {scopes.map((t) => (
            <div key={t.name} className="queue-row">
              <Dot tone={isPendingScope(t.sessions) ? 'accent' : 'faint'} hollow={!isPendingScope(t.sessions)} />
              <span className="queue-title clickable" onClick={() => onSelectTask(ws, t.name)}>
                {t.origin?.title ?? t.name}
              </span>
              <span className="dim mono">{t.name}</span>
              <span className="spacer" />
              <span className="tp-sec-hint">
                {isPendingScope(t.sessions) ? 'waiting for you' : 'taken up'} · {t.origin?.refs.length ?? 0} refs
              </span>
            </div>
          ))}
        </div>

        <div className="tp-sep" />

        <div className="tp-section">
          <div className="tp-sec-head">
            <span className="seclabel">DEFERRED</span>
            <span className="tp-sec-hint">· {deferrals.length} hidden from runs until their time</span>
          </div>
          {deferrals.slice(-100).reverse().map((d) => (
            <div key={d.ref} className="queue-row">
              <span className="queue-title mono">{d.ref}</span>
              <span className="dim pa-summary" title={d.reason}>
                {d.reason}
              </span>
              <span className="spacer" />
              <span className="tp-sec-hint">until {time(d.until)}</span>
              <button
                className="btn btn-xs"
                title="the next run sees it as new"
                onClick={run(() =>
                  window.gurt.proactiveUndefer(ws, name, d.ref).catch((e: unknown) => alertDialog(String(e)))
                )}
              >
                Look again
              </button>
            </div>
          ))}
        </div>

        {tombstones.length > 0 && (
          <>
            <div className="tp-sep" />
            <div className="tp-section">
              <div className="tp-sec-head">
                <span className="seclabel">DISMISSED</span>
                <span className="tp-sec-hint">· refs of scopes you deleted — not raised again</span>
              </div>
              {tombstones.slice(-100).reverse().map((t) => (
                <div key={t.ref} className="queue-row">
                  <span className="queue-title mono">{t.ref}</span>
                  <span className="dim mono">{t.scope}</span>
                  <span className="spacer" />
                  <button
                    className="btn btn-xs"
                    title="let the agent raise it again"
                    onClick={run(() =>
                      window.gurt.proactiveForget(ws, name, t.ref).catch((e: unknown) => alertDialog(String(e)))
                    )}
                  >
                    Allow again
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
