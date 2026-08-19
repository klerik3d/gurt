// The dashboard: what the agents have spent, what is running, and what finished
// while you were elsewhere. Read-only over state the rest of the app already
// owns — the one thing it adds is the usage ledger (see shared/usage.ts).
import { useEffect, useState } from 'react'
import type { RepoChanges, SessionInfo, Tree } from '../../../shared/types'
import { sessionStatus } from '../../../shared/types'
import type { PlanUsage, PlanWindow } from '../../../shared/planUsage'
import { STALE_AFTER_MS } from '../../../shared/planUsage'
import type { AgentUsage, TurnRecord, UsageWindow } from '../../../shared/usage'
import {
  DAY,
  agentLimits,
  agentUsage,
  formatCount,
  formatDuration,
  formatIn
} from '../../../shared/usage'
import { SESSION_DOT } from '../status'
import { agentKind, agentName, useAgents } from '../useAgents'
import { markAllSeen, markSeen, useSeen } from '../reviewed'
import { relativeTime, dateClockTime, dayClockTime } from '../time'
import { logErr } from '../log'
import { Dot, Icon } from './icons'
import { agentIcon } from './tags'

/** How many past windows the history strip draws. */
const HISTORY_BARS = 8
/** Cards a column shows before collapsing the rest into a "+N more" line. */
const COLUMN_ROWS = 12

/** A clock that only advances as fast as the meters need — windows are hours
 *  and days long, so a minute of drift on a countdown is invisible. */
function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return now
}

/**
 * Provider-reported plan limits. Polled on a slow cadence of its own: main
 * floors the endpoint at one call a minute per agent, and this is the only
 * number on the page that costs a network round-trip.
 */
function usePlanUsage(): Record<string, PlanUsage> {
  const [plan, setPlan] = useState<Record<string, PlanUsage>>({})
  useEffect(() => {
    const load = (): void => {
      window.gurt.getPlanUsage().then(setPlan).catch(logErr('getPlanUsage'))
    }
    load()
    const t = setInterval(load, 2 * 60_000)
    return () => clearInterval(t)
  }, [])
  return plan
}

/** The ledger, refetched whenever main files a turn. */
function useUsage(): TurnRecord[] {
  const [usage, setUsage] = useState<TurnRecord[]>([])
  useEffect(() => {
    const load = (): void => {
      window.gurt.getUsage().then(setUsage).catch(logErr('getUsage'))
    }
    load()
    return window.gurt.onUsageChanged(load)
  }, [])
  return usage
}

const formatMoney = (amount: number, currency?: string): string =>
  currency === 'USD' || !currency ? `$${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency}`

/** Every session in the tree, with the live overlay folded into its status. */
interface Row {
  info: SessionInfo
  status: ReturnType<typeof sessionStatus>
  /** ISO end of the session's last recorded turn — set only on `idle` rows, and
   *  the order the DONE column reads in. */
  finishedAt?: string
}

/**
 * Every status the board shows, in the order it earns attention: blocked on a
 * human first, then moving, then not started, then finished. Used both to sort
 * within a column and to decide which workspace band leads.
 */
const STATUS_RANK: Record<string, number> = {
  waiting: 0,
  running: 1,
  starting: 2,
  queued: 3,
  draft: 4,
  idle: 5
}

/**
 * The board's three columns, left to right, and the statuses each holds — a
 * session's own lifecycle read as a flow: not started yet, moving, finished.
 *
 * `queued` sits above `draft` inside the first column rather than following the
 * label's order: a queued session is next to run and carries a real position,
 * a draft has not been launched at all.
 */
export const COLUMNS = [
  { id: 'queue', label: 'DRAFT / QUEUE', statuses: ['queued', 'draft'] },
  { id: 'active', label: 'IN PROGRESS', statuses: ['waiting', 'running', 'starting'] },
  { id: 'done', label: 'DONE', statuses: ['idle'] }
] as const

