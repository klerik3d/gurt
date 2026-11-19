import { useEffect, useState, type ReactNode } from 'react'
import type { SessionSnapshot, Tree } from '../../../shared/types'
import {
  WATCHER_BOUNDS,
  clockText,
  formatCountdown,
  watcherActive,
  watcherStatusOf,
  type WatcherConfig
} from '../../../shared/watchers'
import { LabelTag } from './tags'
import { alertDialog, confirmDialog } from '../dialog'
import { logErr } from '../log'
import { run } from '../async'
import { ConfigTab } from './ConfigTab'
import type { ComposerNote } from './Chat'
import { Dot, Icon, InfoDot } from './icons'
import { WATCHER_TONE } from './WatcherSidebar'

type NumberKey = keyof typeof WATCHER_BOUNDS
const NUMBER_KEYS = Object.keys(WATCHER_BOUNDS) as NumberKey[]

/** One watcher (docs/requirements-watchers.md §12): its header — the state as
 *  a phrase, the actions and the settings as a phrase — above the ordinary
 *  session view. A draft shows its instructions and the Config tab instead. */
export function WatcherPane({
  tree,
  ws,
  name,
  snapshots,
  renderSession,
  onDeleted
}: {
  tree: Tree | null
  ws: string
  name: string
  snapshots: Record<string, SessionSnapshot>
  /** The watcher's session in the ordinary session view. */
  renderSession: (sessionId: string, composerNote: ComposerNote) => ReactNode
  onDeleted: () => void
}) {
  const view = tree?.workspaces.find((w) => w.name === ws)?.watchers.find((w) => w.name === name)
  const sessionId = view?.sessionId
  const [fetched, setFetched] = useState<SessionSnapshot | undefined>(undefined)
  useEffect(() => {
    setFetched(undefined)
    if (!sessionId) return
    let live = true
    window.gurt
      .sessionSnapshot(sessionId)
      .then((s) => live && setFetched(s))
      .catch(logErr('sessionSnapshot'))
    return () => {
      live = false
    }
  }, [sessionId])
  const snapshot = (sessionId && snapshots[sessionId]) || fetched

  // Countdowns and "due" phrases tick.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const [numbers, setNumbers] = useState<Record<NumberKey, string>>({} as Record<NumberKey, string>)
  const configKey = view ? JSON.stringify(view.config) : ''
  useEffect(() => {
    if (!view) return
    setNumbers(Object.fromEntries(NUMBER_KEYS.map((k) => [k, String(view.config[k])])) as Record<NumberKey, string>)
    // Re-seeded whenever the stored config changes, and only then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey])
  const [prompt, setPrompt] = useState(snapshot?.info.startPrompt ?? '')
  useEffect(() => setPrompt(snapshot?.info.startPrompt ?? ''), [snapshot?.info.startPrompt])

  if (!view) return <div className="placeholder">watcher not found</div>
  const info = snapshot?.info ?? view.session
  const config = view.config
  const w = info?.watcher
  const active = watcherActive(w)
  const draft = !info || info.state === 'draft'
  const phrase = info ? watcherStatusOf(info, config, now) : { status: 'draft' as const, tone: 'hollow' as const, text: 'not started' }
  const wake = info?.wake

  const guard = (p: Promise<unknown>): void => void p.catch((e: unknown) => alertDialog(String(e)))
  const update = (patch: Partial<WatcherConfig>): void => guard(window.gurt.watcherUpdate(ws, name, patch))
  const commitNumber = (key: NumberKey): void => {
    const n = Number(numbers[key])
    if (!Number.isFinite(n) || numbers[key].trim() === '') {
      setNumbers((prev) => ({ ...prev, [key]: String(config[key]) }))
      return
    }
    if (n !== config[key]) update({ [key]: n })
  }
  const numberInput = (key: NumberKey, label: string) => (
    <input
      type="number"
      className="tp-cap-input"
      aria-label={label}
      min={WATCHER_BOUNDS[key][0]}
      max={WATCHER_BOUNDS[key][1]}
      step={key === 'maxHours' ? 0.25 : 1}
      value={numbers[key] ?? ''}
      onChange={(e) => setNumbers((prev) => ({ ...prev, [key]: e.target.value }))}
      onBlur={() => commitNumber(key)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )

  /** Start and Re-arm are one act: the user approving the watcher's own wake turns (§8). */
  const approve = async (rearm: boolean): Promise<void> => {
    const newDeadline = !!w && Date.parse(w.deadlineAt) <= Date.now() + config.minDelayMinutes * 60_000
    const ok = await confirmDialog(
      `This watcher runs turns on its own: at most ${config.maxWakeups}` +
        `${rearm && w ? ` (${Math.max(0, config.maxWakeups - w.wakeups)} left)` : ''}, ` +
        `${rearm ? (newDeadline ? `with a new deadline ${config.maxHours} h from now` : `keeping the deadline ${w ? clockText(w.deadlineAt, Date.now()) : ''}`) : `until ${config.maxHours} h after the start`}. ` +
        'It never changes code; it reads its sources and calls you when something needs you.',
      { title: rearm ? 'Re-arm watcher' : 'Start watcher', confirmText: rearm ? 'Re-arm' : 'Start' }
    )
    if (!ok) return
    if (rearm) await window.gurt.watcherRearm(ws, name, newDeadline ? { maxHours: config.maxHours } : {})
    else await window.gurt.watcherStart(ws, name)
  }
  const stop = async (): Promise<void> => {
    const ok = await confirmDialog(
      `Stop "${name}"? It cancels the turn in flight, drops the wakeup and finishes the watcher.`,
      { title: 'Stop watcher', confirmText: 'Stop', danger: true }
    )
    if (ok) await window.gurt.watcherStop(ws, name)
  }
  const del = async (): Promise<void> => {
    const ok = await confirmDialog(`Delete the watcher "${name}"? Its conversation and container go with it.`, {
      title: 'Delete watcher',
      confirmText: 'Delete',
      danger: true
    })
    if (!ok) return
    await window.gurt.removeTask(ws, name)
    onDeleted()
  }

  const stateLine = (): string => {
    if (!w) return phrase.text
    if (w.end) return `Finished · ${w.end.outcome} — ${w.end.summary}`
    if (!config.wakeups) return wake ? `Paused — wakeup was due ${clockText(wake.at, now)}` : 'Paused'
    if (wake) {
      const left = Date.parse(wake.at) - now
      return `${left > 0 ? `Sleeping until ${clockText(wake.at, now)} (in ${formatCountdown(left)})` : `Wake due ${clockText(wake.at, now)}`} — ${wake.note}`
    }
    return phrase.text
  }

  /** The row above the composer (§5.3): the wakeup, Wake now / Cancel, Resume. */
  const composerNote: ComposerNote = {
    text: w?.end ? `finished · ${w.end.outcome} — ${w.end.summary}` : !config.wakeups ? `⏸ ${stateLine()}` : wake ? `⏰ ${stateLine()}` : stateLine(),
    hint: 'A typed message wakes the watcher early and leaves a pending wakeup in place. Esc or Cancel withdraws the wakeup; Pause stops every unattended turn.',
    actions: !active
      ? []
      : !config.wakeups
        ? [{ label: 'Resume', onClick: () => update({ wakeups: true }) }]
        : [
            {
              label: 'Wake now',
              title: "wake it now instead of at the wakeup's time",
              disabled: !!w?.final,
              onClick: () => guard(window.gurt.watcherWakeNow(ws, name))
            },
            ...(wake
              ? [{ label: 'Cancel', title: 'withdraw the pending wakeup', onClick: () => guard(window.gurt.watcherCancelWake(ws, name)) }]
              : [])
          ]
  }

  const head = (
    <div className="chat-head">
      <span className="chat-title">
        <span className="dim">{ws} /</span> {name}
      </span>
      {config.label && <LabelTag label={config.label} />}
      <Dot tone={WATCHER_TONE[phrase.tone]} pulse={phrase.status === 'working'} hollow={phrase.tone === 'hollow'} />
      <span className="dim pa-head-status">{stateLine()}</span>
      {w && (
        <span className="dim pa-head-status">
          wakeups {w.wakeups}/{config.maxWakeups} · deadline {clockText(w.deadlineAt, now)}
        </span>
      )}
      <span className="spacer" />
      {draft && !w?.end && (
        <button className="btn btn-sm btn-primary" disabled={!snapshot} onClick={run(() => approve(false))}>
          Start
        </button>
      )}
      {active && (
        <>
          <button className="btn btn-sm" onClick={() => update({ wakeups: !config.wakeups })} title={config.wakeups ? 'no unattended turn of any kind until resumed' : 'let it wake itself again'}>
            {config.wakeups ? 'Pause' : 'Resume'}
          </button>
          <button className="btn btn-sm" onClick={run(stop)}>
            Stop
          </button>
        </>
      )}
      {w?.end && (
        <button className="btn btn-sm btn-primary" onClick={run(() => approve(true))}>
          Re-arm
        </button>
      )}
      <button className="icon-sq bordered" title="delete this watcher" onClick={run(del)}>
        <Icon name="trash" size={13} />
      </button>
    </div>
  )

  const settings = (
    <div className="pa-phrase wp-settings">
      <span>At most</span>
      {numberInput('maxWakeups', 'at most wakeups')}
      <span>wakeups</span>
      <span className="pa-dotsep">·</span>
      <span>until</span>
      {numberInput('maxHours', 'deadline, hours after start')}
      <span>h after start{w ? ` (${clockText(w.deadlineAt, now)})` : ''}</span>
      <span className="pa-dotsep">·</span>
      {numberInput('minDelayMinutes', 'minimum minutes between looks')}
      <span>–</span>
      {numberInput('maxDelayMinutes', 'maximum minutes between looks')}
      <span>min apart</span>
      <InfoDot
        text={
          'A watcher runs turns on its own, only while gurt is open: a wakeup that falls due while it is ' +
          'closed fires once at the next launch. Each wake is a full-context turn, so the caps bound the cost. ' +
          'At the last wakeup or the deadline it gets one final wake and must report.'
        }
      />
    </div>
  )

  if (draft) {
    return (
      <div className="task-pane">
        {head}
        <div className="tp-body">
          <div className="tp-section">
            <div className="seclabel-row">
              <span className="seclabel">LIMITS</span>
            </div>
            {settings}
          </div>
          <div className="tp-sep" />
          <div className="tp-section">
            <div className="seclabel-row">
              <span className="seclabel">INSTRUCTIONS</span>
              <InfoDot text="What to watch, how to look, when to call you. This is the first turn; further instructions are typed into the chat." />
            </div>
            <textarea
              className="draft-prompt"
              rows={8}
              value={prompt}
              disabled={!snapshot}
              onChange={(e) => setPrompt(e.target.value)}
              onBlur={() => {
                if (snapshot && prompt !== snapshot.info.startPrompt)
                  window.gurt.sessionEditPrompt(snapshot.info.id, prompt).catch(logErr('sessionEditPrompt'))
              }}
            />
          </div>
          <div className="tp-sep" />
          <div className="tp-section">
            <div className="seclabel-row">
              <span className="seclabel">CONFIGURATION</span>
              <InfoDot text="MCP servers are its sources (Jenkins, a forge, a status page); repos are read-only. Allow the domains it needs in the network policy." />
            </div>
            {snapshot && tree ? <ConfigTab tree={tree} snapshot={snapshot} /> : <div className="tp-empty">loading…</div>}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="task-pane">
      {head}
      {settings}
      <div className="wp-session">{sessionId && renderSession(sessionId, composerNote)}</div>
    </div>
  )
}
