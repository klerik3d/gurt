import { taskKey } from '../../shared/keys'
import type { PlanHold } from '../../shared/planUsage'
import {
  missingRepoReason,
  repoMode,
  type SessionInfo
} from '../../shared/types'
import type { Bus } from '../bus'
import { createLogger } from '../log'
import { claimsCollide } from './pure'
import type { Claim, Session } from './types'

const log = createLogger('sessions')

// The queue and the clones: who waits for what, who holds which working tree, and
// the scheduler pass that starts what may start (docs/requirements-session-
// queue.md, docs/requirements-repo-mounts.md §2.1).

/** What queue.ts needs of the session manager: its state and the manager's own
 *  operations it calls back into. */
export interface QueueCtx {
  activeSessionCount(ws: string, task: string): number
  armLimitTimer(holds: PlanHold[], instants?: number[]): void
  readonly bus: Bus
  claims(s: Session): Claim[]
  drainPending(s: Session): Promise<void>
  earlierQueueItem(s: Session): Session | undefined
  enqueue(sessionId: string): void
  readonly frozenTasks: Set<string>
  holdsClone(s: Session): boolean
  holdText(h: PlanHold): string
  isActive(s: Session): boolean
  limitHold(s: Session): PlanHold | undefined
  noteQueued(s: Session, reason: string, by?: string): void
  readonly queuedReasons: Map<string, string>
  queuedSessions(): Session[]
  queueTime(s: Session): string
  repoConflict(s: Session): { holder: { info: Pick<SessionInfo, 'id' | 'title'> }; repo: string } | undefined
  repoHolder(s: Session): { info: Pick<SessionInfo, 'id' | 'title'> } | undefined
  schedule(): void
  readonly sessions: Map<string, Session>
  startSession(sessionId: string, by: 'user' | 'scheduler'): Promise<void>
  readonly taskCaps: Map<string, number>
  wakePass(holds: PlanHold[]): number[]
}

export function queueTime(s: Session): string {
  return (s.info.state === 'queued' ? s.info.queuedAt : s.pending[0]?.queuedAt) ?? ''
}

export function queuedSessions(mgr: QueueCtx): Session[] {
  return [...mgr.sessions.values()]
    .filter((s) => s.info.state === 'queued' || (s.info.state === 'started' && s.pending.length > 0))
    .sort((a, b) => mgr.queueTime(a).localeCompare(mgr.queueTime(b)))
}

/** Earlier work keeps its place on shared clones, including during a limit hold. */
export function earlierQueueItem(mgr: QueueCtx, s: Session): Session | undefined {
  const claims = mgr.claims(s)
  for (const other of mgr.queuedSessions()) {
    if (other === s) break
    const theirs = mgr.claims(other)
    if (!claimsCollide(theirs, claims)) continue
    return other
  }
  return undefined
}

export function queuePosition(mgr: QueueCtx, sessionId: string): number | undefined {
  const queued = mgr.queuedSessions()
  const i = queued.findIndex((s) => s.info.id === sessionId)
  return i < 0 ? undefined : i + 1
}

/** Why a queue that has something in it is not moving, when no turn is
 *  running to explain it: the clone is somebody else's. Named, because
 *  "waiting" without a who is the thing that reads as a hang. */
export function pendingBlocked(mgr: QueueCtx, s: Session): string | undefined {
  if (!s.pending.length || s.busy) return undefined
  const hold = s.info.state === 'started' ? mgr.limitHold(s) : undefined
  if (hold) return mgr.holdText(hold)
  const earlier = mgr.earlierQueueItem(s)
  if (earlier) return `waiting behind session "${earlier.info.title}"`
  const conflict = mgr.repoConflict(s)
  if (!conflict) return undefined
  return `session "${conflict.holder.info.title}" has "${conflict.repo}" — this sends as soon as it lets go`
}

/** What a queued session is waiting for, when the answer is not the generic
 *  "its turn / its clone": an account at its limit, or an earlier item on its
 *  clone. */
export function queuedWaiting(mgr: QueueCtx, s: Session): string | undefined {
  const hold = mgr.limitHold(s)
  if (hold) return mgr.holdText(hold)
  const earlier = mgr.earlierQueueItem(s)
  return earlier ? `waiting behind session "${earlier.info.title}"` : undefined
}