/** A workspace's own board — the unit that folds. */
interface WorkspaceBoard {
  /** The workspace name, which is also the collapse key. */
  key: string
  /** One list per {@link COLUMNS} entry, in the same order. */
  columns: Row[][]
  /** Rows across all three, for the header count. */
  total: number
}

/** "2 running · 1 to review" — what a band still tells you while folded shut.
 *  Exported for scripts/dashboard-groups.test.mjs. */
export function summarize(rows: Row[]): string {
  const n = (s: string): number => rows.filter((r) => r.status === s).length
  const parts: string[] = []
  const waiting = n('waiting')
  const live = n('running') + n('starting')
  const queued = n('queued')
  const draft = n('draft')
  const done = n('idle')
  if (waiting) parts.push(`${waiting} needs you`)
  if (live) parts.push(`${live} running`)
  if (queued) parts.push(`${queued} queued`)
  if (draft) parts.push(`${draft} draft${draft > 1 ? 's' : ''}`)
  if (done) parts.push(`${done} to review`)
  return parts.join(' · ')
}

/**
 * Lay every session out as one board per workspace, most urgent workspace
 * first. A workspace leads on the best (lowest) rank it holds rather than on
 * its size: one session waiting on a permission outranks a workspace sitting on
 * five drafts.
 *
 * Rows rank by status across the whole workspace rather than bucketing by task
 * first — a task boundary in between would push the session that needs you back
 * down its column.
 *
 * Exported for scripts/dashboard-groups.test.mjs.
 */
export function boardByWorkspace(
  rows: Row[],
  positions: Record<string, number>
): WorkspaceBoard[] {
  const rank = (r: Row): number => STATUS_RANK[r.status] ?? 99
  const byKey = new Map<string, Row[]>()
  for (const r of rows) {
    const list = byKey.get(r.info.workspace)
    if (list) list.push(r)
    else byKey.set(r.info.workspace, [r])
  }
  const boards: WorkspaceBoard[] = []
  for (const [key, all] of byKey) {
    const columns = COLUMNS.map((col) =>
      all
        .filter((r) => (col.statuses as readonly string[]).includes(r.status))
        .sort((a, b) => {
          // Done reads newest-first: the thing that just landed is the thing
          // you are most likely to be looking for.
          if (col.id === 'done') return (b.finishedAt ?? '').localeCompare(a.finishedAt ?? '')
          return (
            rank(a) - rank(b) ||
            // Queue order is real order; everything else falls back to task then
            // title, so a re-render can't shuffle rows around.
            (positions[a.info.id] ?? 0) - (positions[b.info.id] ?? 0) ||
            a.info.task.localeCompare(b.info.task) ||
            a.info.title.localeCompare(b.info.title)
          )
        })
    )
    boards.push({ key, columns, total: all.length })
  }
  const best = (b: WorkspaceBoard): number =>
    Math.min(...b.columns.flat().map(rank))
  return boards.sort((a, b) => best(a) - best(b) || a.key.localeCompare(b.key))
}

const COLLAPSE_KEY = 'gurt.dashCollapsedWorkspaces'

/**
 * Which workspace groups are folded shut. Persisted, unlike the sidebar's own
 * collapse state: this pane unmounts every time the user switches to Work, and
 * a fold that undoes itself on every visit is worse than no fold at all.
 */
function useCollapsedWorkspaces(): { collapsed: Set<string>; toggle: (key: string) => void } {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]')
      return new Set(Array.isArray(raw) ? raw.filter((k) => typeof k === 'string') : [])
    } catch {
      return new Set()
    }
  })
  const toggle = (key: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]))
      } catch {
        // a full/blocked store costs the fold, not the view
      }
      return next
    })
  return { collapsed, toggle }
}

