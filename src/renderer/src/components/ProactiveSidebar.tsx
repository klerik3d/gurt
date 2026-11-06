import { useState } from 'react'
import type { Tree } from '../../../shared/types'
import type { ProactiveAgentView, ProactiveRun } from '../../../shared/proactive'
import type { Tone } from '../status'
import { Icon, Dot } from './icons'

/** What an agent's dot says: running, on schedule, or switched off. */
export function proactiveDot(a: ProactiveAgentView): {
  tone: Tone
  pulse?: boolean
  hollow?: boolean
  label: string
} {
  if (a.activeRun) return { tone: 'green', pulse: true, label: 'running' }
  if (a.config.enabled) return { tone: 'green', label: 'on schedule' }
  return { tone: 'faint', hollow: true, label: 'off' }
}

/** A run's dot, by how it ended. */
export const OUTCOME_TONE: Record<ProactiveRun['outcome'], Tone> = {
  running: 'accent',
  skipped: 'faint',
  finished: 'green',
  incomplete: 'yellow',
  failed: 'red',
  timeout: 'red',
  cancelled: 'faint',
  interrupted: 'faint'
}

/** "every 10m" / "every 2h" / "every 1d 6h" */
export function everyLabel(minutes: number): string {
  if (minutes < 60) return `every ${minutes}m`
  if (minutes < 24 * 60) return minutes % 60 ? `every ${Math.floor(minutes / 60)}h ${minutes % 60}m` : `every ${minutes / 60}h`
  const d = Math.floor(minutes / (24 * 60))
  const h = Math.round((minutes % (24 * 60)) / 60)
  return h ? `every ${d}d ${h}h` : `every ${d}d`
}

/** A run's start: the time alone today, the date and time before. */
export function runTime(iso: string): string {
  const d = new Date(iso)
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(undefined, { timeStyle: 'short' })
    : d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
}

/** Left sidebar of the Proactive mode: the workspace's proactive agents, each
 *  a container of its kept runs, newest first (docs/design-proactive-agents.md
 *  §7). The agent opens its pane; a run opens its chat. */
export function ProactiveSidebar({
  tree,
  ws,
  width,
  selected,
  selectedRun,
  onSelect,
  onSelectRun,
  onNew
}: {
  tree: Tree | null
  ws: string | null
  width: number
  selected: string | null
  selectedRun: string | null
  onSelect: (name: string) => void
  onSelectRun: (id: string) => void
  onNew: () => void
}) {
  const agents = tree?.workspaces.find((w) => w.name === ws)?.proactive ?? []
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const toggle = (name: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(name)) next.add(name)
      return next
    })
  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sb-head">
        <div className="sb-ws">
          <span className="sb-ws-name">Proactive agents</span>
        </div>
        <span className="spacer" />
        <button className="icon-sq" title="New proactive agent" aria-label="New proactive agent" onClick={onNew}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      <div className="sb-tree" role="tree" aria-label="Proactive agents">
        {agents.map((a) => {
          const dot = proactiveDot(a)
          const open = !collapsed.has(a.name)
          const records = new Map(a.state.runs.map((r) => [r.id, r]))
          // The run sessions still kept, by their history entry; the history
          // itself (skips, collected runs) is the agent pane's.
          const runs = a.sessions
            .filter((s) => !s.template)
            .map((s) => ({ session: s, record: records.get(s.id) }))
            .sort((x, y) =>
              (y.record?.startedAt ?? y.session.title).localeCompare(x.record?.startedAt ?? x.session.title)
            )
          return (
            <div key={a.name} className="sb-group">
              <div
                className={`sb-task pa-row ${a.name === selected && !selectedRun ? 'selected' : ''}`}
                role="treeitem"
                aria-expanded={open}
                aria-selected={a.name === selected && !selectedRun}
                title={dot.label}
                onClick={() => onSelect(a.name)}
              >
                <span
                  className="sb-chev"
                  onClick={(e) => {
                    e.stopPropagation()
                    toggle(a.name)
                  }}
                >
                  <Icon name="chevron" size={11} style={open ? undefined : { transform: 'rotate(-90deg)' }} />
                </span>
                <Dot tone={dot.tone} pulse={dot.pulse} hollow={dot.hollow} />
                <span className="sb-task-name">{a.name}</span>
                <span className="spacer" />
                <span className="sb-session-client">{a.config.cron ?? everyLabel(a.config.everyMinutes)}</span>
              </div>
              {open &&
                runs.map(({ session: s, record: r }) => {
                  const outcome = r?.outcome ?? (a.activeRun === s.id ? 'running' : undefined)
                  return (
                    <div
                      key={s.id}
                      className={`sb-session pa-run-row ${s.id === selectedRun ? 'selected' : ''}`}
                      role="treeitem"
                      aria-selected={s.id === selectedRun}
                      title={outcome ?? s.title}
                      onClick={() => onSelectRun(s.id)}
                    >
                      <Dot
                        tone={outcome ? OUTCOME_TONE[outcome] : 'faint'}
                        pulse={outcome === 'running'}
                        hollow={!outcome}
                      />
                      <span className="sb-session-name">{r ? runTime(r.startedAt) : s.title}</span>
                      {r && r.proposed.length > 0 && (
                        <span className="sb-session-client">+{r.proposed.length}</span>
                      )}
                    </div>
                  )
                })}
              {open && !runs.length && <div className="sb-empty">no runs yet</div>}
            </div>
          )
        })}
        {tree && !agents.length && (
          <div className="sb-empty pa-empty">
            No proactive agents yet. One watches a source on a schedule and raises scopes with draft
            sessions for you to launch — “+” to add one.
          </div>
        )}
      </div>
    </aside>
  )
}
