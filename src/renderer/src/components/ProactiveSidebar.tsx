import type { Tree } from '../../../shared/types'
import type { ProactiveAgentView } from '../../../shared/proactive'
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

/** "every 10m" / "every 2h" / "every 1d 6h" */
export function everyLabel(minutes: number): string {
  if (minutes < 60) return `every ${minutes}m`
  if (minutes < 24 * 60) return minutes % 60 ? `every ${Math.floor(minutes / 60)}h ${minutes % 60}m` : `every ${minutes / 60}h`
  const d = Math.floor(minutes / (24 * 60))
  const h = Math.round((minutes % (24 * 60)) / 60)
  return h ? `every ${d}d ${h}h` : `every ${d}d`
}

/** Left sidebar of the Proactive mode: the workspace's proactive agents
 *  (docs/design-proactive-agents.md §7). */
export function ProactiveSidebar({
  tree,
  ws,
  width,
  selected,
  onSelect,
  onNew
}: {
  tree: Tree | null
  ws: string | null
  width: number
  selected: string | null
  onSelect: (name: string) => void
  onNew: () => void
}) {
  const agents = tree?.workspaces.find((w) => w.name === ws)?.proactive ?? []
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
      <div className="sb-tree" role="list" aria-label="Proactive agents">
        {agents.map((a) => {
          const dot = proactiveDot(a)
          return (
            <div
              key={a.name}
              role="listitem"
              className={`sb-session pa-row ${a.name === selected ? 'selected' : ''}`}
              title={dot.label}
              onClick={() => onSelect(a.name)}
            >
              <Dot tone={dot.tone} pulse={dot.pulse} hollow={dot.hollow} />
              <span className="sb-session-name">{a.name}</span>
              <span className="sb-session-client">{everyLabel(a.config.everyMinutes)}</span>
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