function allSessions(
  tree: Tree | null,
  activity: Record<string, { busy?: boolean; awaitingInput?: boolean }>
): Row[] {
  const rows: Row[] = []
  for (const ws of tree?.workspaces ?? [])
    for (const task of ws.tasks)
      for (const s of task.sessions) {
        const info = { ...s, ...activity[s.id] }
        rows.push({ info, status: sessionStatus(info) })
      }
  return rows
}

export function Dashboard({
  tree,
  activity,
  changes,
  positions,
  turnStarts,
  onSelectSession,
  onSelectTask
}: {
  tree: Tree | null
  activity: Record<string, { busy?: boolean; awaitingInput?: boolean }>
  /** Per-task git state, keyed `ws/task` — the review list's "how much work is
   *  sitting there" badge, already loaded by App for the sidebar. */
  changes: Record<string, RepoChanges[]>
  positions: Record<string, number>
  /** Epoch ms of the turn each busy session is in, for turns started while this
   *  window was open. Absent for a turn that predates the app's launch. */
  turnStarts: Record<string, number>
  onSelectSession: (id: string) => void
  onSelectTask: (ws: string, task: string) => void
}) {
  const agents = useAgents()
  const usage = useUsage()
  const plan = usePlanUsage()
  const seen = useSeen()
  const now = useNow()
  const { collapsed, toggle: toggleWorkspace } = useCollapsedWorkspaces()

  const rows = allSessions(tree, activity)

  // Last turn per session — the ledger is append-ordered, so the last match wins.
  const lastTurn = new Map<string, TurnRecord>()
  for (const r of usage) lastTurn.set(r.sessionId, r)

  // What the board holds. Everything unfinished goes on as-is; an `idle`
  // session earns a place in DONE only while it is unreviewed — it has run a
  // turn this install recorded, and that turn ended after the session was last
  // opened. Reviewing it is what takes it off the board, so DONE stays a
  // to-do list rather than an ever-growing archive.
  const boardRows: Row[] = rows.flatMap((r) => {
    if (r.status !== 'idle') return r.status in STATUS_RANK ? [r] : []
    const turn = lastTurn.get(r.info.id)
    if (!turn || (seen[r.info.id] && seen[r.info.id] >= turn.ts)) return []
    return [{ ...r, finishedAt: turn.ts }]
  })
  const boards = boardByWorkspace(boardRows, positions)

  // One card per agent instance, plus one per agent id that only the ledger
  // still knows — turns of a since-deleted instance are spent quota, and
  // dropping them would quietly under-count the window they landed in.
  const ledgerAgents = [...new Set(usage.map((r) => r.agent))].filter((id) => !agents[id])
  const cards = [...Object.keys(agents), ...ledgerAgents]

  return (
    <div className="dash">
      <div className="dash-body">
        <section className="dash-section">
          <div className="dash-sec-head">
            <span className="seclabel">AGENTS</span>
            <span className="dash-sec-hint">
              plan limits come from the provider; turn counts are gurt's own. Plan usage is
              pooled across every Claude surface and machine, so the two never match
            </span>
          </div>
          {cards.length === 0 && (
            <div className="tp-dashed">no agents yet — add one in Settings → Agents</div>
          )}
          <div className="dash-cards">
            {cards.map((id) => (
              <AgentCard
                key={id}
                id={id}
                label={agents[id] ? agentName(agents, id) : id || 'unassigned'}
                kind={agentKind(agents, id) ?? usage.find((r) => r.agent === id)?.kind ?? ''}
                known={!!agents[id]}
                records={usage.filter((r) => r.agent === id)}
                plan={plan[id]}
                live={rows.filter((r) => r.info.agent === id && r.status === 'running').length}
                now={now}
              />
            ))}
          </div>
        </section>

        <section className="dash-section">
          <div className="dash-sec-head">
            <span className="seclabel">SESSIONS</span>
            <span className="dash-count">{boardRows.length}</span>
            <span className="dash-sec-hint">{summarize(boardRows) || 'nothing open'}</span>
          </div>
          {boards.length === 0 && (
            <div className="tp-empty">nothing drafted, running or waiting to be reviewed</div>
          )}
          {boards.map((b) => (
            <WorkspaceBoardView
              key={b.key}
              board={b}
              agents={agents}
              changes={changes}
              lastTurn={lastTurn}
              positions={positions}
              turnStarts={turnStarts}
              now={now}
              collapsed={collapsed.has(b.key)}
              onToggle={() => toggleWorkspace(b.key)}
              onSelectSession={onSelectSession}
              onSelectTask={onSelectTask}
            />
          ))}
        </section>
      </div>
    </div>
  )
}

