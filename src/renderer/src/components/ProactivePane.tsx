import { useEffect, useState } from 'react'
import type { SessionSnapshot, Tree } from '../../../shared/types'
import type { ProactiveConfig } from '../../../shared/proactive'
import { PROACTIVE_BOUNDS, isPendingScope } from '../../../shared/proactive'
import { alertDialog, confirmDialog } from '../dialog'
import { logErr } from '../log'
import { run } from '../async'
import { ConfigTab } from './ConfigTab'
import { Dot, Icon, InfoDot } from './icons'
import { OUTCOME_TONE, everyLabel, proactiveDot } from './ProactiveSidebar'

type NumberKey = keyof typeof PROACTIVE_BOUNDS
const NUMBER_KEYS = Object.keys(PROACTIVE_BOUNDS) as NumberKey[]

/** Rows a list shows before "show more", and how many more each click adds. */
const PAGE = 10

const time = (iso: string | undefined): string =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—'

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
    setNumbers(Object.fromEntries(NUMBER_KEYS.map((k) => [k, String(agent.config[k])])) as Record<NumberKey, string>)
    // Re-seeded whenever the stored config changes, and only then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey])

  const [prompt, setPrompt] = useState(template?.startPrompt ?? '')
  useEffect(() => setPrompt(template?.startPrompt ?? ''), [template?.startPrompt])

  const [advanced, setAdvanced] = useState(false)
  const [runsShown, setRunsShown] = useState(PAGE)
  const [scopesShown, setScopesShown] = useState(PAGE)

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
  /** One setting, inline in the sentence that reads it. */
  const numberInput = (key: NumberKey, label: string) => (
    <input
      type="number"
      className="tp-cap-input"
      aria-label={label}
      min={PROACTIVE_BOUNDS[key][0]}
      max={PROACTIVE_BOUNDS[key][1]}
      value={numbers[key] ?? ''}
      onChange={(e) => setNumbers((prev) => ({ ...prev, [key]: e.target.value }))}
      onBlur={() => commitNumber(key)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )

  const dot = proactiveDot(agent)
  // The scopes this agent raised that still exist; deleting one is closing it.
  const scopes = (wsData?.tasks ?? [])
    .filter((t) => t.origin?.agent === name)
    .sort((a, b) => (b.origin?.createdAt ?? '').localeCompare(a.origin?.createdAt ?? ''))
  const waiting = scopes.filter((t) => isPendingScope(t.sessions)).length

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
          <div className="seclabel-row">
            <span className="seclabel">SCHEDULE</span>
            <InfoDot
              text={
                'Runs start by themselves while the agent is on — everything a run raises waits for you ' +
                'as a draft. They happen only while gurt is open; runs missed while it was closed become one run.'
              }
            />
          </div>
          <div className="pa-phrase">
            <span>Run every</span>
            {numberInput('everyMinutes', 'run every (minutes)')}
            <span>min</span>
            <InfoDot text="Counted from the last run’s start." />
            <span className="pa-dotsep">·</span>
            <span>at most</span>
            {numberInput('maxPendingScopes', 'at most waiting scopes')}
            <span>waiting scopes</span>
            <span className="dim pa-now">
              (now {waiting}/{agent.config.maxPendingScopes})
            </span>
            <InfoDot
              text={
                'Scopes waiting for you: every session still a draft. At this many a run is skipped, and a ' +
                'run in progress raises no more — it picks up the rest next time. Launch or delete scopes to make room.'
              }
            />
          </div>
          <button type="button" className="btn-link pa-advanced" onClick={() => setAdvanced((v) => !v)}>
            <Icon name="chevron" size={11} style={advanced ? undefined : { transform: 'rotate(-90deg)' }} />
            Advanced
          </button>
          {advanced && (
            <div className="pa-phrase">
              <span>Cancel a run after</span>
              {numberInput('maxRunMinutes', 'run timeout (minutes)')}
              <span>min</span>
              <InfoDot text="A run still going after this long is cancelled and recorded as timed out." />
              <span className="pa-dotsep">·</span>
              <span>keep</span>
              {numberInput('keepRuns', 'runs kept')}
              <span>runs</span>
              <InfoDot
                text={
                  'Finished run sessions kept, to read or talk to; older ones are deleted. Their summary stays ' +
                  'in the history below.'
                }
              />
            </div>
          )}
        </div>

        <div className="tp-sep" />

        <div className="tp-section">
          <div className="seclabel-row">
            <span className="seclabel">INSTRUCTIONS</span>
            <InfoDot
              text={
                'What to watch, what to raise, and what to leave out. A scope you delete may come back on a ' +
                'later run — exclude what you never want raised here (or at the source).'
              }
            />
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
          <div className="seclabel-row">
            <span className="seclabel">RUN CONFIGURATION</span>
            <InfoDot text="Each run is a copy of this. MCP servers are its sources; repos are read-only context." />
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
          {agent.state.runs.slice(0, runsShown).map((r) => (
            <div key={r.id} className="queue-row pa-run">
              <Dot tone={OUTCOME_TONE[r.outcome]} pulse={r.outcome === 'running'} />
              <span
                className={`queue-title mono ${runSessions.has(r.id) ? 'clickable' : ''}`}
                title={runSessions.has(r.id) ? 'open the run session' : undefined}
                onClick={() => runSessions.has(r.id) && onSelectSession(r.id)}
              >
                {time(r.startedAt)}
              </span>
              <span className="tag">{r.outcome}</span>
              {r.outcome !== 'skipped' && (
                <span className="dim mono pa-counts">
                  +{r.proposed.length} raised · {r.attached.length} attached
                </span>
              )}
              <span className="pa-summary dim" title={r.error ?? r.summary}>
                {r.error ?? r.summary ?? ''}
              </span>
            </div>
          ))}
          {agent.state.runs.length > runsShown && (
            <button type="button" className="btn-link pa-more" onClick={() => setRunsShown((n) => n + PAGE * 2)}>
              show more ({agent.state.runs.length - runsShown})
            </button>
          )}
        </div>

        <div className="tp-sep" />

        <div className="tp-section">
          <div className="seclabel-row">
            <span className="seclabel">RAISED SCOPES</span>
            {scopes.length > 0 && (
              <span className="dim pa-now">
                {waiting} waiting · {scopes.length - waiting} in progress
              </span>
            )}
            <InfoDot text="Scopes this agent raised that still exist. Deleting a scope closes it." />
          </div>
          {!scopes.length && <div className="tp-dashed">nothing waiting or in progress</div>}
          {scopes.slice(0, scopesShown).map((t) => {
            const pending = isPendingScope(t.sessions)
            return (
              <div key={t.name} className="queue-row pa-scope">
                <Dot tone={pending ? 'accent' : 'green'} hollow={!pending} />
                <span className="queue-title clickable" onClick={() => onSelectTask(ws, t.name)}>
                  {t.origin?.title ?? t.name}
                </span>
                <span className="dim mono">{t.name}</span>
                <span className="spacer" />
                <span className={pending ? 'pa-state' : 'pa-state dim'}>{pending ? 'waiting for you' : 'in progress'}</span>
              </div>
            )
          })}
          {scopes.length > scopesShown && (
            <button type="button" className="btn-link pa-more" onClick={() => setScopesShown((n) => n + PAGE * 2)}>
              show more ({scopes.length - scopesShown})
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