export function scheduleSync(mgr: QueueCtx): void {
  const queued = mgr.queuedSessions()
  // A pass may start several items; record each started item's clone claims
  // (key → exclusive?) so a later item over the same clone stays queued. A
  // blocked item reserves its claims here too: FIFO by clone, so nothing
  // behind it overtakes it on any of them (docs/requirements-repo-mounts.md
  // §2.1) — a stream of readers cannot starve a waiting writer.
  const claimed = new Map<string, boolean>()
  const reserve = (claims: Claim[]): void => {
    for (const c of claims) claimed.set(c.key, c.exclusive || claimed.get(c.key) === true)
  }
  // Same idea, per task: a pass may start several items of a capped task, so
  // each start counts against the cap for the rest of this same pass rather
  // than only against `activeSessionCount`'s (pre-pass) snapshot.
  const startedThisPass = new Map<string, number>()
  const still = new Set<string>()
  const holds: PlanHold[] = []
  for (const s of queued) {
    if (mgr.frozenTasks.has(taskKey(s.ref.workspace, s.ref.task))) continue
    // Reserve the shared clones while waiting; independent work can still run.
    const hold = mgr.limitHold(s)
    if (hold) {
      still.add(s.info.id)
      holds.push(hold)
      mgr.noteQueued(s, 'agent-limited', hold.until)
      reserve(mgr.claims(s))
      continue
    }
    if (s.info.state === 'started') {
      reserve(mgr.claims(s))
      void mgr.drainPending(s)
      continue
    }
    const tkey = taskKey(s.ref.workspace, s.ref.task)
    const cap = mgr.taskCaps.get(tkey)
    if (cap !== undefined) {
      const running = mgr.activeSessionCount(s.ref.workspace, s.ref.task) + (startedThisPass.get(tkey) ?? 0)
      if (running >= cap) {
        still.add(s.info.id)
        mgr.noteQueued(s, 'task-at-cap')
        continue
      }
    }
    // An exempt start still counts for the sessions behind it in this pass.
    const start = (): void => {
      if (cap !== undefined) startedThisPass.set(tkey, (startedThisPass.get(tkey) ?? 0) + 1)
      mgr.queuedReasons.delete(s.info.id)
      void mgr.startSession(s.info.id, 'scheduler')
    }
    if (missingRepoReason(s.info)) {
      // Still waiting too — kept in `still` so the cleanup below doesn't
      // erase the reason and re-log it on every schedule() pass.
      still.add(s.info.id)
      mgr.noteQueued(s, 'no-repo')
      continue
    }
    // A session whose repos are all `read` (or that holds none) claims no
    // clone — start it unconditionally, same pass, no FIFO contention to
    // resolve. Anything else takes all of its claims or none.
    const claims = mgr.claims(s)
    if (claims.some((c) => claimed.has(c.key) && (c.exclusive || claimed.get(c.key) === true))) {
      still.add(s.info.id)
      reserve(claims)
      mgr.noteQueued(s, 'repo-claimed-this-pass')
      continue
    }
    const conflict = mgr.repoConflict(s)
    if (conflict) {
      still.add(s.info.id)
      reserve(claims)
      mgr.noteQueued(s, 'repo-held', conflict.holder.info.id)
      continue
    }
    reserve(claims)
    start()
  }
  // Forget the reason of anything no longer waiting, so a session that queues
  // again later reports why from scratch.
  for (const id of [...mgr.queuedReasons.keys()]) {
    if (still.has(id)) continue
    mgr.queuedReasons.delete(id)
    // The pane may be showing a limit wait that just ended.
    mgr.bus.emit('session.changed', { sessionId: id })
  }
  const instants = mgr.wakePass(holds)
  mgr.armLimitTimer(holds, instants)
}

/**
 * "Why is this still queued" — logged at INF, but only when the answer
 * changes: `schedule()` runs on every container transition, and repeating an
 * unchanged reason would bury the transitions themselves.
 */
export function noteQueued(mgr: QueueCtx, s: Session, reason: string, by?: string): void {
  const key = `${reason}:${by ?? ''}`
  if (mgr.queuedReasons.get(s.info.id) === key) return
  mgr.queuedReasons.set(s.info.id, key)
  log.info('session.queued', { s: s.info.id, reason, by })
  // The pane spells some of these out (`waiting`) — it has to hear of a change.
  mgr.bus.emit('session.changed', { sessionId: s.info.id })
}