/** One agent instance: its limit windows, then the trailing rollups. */
function AgentCard({
  id,
  label,
  kind,
  known,
  records,
  plan,
  live,
  now
}: {
  id: string
  label: string
  kind: string
  /** The instance still exists in agents.json — a ledger-only one is history. */
  known: boolean
  records: TurnRecord[]
  /** Provider-reported limits, when this instance has a subscription token. */
  plan: PlanUsage | undefined
  live: number
  now: number
}) {
  const usage: AgentUsage = agentUsage(records, kind, now)
  const limits = agentLimits(kind)
  // The plan's own windows supersede gurt's derived one: both measure the same
  // thing and only one of them is measured. What the ledger keeps contributing
  // is the half the endpoint has no view of — turns, active time, attribution.
  const planned = plan?.windows.length ? plan : undefined
  return (
    <div className="dash-card">
      <div className="dash-card-head">
        <Icon name={agentIcon(kind)} size={15} />
        <span className="dash-card-name">{label}</span>
        <span className="dim">{kind || 'unknown kind'}</span>
        <span className="spacer" />
        {live > 0 && (
          <span className="dash-live">
            <Dot tone="green" pulse size={6} />
            {live} running
          </span>
        )}
        {!known && (
          <span className="tag" title={`no agent "${id}" in the registry any more`}>
            removed
          </span>
        )}
      </div>

      {planned && <PlanMeters plan={planned} now={now} />}
      {!planned && plan?.error && (
        <div className="dash-note">plan limits unavailable — {plan.error}</div>
      )}
      {!planned && limits.length === 0 && (
        <div className="dash-note">
          no window gurt can anchor for this kind — the rollups below are the whole picture
        </div>
      )}
      {!planned && usage.limits.map(({ def, history, open }) => {
        // A weekday alone can't tell a 7-day window's two ends apart — they
        // land on the same one.
        const bound = def.ms >= DAY ? dateClockTime : dayClockTime
        return (
        <div key={def.id} className="dash-window">
          <div className="dash-window-head">
            <span className="dash-window-label">{def.label}</span>
            {open ? (
              <span className="dim">
                {bound(open.start)} → {bound(open.end)} · resets {formatIn(open.end - now)}
              </span>
            ) : (
              <span className="faint">closed — the next turn opens a new one</span>
            )}
          </div>
          <WindowMeter window={open} now={now} />
          <div className="dash-window-foot">
            <span>{open ? `${open.turns} turns` : '0 turns'}</span>
            <span className="dim">{formatDuration(open?.ms ?? 0)} active</span>
            {!!open?.peakCtx && <span className="dim">{formatCount(open.peakCtx)} ctx peak</span>}
            {open?.cost != null && <span className="dim">{formatMoney(open.cost, open.currency)}</span>}
            {!!open?.limited && (
              <span className="red" title={open.resetAt ? `provider reset: ${open.resetAt}` : undefined}>
                limit hit {relativeTime(open.limitedAt!)}
              </span>
            )}
            <span className="spacer" />
            <span className="faint">{def.hint}</span>
          </div>
          <History windows={history} open={open} bound={bound} />
        </div>
        )
      })}

      <div className="dash-rollups">
        <Rollup label="24h" w={usage.day} />
        <Rollup
          label="7d"
          w={usage.week}
          // Trailing, NOT the plan's weekly window: that one resets at a fixed
          // time assigned to the account, which nothing gurt can see reveals.
          title="trailing 7 days — your plan's own weekly window resets at a fixed time assigned to your account, which gurt cannot see"
        />
        <span className="spacer" />
        <span className="faint">
          {usage.lastAt ? `last turn ${relativeTime(usage.lastAt)}` : 'no turns recorded yet'}
        </span>
      </div>
    </div>
  )
}

/**
 * The provider's own numbers: how much of each window is gone, and when it
 * comes back. Unlike everything else on this card these are not gurt's — they
 * cover usage from claude.ai and other machines too, which is exactly why they
 * are worth a network call.
 */
function PlanMeters({ plan, now }: { plan: PlanUsage; now: number }): JSX.Element {
  const age = plan.fetchedAt ? now - Date.parse(plan.fetchedAt) : undefined
  const stale = age !== undefined && age > STALE_AFTER_MS
  return (
    <div className="dash-plan">
      <div className="dash-plan-head">
        <span className="seclabel">PLAN</span>
        <span className="spacer" />
        {plan.error ? (
          <span className="yellow" title={plan.error}>
            {plan.fetchedAt ? `last read ${relativeTime(plan.fetchedAt)}` : plan.error}
          </span>
        ) : (
          <span className={stale ? 'yellow' : 'faint'}>
            {plan.fetchedAt ? relativeTime(plan.fetchedAt) : ''}
          </span>
        )}
      </div>
      {plan.windows.map((w) => (
        <PlanMeter key={w.id} w={w} now={now} />
      ))}
    </div>
  )
}

function PlanMeter({ w, now }: { w: PlanWindow; now: number }): JSX.Element {
  const left = w.resetsAt ? Date.parse(w.resetsAt) - now : undefined
  // Warn well before the wall: past four fifths, the remaining headroom is
  // what the user is actually deciding against.
  const tone = w.utilization >= 95 ? 'red' : w.utilization >= 80 ? 'yellow' : 'accent'
  return (
    <div className="dash-plan-row">
      <span className="dash-plan-label">{w.label}</span>
      <span className="dash-meter dash-plan-meter">
        <span
          className={`dash-meter-fill fill-${tone}`}
          style={{ width: `${Math.max(1, w.utilization)}%` }}
        />
      </span>
      <span
        className={`dash-plan-pct ${tone === 'accent' ? '' : tone}`}
        // The raw figure, so a 0–1 vs 0–100 mismatch is visible immediately
        // rather than silently drawn as 1% — see PlanWindow.utilization.
        title={`reported utilization: ${w.raw}`}
      >
        {Math.round(w.utilization)}%
      </span>
      <span className="dash-plan-reset faint">
        {left !== undefined && left > 0 ? `resets ${formatIn(left)}` : ''}
      </span>
    </div>
  )
}

/**
 * Fallback for kinds with no plan reading: fills with *elapsed window time*,
 * not consumed quota, since gurt cannot see the quota. A window that was
 * refused mid-flight is drawn red from the refusal onward, so "where the
 * overrun was" is visible without reading the numbers.
 */
function WindowMeter({ window: w, now }: { window?: UsageWindow; now: number }): JSX.Element {
  if (!w) return <div className="dash-meter dash-meter-idle" />
  const span = w.end - w.start
  const pct = (ms: number): number => Math.max(0, Math.min(100, (ms / span) * 100))
  const elapsed = pct(now - w.start)
  const hit = w.limitedAt ? pct(Date.parse(w.limitedAt) - w.start) : null
  return (
    <div className="dash-meter" title={`${w.turns} turns since ${dayClockTime(w.start)}`}>
      <span className="dash-meter-fill" style={{ width: `${elapsed}%` }} />
      {hit != null && <span className="dash-meter-hit" style={{ left: `${hit}%` }} />}
    </div>
  )
}