/** The clones a session claims — `(task, repo)`, shared by every session of
 *  the task that picked that repo: exclusive for a `write` mount, shared for a
 *  `read-locked` one, none for `read` (docs/requirements-repo-mounts.md §2.1).
 *  Empty for a session that holds no repo or only reads live trees. */
export function claims(s: Session): Claim[] {
  const out: Claim[] = []
  for (const repo of s.info.repos) {
    const mode = repoMode(s.info, repo)
    if (mode === 'read') continue
    out.push({ key: `${taskKey(s.ref.workspace, s.ref.task)}/${repo}`, repo, exclusive: mode === 'write' })
  }
  return out
}

/**
 * The other session currently holding one of this session's clones in a way
 * that excludes it, and which clone — readers–writer per clone: two claims
 * conflict when at least one of them is exclusive.
 *
 * A clone is one working tree shared by every session of the task that picked
 * that repo. "Holding it" means mid-start, or owning a container that is up:
 * an idle session whose container has been auto-stopped holds nothing and
 * releases the repo for the next one — which is how a task runs a series of
 * sessions against the same repo without deleting the finished ones.
 *
 * The env is *not* a constraint. Each session owns its container, so any
 * number of sessions may run the same env definition at once.
 */
export function repoConflict(mgr: QueueCtx, s: Session): { holder: { info: Pick<SessionInfo, 'id' | 'title'> }; repo: string } | undefined {
  const mine = mgr.claims(s)
  if (!mine.length) return undefined
  for (const o of mgr.sessions.values()) {
    if (o.info.id === s.info.id || !mgr.holdsClone(o)) continue
    for (const theirs of mgr.claims(o)) {
      const c = mine.find((m) => m.key === theirs.key)
      if (c && (c.exclusive || theirs.exclusive)) return { holder: o, repo: c.repo }
    }
  }
  return undefined
}

/** {@link repoConflict}'s holder alone — for the callers that only ask "may
 *  this session touch its clones right now". */
export function repoHolder(mgr: QueueCtx, s: Session): { info: Pick<SessionInfo, 'id' | 'title'> } | undefined {
  return mgr.repoConflict(s)?.holder
}

/** "Able to touch its clone / count against its task's cap": mid-start, or
 *  owning a container that is up. An idle session whose container has been
 *  auto-stopped holds nothing — shared by {@link holdsClone} and {@link
 *  activeSessionCount}. */
export function isActive(s: Session): boolean {
  const live = s.info.container?.status
  const busyContainer = live === 'building' || live === 'post' || live === 'running'
  return s.info.state === 'starting' || busyContainer
}

/** Holds its clones right now — {@link isActive}. */
export function holdsClone(mgr: QueueCtx, s: Session): boolean {
  return mgr.isActive(s)
}

/** Sessions of `(ws, task)` currently active (see {@link isActive}) —
 *  what a `maxConcurrentSessions` cap counts against. */
export function activeSessionCount(mgr: QueueCtx, ws: string, task: string): number {
  let n = 0
  for (const o of mgr.sessions.values())
    if (o.ref.workspace === ws && o.ref.task === task && mgr.isActive(o)) n++
  return n
}

/** Seed the per-task cap cache from disk. Called once at boot, before the
 *  scheduler's first pass — mirrors `review.load()`. */
export function loadTaskCaps(mgr: QueueCtx, entries: { ws: string; task: string; max?: number | undefined }[]): void {
  mgr.taskCaps.clear()
  for (const { ws, task, max } of entries)
    if (max) mgr.taskCaps.set(taskKey(ws, task), max)
}

/** Set or clear one task's cap (0/undefined = unlimited) after an edit is
 *  persisted, and re-run the scheduler — raising or clearing a cap may free
 *  sessions the queue was holding back. */
export function setTaskCap(mgr: QueueCtx, ws: string, task: string, max: number | undefined): void {
  const key = taskKey(ws, task)
  if (max) mgr.taskCaps.set(key, max)
  else mgr.taskCaps.delete(key)
  mgr.schedule()
}

/**
 * The session currently claiming this clone, addressed by (task, repo) rather
 * than by another session — a writer before any reader. Same "able to touch
 * it" rule as {@link repoConflict}: an idle session whose container is down
 * holds nothing and is not reported.
 */