/** Past windows as bars, tallest = busiest. Red bars are the ones a limit
 *  refusal landed in — the "where did I overrun" strip. */
function History({
  windows,
  open,
  bound
}: {
  windows: UsageWindow[]
  open?: UsageWindow
  bound: (ms: number) => string
}): JSX.Element | null {
  const bars = windows.slice(-HISTORY_BARS)
  if (bars.length < 2) return null
  const max = Math.max(...bars.map((w) => w.turns), 1)
  return (
    <div className="dash-hist">
      {bars.map((w) => (
        <span
          key={w.start}
          className={`dash-hist-bar${w.limited ? ' limited' : ''}${w === open ? ' open' : ''}`}
          style={{ height: `${Math.max(8, (w.turns / max) * 100)}%` }}
          title={`${bound(w.start)} — ${w.turns} turns, ${formatDuration(w.ms)} active${
            w.limited ? `, ${w.limited} refused for a limit` : ''
          }`}
        />
      ))}
    </div>
  )
}

function Rollup({
  label,
  w,
  title
}: {
  label: string
  w: UsageWindow
  title?: string
}): JSX.Element {
  return (
    <span className="dash-rollup" title={title}>
      <span className="dash-rollup-label">{label}</span>
      <span>{w.turns} turns</span>
      <span className="dim">{formatDuration(w.ms)}</span>
      {w.cost != null && <span className="dim">{formatMoney(w.cost, w.currency)}</span>}
      {!!w.limited && <span className="red">{w.limited} limited</span>}
      {!!w.errors && <span className="yellow">{w.errors} failed</span>}
    </span>
  )
}

/**
 * One workspace's board: a header that folds the whole thing, and the three
 * columns beneath it. The columns live inside the band rather than once at the
 * top of the section, so each workspace is self-contained — which is also what
 * keeps them readable when the grid drops to a single column on a narrow pane.
 */