export function repoHolderFor(mgr: QueueCtx, ws: string, task: string, repo: string): SessionInfo | undefined {
  const want = `${taskKey(ws, task)}/${repo}`
  let reader: SessionInfo | undefined
  for (const o of mgr.sessions.values()) {
    if (!mgr.holdsClone(o)) continue
    const c = mgr.claims(o).find((k) => k.key === want)
    if (c?.exclusive) return o.info
    if (c) reader ??= o.info
  }
  return reader
}

/**
 * Sessions whose live container is the only thing keeping a queued session
 * off its clone *or* off its task's `maxConcurrentSessions` slot, and which
 * are not themselves working — the environments nobody is claiming right
 * now. The queue handoff (kernel.ts) stops these immediately rather than
 * letting them sit out the idle grace period, which is what turns "waiting
 * for a repo/slot" from ten minutes into seconds.
 *
 * A holder that is mid-start or mid-turn is doing real work and is never
 * listed: the queue waits for it exactly as before. Empty queue → empty list,
 * so with nothing waiting the plain idle policy applies untouched.
 *
 * The task-cap half is deliberately loose, same as the repo half: any idle
 * running session of a capped task with something queued is listed, whether
 * or not stopping it actually clears *this* queued item's way (it may be
 * blocked by something else too) — an idle container was
 * headed down on its own regardless, so reaping it a little early never
 * costs anything.
 */
export function holdersBlockingQueue(mgr: QueueCtx): string[] {
  // clone key → wanted exclusively? A holder blocks only a claim it conflicts
  // with: a reader is never reaped for another reader.
  const wantedRepos = new Map<string, boolean>()
  const want = (s: Session): void => {
    for (const c of mgr.claims(s)) wantedRepos.set(c.key, c.exclusive || wantedRepos.get(c.key) === true)
  }
  const wantedTasks = new Set<string>()
  for (const s of mgr.sessions.values()) {
    if (s.info.state !== 'queued') {
      // A started session with a prompt waiting on a clone somebody else is
      // sitting on is queueing in everything but the state: it wants exactly
      // what a queued draft wants, and the same handoff is what gives it.
      // Without this its message waits out the idle grace period instead.
      if (s.pending.length && !s.busy && mgr.repoHolder(s)) want(s)
      continue
    }
    want(s)
    const tkey = taskKey(s.ref.workspace, s.ref.task)
    if (mgr.taskCaps.has(tkey)) wantedTasks.add(tkey)
  }
  if (!wantedRepos.size && !wantedTasks.size) return []
  const out: string[] = []
  for (const o of mgr.sessions.values()) {
    // A queued holder is the scheduler's business, not the reaper's: it owns
    // a container it is about to start into.
    if (o.info.state === 'queued' || o.info.state === 'starting' || o.busy || o.nudgePending) continue
    // Only a fully-up container is stoppable — one still building/post is
    // mid-provision, and `starting` above already covers its session.
    if (o.info.container?.status !== 'running') continue
    const tkey = taskKey(o.ref.workspace, o.ref.task)
    const blocks = mgr.claims(o).some(
      (c) => wantedRepos.has(c.key) && (c.exclusive || wantedRepos.get(c.key) === true)
    )
    if (blocks || wantedTasks.has(tkey)) out.push(o.info.id)
  }
  return out
}

/**
 * Run now — bypass the queue and start immediately, unless the task's
 * `maxConcurrentSessions` cap is already met: a user-initiated "run now" must
 * not blow through the same limit enqueuing exists to protect, so it falls
 * back to the queue exactly like a session the scheduler itself held back.
 */
export function startNowOrQueue(mgr: QueueCtx, sessionId: string): void {
  const s = mgr.sessions.get(sessionId)
  if (!s) return
  const cap = mgr.taskCaps.get(taskKey(s.ref.workspace, s.ref.task))
  if (cap !== undefined && mgr.activeSessionCount(s.ref.workspace, s.ref.task) >= cap) {
    mgr.enqueue(sessionId)
    return
  }
  // Same for an account at its limit: the start would only be refused, so it
  // waits in the queue for the reset like everything else on that account.
  if (mgr.limitHold(s)) {
    mgr.enqueue(sessionId)
    return
  }
  void mgr.startSession(sessionId, 'user')
}