function WorkspaceBoardView({
  board,
  agents,
  changes,
  lastTurn,
  positions,
  turnStarts,
  now,
  collapsed,
  onToggle,
  onSelectSession,
  onSelectTask
}: {
  board: WorkspaceBoard
  agents: Record<string, { label: string; kind: string }>
  changes: Record<string, RepoChanges[]>
  lastTurn: Map<string, TurnRecord>
  positions: Record<string, number>
  turnStarts: Record<string, number>
  now: number
  collapsed: boolean
  onToggle: () => void
  onSelectSession: (id: string) => void
  onSelectTask: (ws: string, task: string) => void
}): JSX.Element {
  /** What each card says about itself beyond its dot. */
  const meta = (r: Row): string | undefined => {
    if (r.status === 'waiting') return 'waiting on a permission'
    if (r.status === 'queued') return `#${positions[r.info.id] ?? '?'} in queue`
    if (r.status === 'draft') return 'not started'
    if (r.status === 'idle') return r.finishedAt ? relativeTime(r.finishedAt) : undefined
    const started = turnStarts[r.info.id]
    return started ? `${formatDuration(now - started)} in this turn` : undefined
  }
  return (
    <div className="dash-group">
      <div className="dash-group-head" onClick={onToggle}>
        <span className="sb-chev">
          <Icon
            name="chevron"
            size={11}
            style={collapsed ? { transform: 'rotate(-90deg)' } : undefined}
          />
        </span>
        <span className="dash-group-name">{board.key}</span>
        <span className="dash-count">{board.total}</span>
        <span className="spacer" />
        <span className="dash-group-sum faint">{summarize(board.columns.flat())}</span>
      </div>
      {!collapsed && (
        <div className="dash-board">
          {COLUMNS.map((col, i) => {
            const rows = board.columns[i]
            const shown = rows.slice(0, COLUMN_ROWS)
            return (
              <div key={col.id} className="dash-col">
                <div className="dash-col-head">
                  <span className="seclabel">{col.label}</span>
                  {rows.length > 0 && <span className="dash-count">{rows.length}</span>}
                  <span className="spacer" />
                  {col.id === 'done' && rows.length > 0 && (
                    <button
                      className="btn-text"
                      title="clear this workspace's reviewed column"
                      onClick={() => markAllSeen(rows.map((r) => r.info.id))}
                    >
                      all reviewed
                    </button>
                  )}
                </div>
                {rows.length === 0 && <div className="dash-col-empty">—</div>}
                {shown.map((r) => (
                  <BoardCard
                    key={r.info.id}
                    row={r}
                    agents={agents}
                    meta={meta(r)}
                    turn={r.status === 'idle' ? lastTurn.get(r.info.id) : undefined}
                    changes={
                      r.status === 'idle'
                        ? changes[`${r.info.workspace}/${r.info.task}`]
                        : undefined
                    }
                    onOpen={() => onSelectSession(r.info.id)}
                    onTask={() => onSelectTask(r.info.workspace, r.info.task)}
                  />
                ))}
                {rows.length > shown.length && (
                  <div className="dash-col-empty">+{rows.length - shown.length} more</div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * One session on the board. Two lines, because a third of a pane is not enough
 * for one: the title on top, and everything that qualifies it — task, state,
 * what it left behind — underneath.
 *
 * `turn` and `changes` are passed only for the DONE column, where the question
 * is "is this worth opening" rather than "what is it doing".
 */
function BoardCard({
  row,
  agents,
  meta,
  turn,
  changes,
  onOpen,
  onTask
}: {
  row: Row
  agents: Record<string, { label: string; kind: string }>
  meta?: string
  turn?: TurnRecord
  changes?: RepoChanges[]
  onOpen: () => void
  onTask: () => void
}): JSX.Element {
  const dot = SESSION_DOT[row.status]
  const failed = turn?.outcome === 'error' || turn?.outcome === 'limited'
  // The clone's own state is the honest "is there work here" signal: a session
  // can end a clean turn and still leave nothing to review.
  const dirty = (changes ?? []).filter((c) => c.dirty || c.commits.length > 0)
  const ins = dirty.reduce((n, c) => n + c.insertions, 0)
  const del = dirty.reduce((n, c) => n + c.deletions, 0)
  return (
    <div className="dash-card-row clickable" onClick={onOpen} title={dot.label}>
      <div className="dash-card-line">
        <Dot tone={failed ? 'red' : dot.tone} pulse={dot.pulse} />
        <span className="dash-row-title">{row.info.title}</span>
        {row.info.agent && (
          <Icon
            name={agentIcon(agents[row.info.agent]?.kind)}
            size={11}
            className="faint"
            // The name would not survive the column width; the mark and its
            // tooltip carry the same fact in the space there is.
          />
        )}
      </div>
      <div className="dash-card-line dash-card-sub">
        <span
          className="dash-row-where dim clickable"
          onClick={(e) => {
            e.stopPropagation()
            onTask()
          }}
        >
          {row.info.task}
        </span>
        {meta && <span className="faint">{meta}</span>}
        {row.info.incomplete && (
          <span className="tag tag-red" title="the turn ended without a `complete` call">
            incomplete
          </span>
        )}
        {failed && (
          <span className={turn?.outcome === 'limited' ? 'red' : 'yellow'} title={turn?.detail}>
            {turn?.outcome === 'limited' ? 'hit a limit' : 'errored'}
          </span>
        )}
        {(ins > 0 || del > 0) && (
          <span className="changes-counts" title={`${dirty.length} repo(s) with work`}>
            <span className="ins">+{ins}</span> <span className="del">−{del}</span>
          </span>
        )}
        <span className="spacer" />
        {row.status === 'idle' && (
          <button
            className="btn-text dash-row-act"
            title="stop listing this session here until its next turn"
            onClick={(e) => {
              e.stopPropagation()
              markSeen(row.info.id)
            }}
          >
            reviewed
          </button>
        )}
      </div>
    </div>
  )
}
