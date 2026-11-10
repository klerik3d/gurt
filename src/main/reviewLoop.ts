// The review loop's controller (docs/requirements-review-loop.md §5, §8): thin
// wiring around `loopStep` (src/shared/reviewLoop.ts). Bus events become
// `LoopEvent`s — after the controller has read what the pure function cannot
// know (host git: the diff hash, the heads, which repos changed, which lack a
// commit text) — `loopStep` decides, the state is written to
// `<ws>/<task>/review-loop.json` BEFORE any of its intents is acted on, and
// the intents are then executed: the check, a host message, the reviewer, the
// delivery steps, the end.
//
// Two rules shape the file:
//  - A transition is synchronous. `apply` runs `loopStep` against the current
//    in-memory state and swaps it in the same tick, so the loop hold is in
//    place inside the `session.turn` `started` handler (§5.5: before the turn
//    can end) and a human act can never interleave with a half-applied step.
//    Only the *facts* a settled turn needs are gathered asynchronously, per
//    loop in order (`serial`), and the transition is applied to whatever the
//    state is when they arrive.
//  - Execution never blocks a transition. A check runs for minutes and a
//    delivery step for seconds; both run as background tasks that report back
//    with an event (`check-pass`, `delivered`), so a human act, the deadline or
//    "stop loop" is applied while they run (and stops the check's container).
//
// After a restart (§8's boot) the same machinery runs again from the files:
// `load` reads them and registers the loop holds, `recover` replays the settled
// turns the controller had not consumed, ends loops past their deadline,
// reconciles every intent that was decided and not confirmed (what is looked
// for, when it counts as done, what is redone — the table of §8, one case of
// `reconcileOne` per kind), and resumes the loop-owned sessions. Bookkeeping
// is exactly-once (an intent is confirmed once, a settled turn consumed once);
// an external effect is looked for before it is repeated, and where it cannot
// be known whether it happened the loop prefers not to repeat it (a message
// that may have reached the agent, a notification already marked sent).
import type { EnvRef, ReviewFinding, SessionInfo } from '../shared/types'
import { sessionRole, writeRepos } from '../shared/types'
import {
  REVIEW_LOOP,
  buildReviewerPrompt,
  initialLoopState,
  loopIsLive,
  loopStep,
  openRefs,
  type CheckResult,
  type LoopEvent,
  type LoopIntent,
  type LoopState,
  type ReviewedRepo
} from '../shared/reviewLoop'
import type { Bus } from './bus'
import type { SessionManager } from './sessions'
import * as store from './store'
import { cloneDir } from './store'
import * as changes from './changes'
import { hostGitAccessForRepo } from './git/env'
import { diffHash, parseDiffHash, repoTree } from './treeHash'
import { CheckRunner, type ExecChild } from './reviewCheck'
import { DeliveryError, checkDeliveryPreconditions, deliverStep, type DeliveryContext } from './delivery'
import { createLogger, errCtx } from './log'

const log = createLogger('review-loop')

/** git's empty tree: what a repo with no commit yet is "based on". */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** The reviewer is shown at most this much diff per repo (§4.3): its repos are
 *  mounted read-only, so what is cut it can read itself, and the prompt says so. */
const DIFF_CHARS_MAX = 150_000

/** The loop's clock and cadences — injectable so a test drives time itself. */
export interface ReviewLoopClock {
  now(): number
  /** How often `tick` runs (deadline, permission wait, reviewer start bound). */
  tickMs: number
  /** The loop hold's `activity` ping (§5.5). */
  keepAliveMs: number
}

export interface ReviewLoopDeps {
  bus: Bus
  sessions: SessionManager
  /** Spawn `argv` in the executor's container, in `cwd` (`ContainerManager.spawnExec`). */
  exec(sessionId: string, argv: string[], cwd: string): ExecChild
  /** The session's container record says `running` now. */
  containerUp(sessionId: string): boolean
  /** Whether the container runs now, from the daemon (`docker inspect`):
   *  `null` = could not say. Confirms a check's container stop (§5.3). */
  containerRunning(sessionId: string): Promise<boolean | null>
  /** Stop a session's container (a settled reviewer; a check — §5.3). */
  stopContainer(sessionId: string): Promise<void>
  /** Drop the loop hold and run the idle handling (`Kernel.releaseLoopHold`). */
  release(sessionId: string): void
  clock?: Partial<ReviewLoopClock>
}

export interface ReviewLoopController {
  /** Boot, first half: read every scope's `review-loop.json` (after the
   *  sessions are restored, before the scheduler's first pass) and register the
   *  loop holds of the loops that are live, or ended and not yet notified. */
  load(scopes: { ws: string; task: string }[]): Promise<void>
  /** Boot, second half (§8): replay unconsumed settled turns, end loops past
   *  their deadline, reconcile intents, resume loop-owned work. Resolves when
   *  the quick part is done; a re-run check or a delivery step carries on in the
   *  background (`idle()` waits for it). Never rejects. */
  recover(): Promise<void>
  /** Start the clock. */
  start(): void
  /** Stop it (tests, shutdown). */
  stop(): void
  /** One pass of the clock: the deadline, a long permission wait, the
   *  reviewer's start bound. */
  tick(): void
  /** The executor's loop, as a copy; undefined = no loop. */
  state(executorId: string): LoopState | undefined
  /** "Stop loop" (§5.6): ends a live loop `cancelled`. Throws when it cannot. */
  stopLoop(executorId: string): Promise<void>
  /** The open findings `complete` must answer (`SessionEvents.openFindings`). */
  openFindings(sessionId: string): string[]
  /** `LoopHooks.owns`: an executor or reviewer of a loop that has not ended. */
  owns(sessionId: string): boolean
  /** `LoopHooks.delivering`: the executors of this scope whose loop is in its
   *  delivery. */
  delivering(ws: string, task: string): string[]
  /** `LoopHooks.live`: a loop of this scope has not ended (or not yet notified). */
  live(ws: string, task: string): boolean
  /** The session's notifications are the controller's (§7): it has a Review
   *  block and its loop has not ended and notified. The notifications
   *  subscriber skips `session.proposal` and `turn-ended` for it. */
  notifiesThrough(sessionId: string): boolean
  /** A scope is going away: forget its loops without writing. */
  dropScope(ws: string, task: string): void
  dropWorkspace(ws: string): void
  /** Resolves when no transition's facts, write or intent is in flight (tests). */
  idle(): Promise<void>
}

/** What the controller keeps per loop that is not in `review-loop.json`. */
interface Runtime {
  keepAlive?: NodeJS.Timeout | undefined
  /** Facts for settled turns are gathered and applied one at a time. */
  serial: Promise<void>
  runner?: CheckRunner | undefined
  /** The check now running, so an end can stop its container. */
  check?: { intent: string; runner: CheckRunner } | undefined
  /** When the current round's reviewer was created, and whether it has run. */
  reviewerSince?: number | undefined
  reviewerStarted?: boolean | undefined
  /** The commit texts the delivery uses, kept while the executor exists: a
   *  delivery outlives a deleted executor (§5.6) and its proposal goes with it. */
  proposals?: Map<string, NonNullable<ReturnType<SessionManager['latestProposal']>>> | undefined
}

const iso = (ms: number): string => new Date(ms).toISOString()
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function createReviewLoop(deps: ReviewLoopDeps): ReviewLoopController {
  const { bus, sessions } = deps
  const clock: ReviewLoopClock = {
    now: Date.now,
    tickMs: 30_000,
    keepAliveMs: REVIEW_LOOP.keepAliveMs,
    ...deps.clock
  }
  /** Executor id → its loop. The persisted file mirrors it per scope. */
  const loops = new Map<string, LoopState>()
  const where = new Map<string, { ws: string; task: string }>()
  const runtimes = new Map<string, Runtime>()
  /** Session id → when its open permission request began (ms). */
  const awaitingSince = new Map<string, number>()
  const background = new Set<Promise<unknown>>()
  /** The scopes `load` read, for `recover`. */
  let scopesLoaded: { ws: string; task: string }[] = []
  /** Intents being reconciled after a restart (see `executeDeliver`). */
  const recovering = new Set<string>()
  let timer: NodeJS.Timeout | undefined

  const rt = (id: string): Runtime => {
    let r = runtimes.get(id)
    if (!r) runtimes.set(id, (r = { serial: Promise.resolve() }))
    return r
  }
  const track = <T>(p: Promise<T>): Promise<T> => {
    background.add(p)
    const done = (): void => void background.delete(p)
    p.then(done, done)
    return p
  }
  const refOf = (id: string): EnvRef | undefined => {
    const info = sessions.sessionInfo(id)
    return info && { workspace: info.workspace, task: info.task, env: info.env }
  }

  // --- persistence (§8) ---------------------------------------------------------

  /** Write the scope's whole file from memory. States are replaced, never
   *  mutated, so the snapshot taken here is what lands even when a later write
   *  queues behind it. A scope that is gone is not recreated by a late write. */
  function persistScope(w: { ws: string; task: string }): Promise<void> {
    if (!store.taskExists(w.ws, w.task)) return Promise.resolve()
    const file: Record<string, LoopState> = {}
    for (const [id, st] of loops) {
      const at = where.get(id)
      if (at && at.ws === w.ws && at.task === w.task) file[id] = st
    }
    return store.writeReviewLoops(w.ws, w.task, file)
  }
  const persist = (id: string): Promise<void> => {
    const w = where.get(id)
    return w ? persistScope(w) : Promise.resolve()
  }
  function mutate(id: string, fn: (s: LoopState) => LoopState): Promise<void> {
    const s = loops.get(id)
    if (!s) return Promise.resolve()
    loops.set(id, fn(s))
    return persist(id)
  }
  const confirm = (id: string, intent: string): Promise<void> =>
    mutate(id, (s) => ({ ...s, intents: s.intents.filter((i) => i.id !== intent) }))

  // --- the loop of a session ------------------------------------------------------

  /** A loop-enabled executor's loop, created on first sight ("when a loop-enabled
   *  executor starts", §8) and kept until the executor is deleted. */
  function ensureLoop(id: string): LoopState | undefined {
    const have = loops.get(id)
    if (have) return have
    const info = sessions.sessionInfo(id)
    if (!info?.review || sessionRole(info) !== 'executor') return undefined
    const st = initialLoopState(info.review, id)
    loops.set(id, st)
    where.set(id, { ws: info.workspace, task: info.task })
    void track(persist(id).catch((e: unknown) => log.error('internal.fail', { site: 'loop-create', s: id, err: errCtx(e) })))
    return st
  }

  /** Which loop a session belongs to, and as what. */
  function roleIn(sessionId: string): { executor: string; on: 'executor' | 'reviewer' } | undefined {
    if (loops.has(sessionId)) return { executor: sessionId, on: 'executor' }
    const owner = sessions.sessionInfo(sessionId)?.reviewOf?.executor
    if (owner && loops.get(owner)?.reviewer === sessionId) return { executor: owner, on: 'reviewer' }
    for (const [id, st] of loops) if (st.reviewer === sessionId) return { executor: id, on: 'reviewer' }
    return undefined
  }

  /** A reviewer whose `reviewer` intent has not yet recorded it (the intent is
   *  still creating it, or the bus is ahead of the continuation): matched by
   *  its `reviewOf` and adopted. */
  function adopt(sessionId: string): { executor: string; on: 'reviewer' } | undefined {
    const of = sessions.sessionInfo(sessionId)?.reviewOf
    const st = of && loops.get(of.executor)
    if (!of || !st || st.phase !== 'reviewing' || st.reviewer !== undefined || st.round !== of.round) return undefined
    loops.set(of.executor, { ...st, reviewer: sessionId })
    return { executor: of.executor, on: 'reviewer' }
  }

  // --- the transition -------------------------------------------------------------

  /** Feed one event to `loopStep` and carry out what follows. Synchronous. */
  function apply(id: string, event: LoopEvent): boolean {
    const before = loops.get(id)
    if (!before) return false
    const r = loopStep(before, event)
    if (r.state === before) return false
    loops.set(id, r.state)
    afterStep(id, before, r.state, r.actions)
    return true
  }

  function afterStep(id: string, before: LoopState, after: LoopState, actions: LoopIntent[]): void {
    // The loop hold follows the phase (§5.5): taken the moment the dormant
    // executor's turn starts, here, inside the `started` handler.
    if (loopIsLive(after)) hold(id)
    if (loopIsLive(before) && !loopIsLive(after) && after.phase === 'dormant') {
      // A dormant `no_changes` settle: the session is the user's again.
      stopKeepAlive(id)
      deps.release(id)
      const ref = refOf(id)
      if (ref) bus.emit('review.loop', { sessionId: id, ref, notice: { kind: 'turn-ended' } })
    }
    bus.emit('session.changed', { sessionId: id })
    void track(
      (async () => {
        // The state with its intents is on disk before any effect starts (§8).
        try {
          await persist(id)
        } catch (e) {
          log.error('internal.fail', { site: 'loop-persist', s: id, err: errCtx(e) })
          // Nothing recorded, so nothing may be done on the strength of it —
          // except ending: a fault is the one transition that must still run.
          if (actions.some((a) => a.kind === 'end')) await runActions(id, actions.filter((a) => a.kind === 'end'))
          else fault(id, `the loop's state cannot be written: ${errText(e)}`)
          return
        }
        await runActions(id, actions)
      })()
    )
  }

  const fault = (id: string, error: string): boolean => apply(id, { kind: 'fault', error })

  async function runActions(id: string, actions: LoopIntent[]): Promise<void> {
    for (const a of actions) {
      try {
        await execute(id, a)
      } catch (e) {
        log.error('internal.fail', { site: 'loop-intent', s: id, kind: a.kind, err: errCtx(e) })
        // An `end` that fails to run is already recorded; anything else is a
        // controller fault (§5.2).
        if (a.kind !== 'end') fault(id, `${a.kind}: ${errText(e)}`)
      }
    }
  }

  // --- the hold (§5.5) --------------------------------------------------------------

  function hold(id: string, keepAlive = true): void {
    try {
      sessions.holdForLoop(id)
    } catch (e) {
      log.warn('loop hold failed', { s: id, err: errCtx(e) })
      return
    }
    if (!keepAlive) return
    const r = rt(id)
    if (r.keepAlive) return
    // The pings cancel the container's idle timer so it stays up for the check
    // and the next turn (`IDLE_STOP_MS` is 10 min); the release re-arms it.
    r.keepAlive = setInterval(() => sessions.activity(id), clock.keepAliveMs)
    r.keepAlive.unref?.()
  }
  function stopKeepAlive(id: string): void {
    const r = runtimes.get(id)
    if (r?.keepAlive) clearInterval(r.keepAlive)
    if (r) r.keepAlive = undefined
  }

  // --- facts: what loopStep cannot know -----------------------------------------------

  /** The tree of a repo's base commit ('' = an unborn branch: the empty tree). */
  async function baseTree(id: string, repo: string, commit: string): Promise<string> {
    if (!commit) return EMPTY_TREE
    const w = where.get(id)!
    return changes.revParse(cloneDir(w.ws, w.task, repo), await hostGitAccessForRepo(w.ws, repo), `${commit}^{tree}`)
  }

  interface Facts {
    hash: string
    uncovered: string[]
    heads: Record<string, string>
    changed: string[]
  }

  /** The write repos' state now: the diff hash (slice 5), their HEADs (arming
   *  records them as the base), which differ from the base (from HEAD before
   *  arming) and which of those have no commit text (`proposalForRepo` finds
   *  none). */
  async function gatherFacts(id: string, st: LoopState): Promise<Facts> {
    const info = sessions.sessionInfo(id)
    const w = where.get(id)
    if (!info || !w) throw new Error('the executor is gone')
    const armed = Object.keys(st.base)
    const repos = armed.length ? armed : writeRepos(info)
    const hash = await diffHash(w.ws, w.task, repos)
    const trees = parseDiffHash(hash) ?? {}
    const heads = Object.fromEntries(repos.map((r) => [r, trees[r]?.head ?? '']))
    const changed: string[] = []
    for (const r of repos)
      if ((trees[r]?.tree ?? '') !== (await baseTree(id, r, st.base[r] ?? heads[r] ?? ''))) changed.push(r)
    const uncovered = changed.filter((r) => !sessions.latestProposal(w.ws, w.task, r))
    return { hash, uncovered, heads, changed }
  }

  async function onSettled(
    id: string,
    on: 'executor' | 'reviewer',
    turn: Extract<LoopEvent, { kind: 'settled' }>['turn']
  ): Promise<void> {
    const st = loops.get(id)
    if (!st || st.phase === 'ended') return
    let facts: Facts = { hash: '', uncovered: [], heads: {}, changed: [] }
    // A plan hold settles nothing (§5.2): no git for it.
    if (!turn.limited) {
      try {
        facts = await gatherFacts(id, st)
      } catch (e) {
        fault(id, `cannot read the repositories: ${errText(e)}`)
        return
      }
    }
    apply(id, { kind: 'settled', on, turn, now: iso(clock.now()), ...facts })
  }

  /** Run `fn` after everything queued before it for this loop. */
  function serial(id: string, fn: () => Promise<void>): void {
    const r = rt(id)
    r.serial = r.serial.then(fn).catch((e: unknown) => {
      log.error('internal.fail', { site: 'loop-event', s: id, err: errCtx(e) })
      fault(id, errText(e))
    })
    void track(r.serial)
  }

  // --- executing the intents -------------------------------------------------------------

  /** Still worth doing: an intent decided in one phase is dropped when the loop
   *  has moved on (ended) before it ran. */
  const stillLive = (id: string): boolean => {
    const s = loops.get(id)
    return !!s && s.phase !== 'ended'
  }

  async function execute(id: string, a: LoopIntent): Promise<void> {
    switch (a.kind) {
      case 'check':
        return executeCheck(id, a)
      case 'message':
        if (!stillLive(id)) return
        await sessions.hostPrompt(id, a.text, a.id)
        return confirm(id, a.id)
      case 'reviewer':
        return executeReviewer(id, a)
      case 'stop-reviewer':
        // Settled for good: the container stops, the session stays as the
        // record of the review (§5.4).
        await deps.stopContainer(a.sessionId).catch((e: unknown) => log.warn('reviewer stop failed', { s: a.sessionId, err: errCtx(e) }))
        return confirm(id, a.id)
      case 'delete-reviewer':
        sessions.deleteSession(a.sessionId)
        return confirm(id, a.id)
      case 'cancel-turn':
        // The deadline's or a permission wait's: a host act, not a human one.
        sessions.cancel(a.sessionId, 'host')
        return confirm(id, a.id)
      case 'deliver':
        return executeDeliver(id, a)
      case 'end':
        return executeEnd(id, a)
    }
  }

  function runnerFor(id: string): CheckRunner {
    const r = rt(id)
    r.runner ??= new CheckRunner({
      exec: (argv, cwd) => deps.exec(id, argv, cwd),
      // A container that is down at check time is woken through the gated path
      // a resume uses, without attaching the agent (§5.3).
      ensureContainerUp: async () => {
        if (!deps.containerUp(id)) await sessions.ensureContainerUp(id)
      },
      // Killing a check = stopping the container, confirmed by an inspect (§5.3).
      stopContainer: () => deps.stopContainer(id),
      containerRunning: () => deps.containerRunning(id)
    })
    return r.runner
  }

  async function executeCheck(id: string, a: Extract<LoopIntent, { kind: 'check' }>): Promise<void> {
    const w = where.get(id)
    if (!w || !stillLive(id)) return
    const ws = await store.getWorkspace(w.ws)
    const runner = runnerFor(id)
    const results: CheckResult[] = []
    for (const repo of a.repos) {
      const command = ws.repos.find((r) => r.name === repo)?.check?.trim()
      if (!command) continue // no check configured for this repo
      if (!stillLive(id)) return
      rt(id).check = { intent: a.id, runner }
      const run = await runner.run({ intent: a.id, repo, command })
      rt(id).check = undefined
      if (run.status === 'failed-to-run') {
        fault(id, `the check could not run: ${run.error}`)
        return
      }
      if (run.status === 'unconfirmed') {
        // The container could not be confirmed stopped, so the check may still
        // run (§5.3). The hold-and-retry is fix round 3; until then: `failed`.
        fault(id, `the check could not be stopped: ${run.detail}`)
        return
      }
      // A cancel is the loop ending (nothing to report); a timeout is a red.
      if (run.status === 'stopped' && run.reason === 'cancel') return
      results.push(run.result)
    }
    apply(id, { kind: 'check-pass', results })
    await confirm(id, a.id)
  }

  /** The reviewer's prompt for one round (§4.3), gathered from host git. */
  async function reviewerPrompt(id: string, st: LoopState, round: number): Promise<string> {
    const info = sessions.sessionInfo(id)
    const w = where.get(id)
    if (!info || !w) throw new Error('the executor is gone')
    const repos: ReviewedRepo[] = []
    for (const repo of Object.keys(st.base)) repos.push(await reviewedRepo(w, repo, st.base[repo] ?? ''))
    // The user's messages: the start prompt is the first `user` entry; later
    // ones were typed before arming (a typed message during the loop ends it).
    const typed = (sessions.snapshot(id)?.entries ?? [])
      .flatMap((e) => (e.kind === 'user' ? [e.text] : []))
      .slice(1)
    return buildReviewerPrompt({
      round,
      maxRounds: st.config.maxRounds,
      task: { prompt: info.startPrompt, typed },
      repos,
      checks: st.checks,
      rounds: st.rounds
    })
  }

  /** One write repo against its base: the same tree `diffHash` hashed (all
   *  tracked changes plus untracked, non-ignored files), so what the reviewer
   *  reads is what a commit would record. Host git, hooks and external diff
   *  drivers off (§10). */
  async function reviewedRepo(w: { ws: string; task: string }, repo: string, base: string): Promise<ReviewedRepo> {
    const dir = cloneDir(w.ws, w.task, repo)
    const access = await hostGitAccessForRepo(w.ws, repo)
    const { tree } = await repoTree(w.ws, w.task, repo)
    const from = base || EMPTY_TREE
    const diffArgs = ['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv']
    let diff = await changes.git(dir, access, [...diffArgs, from, tree])
    if (diff.length > DIFF_CHARS_MAX) {
      const cut = diff.lastIndexOf('\n', DIFF_CHARS_MAX)
      diff =
        diff.slice(0, cut > 0 ? cut : DIFF_CHARS_MAX) +
        `\n… diff truncated (${diff.length - DIFF_CHARS_MAX} more characters); the repository is mounted read-only — read the files for the rest\n`
    }
    const lines = (out: string): string[] => out.split('\n').filter(Boolean)
    const untracked = lines(await changes.git(dir, access, ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard']))
    const isNew = new Set(untracked)
    // An untracked file is `A` to a tree diff; §4.3 labels it as untracked.
    const nameStatus = lines(await changes.git(dir, access, [...diffArgs, '--name-status', from, tree])).filter(
      (l) => !(l.startsWith('A\t') && isNew.has(l.slice(2)))
    )
    return { repo, base: base || '(none)', diff, nameStatus, untracked }
  }

  async function executeReviewer(id: string, a: Extract<LoopIntent, { kind: 'reviewer' }>): Promise<void> {
    const st = loops.get(id)
    if (!st || st.phase !== 'reviewing') return
    let created: SessionInfo
    try {
      const prompt = await reviewerPrompt(id, st, a.round)
      rt(id).reviewerSince = clock.now()
      rt(id).reviewerStarted = false
      created = await sessions.createReviewer(id, { round: a.round, intent: a.id, prompt })
    } catch (e) {
      // Cannot create or start it: the loop ends, no round is retried (§5.2).
      apply(id, { kind: 'reviewer-unavailable', detail: `the reviewer could not be created: ${errText(e)}` })
      return
    }
    // The loop ended while it was being created: it must not outlive the end.
    if (!stillLive(id)) {
      sessions.deleteSession(created.id)
      return
    }
    await mutate(id, (s) => (s.reviewer === undefined ? { ...s, reviewer: created.id } : s))
    await confirm(id, a.id)
  }

  /** Remember the commit texts while the executor still has them (§5.6: it may
   *  be deleted while the delivery finishes). */
  function snapshotProposals(id: string, st: LoopState): void {
    const w = where.get(id)
    if (!w) return
    const r = rt(id)
    r.proposals ??= new Map()
    for (const repo of Object.keys(st.base)) {
      const p = sessions.latestProposal(w.ws, w.task, repo)
      if (p) r.proposals.set(repo, p)
    }
  }

  function deliveryContext(id: string, st: LoopState): DeliveryContext {
    const w = where.get(id)!
    const notes: ReviewFinding[] = st.open.filter((f) => f.severity === 'minor' || f.severity === 'nit')
    return {
      ws: w.ws,
      task: w.task,
      reviewedHash: st.reviewedHash ?? '',
      draftPr: st.config.draftPr,
      notes,
      proposalFor: (repo) => sessions.latestProposal(w.ws, w.task, repo) ?? runtimes.get(id)?.proposals?.get(repo)
    }
  }

  async function executeDeliver(id: string, a: Extract<LoopIntent, { kind: 'deliver' }>): Promise<void> {
    const st = loops.get(id)
    if (!st || st.phase !== 'delivering') return
    snapshotProposals(id, st)
    const ctx = deliveryContext(id, st)
    try {
      // Before the first step: the hash is still the reviewed one and every
      // changed repo has a commit text — else nothing is done (§6). Not when
      // this is a recovery of the first commit and HEAD has moved: that commit
      // may have happened, the hash then no longer matches by construction, and
      // the step's own probe says found-or-tree-moved (§8).
      const w = where.get(id)!
      const maybeDone =
        recovering.has(a.id) && a.step === 'commit' && (await repoTree(w.ws, w.task, a.repo)).head !== a.head
      if (st.delivered.length === 0 && !maybeDone) await checkDeliveryPreconditions(ctx, Object.keys(st.base))
      const done = await deliverStep(ctx, { repo: a.repo, step: a.step, head: a.head })
      if (done.note) log.info('delivery step note', { s: id, repo: done.repo, step: done.step, note: done.note })
      apply(id, {
        kind: 'delivered',
        step: { repo: done.repo, step: done.step, ref: done.ref, ...(done.found && done.note ? { note: done.note } : {}) }
      })
      await confirm(id, a.id)
    } catch (e) {
      const so_far = loops.get(id)?.delivered ?? []
      const err =
        e instanceof DeliveryError
          ? e.withDelivered(so_far)
          : new DeliveryError('push-failed', errText(e), a.repo, a.step, so_far)
      apply(id, { kind: 'delivery-failed', error: err.message })
    }
  }

  async function executeEnd(id: string, a: Extract<LoopIntent, { kind: 'end' }>): Promise<void> {
    const st = loops.get(id)
    stopKeepAlive(id)
    // A running check is killed by stopping the executor's container, confirmed
    // by an inspect, before anything else is released (§5.3). Unconfirmed is
    // logged here; holding and retrying is fix round 3.
    const running = runtimes.get(id)?.check
    if (running) {
      const t = await running.runner.cancel(running.intent)
      if (!t.ok) log.error('internal.fail', { site: 'check-stop', s: id, detail: t.detail })
    }
    // The loop's queued message must not run after the loop (§5.6).
    sessions.dropHostPrompts(id)
    // Idempotent, so a restart can run it again (§8, the `end` row): the
    // notification goes out once. `notified` is written BEFORE the event — a
    // crash between the two loses the notification rather than repeating it
    // (at-most-once-observable); the end itself is on disk and in the UI.
    if (!st?.notified) {
      await mutate(id, (s) => ({ ...s, notified: true }))
      const ref = refOf(id) ?? (where.get(id) && { workspace: where.get(id)!.ws, task: where.get(id)!.task, env: '' })
      const w = where.get(id)
      const subject = w
        ? (
            sessions.latestProposal(w.ws, w.task, Object.keys(st?.base ?? {})[0] ?? '') ??
            runtimes.get(id)?.proposals?.get(Object.keys(st?.base ?? {})[0] ?? '')
          )?.commit?.subject
        : undefined
      if (ref)
        bus.emit('review.loop', {
          sessionId: id,
          ref,
          notice: { kind: 'end', end: a.end, rounds: st?.round ?? 0, ...(subject ? { subject } : {}) }
        })
    }
    // Release: the hold goes, the executor runs through the idle handling and
    // the scheduler re-runs (which also lifts the delivery gate). Only then is
    // the intent done.
    deps.release(id)
    await confirm(id, a.id)
    if (!sessions.sessionInfo(id)) await forget(id)
    bus.emit('session.changed', { sessionId: id })
  }

  /** The executor is gone and its loop has ended: drop the entry. */
  async function forget(id: string): Promise<void> {
    const w = where.get(id)
    loops.delete(id)
    stopKeepAlive(id)
    runtimes.delete(id)
    where.delete(id)
    if (w) await persistScope(w)
  }

  // --- bus ------------------------------------------------------------------------------

  const human = (sessionId: string, did: 'prompt' | 'cancel' | 'stop' | 'delete'): void => {
    const t = roleIn(sessionId)
    if (t) apply(t.executor, { kind: 'human', on: t.on, did })
  }

  bus.on('session.turn', ({ sessionId, phase }) => {
    if (phase !== 'started') return
    if (ensureLoop(sessionId)) {
      apply(sessionId, { kind: 'turn-started', on: 'executor', now: iso(clock.now()) })
      return
    }
    const t = roleIn(sessionId) ?? adopt(sessionId)
    if (!t) return
    rt(t.executor).reviewerStarted = true
    apply(t.executor, { kind: 'turn-started', on: 'reviewer', now: iso(clock.now()) })
  })

  bus.on('session.settled', ({ sessionId, turn }) => {
    const t = roleIn(sessionId) ?? adopt(sessionId)
    if (t) serial(t.executor, () => onSettled(t.executor, t.on, turn))
  })

  bus.on('session.human', ({ sessionId, did }) => human(sessionId, did))
  // Only the scope pane's stop uses reason `user` (§5.6); the loop's own stops
  // (a settled reviewer, an unconfirmable check) say `idle`.
  bus.on('container.status', ({ sessionId, status, reason }) => {
    if (status === 'stopped' && reason === 'user') human(sessionId, 'stop')
  })
  bus.on('session.deleted', ({ sessionId }) => {
    awaitingSince.delete(sessionId)
    const st = loops.get(sessionId)
    if (st) {
      // An ended loop's entry goes with its executor; a delivering one finishes
      // first on the clone, which outlives the session (§5.6).
      if (st.phase === 'ended' && st.notified) void track(forget(sessionId))
      else if (st.phase !== 'delivering') human(sessionId, 'delete')
      return
    }
    for (const [ex, s] of loops) if (s.reviewer === sessionId) apply(ex, { kind: 'human', on: 'reviewer', did: 'delete' })
  })
  bus.on('session.awaiting', ({ sessionId, awaiting }) => {
    if (awaiting) awaitingSince.set(sessionId, clock.now())
    else awaitingSince.delete(sessionId)
  })
  bus.on('session.state', ({ sessionId, state, err }) => {
    if (state === 'started') {
      ensureLoop(sessionId)
      const t = roleIn(sessionId) ?? adopt(sessionId)
      if (t?.on === 'reviewer') rt(t.executor).reviewerStarted = true
    } else if (state === 'draft') {
      // A reviewer that falls back to a draft failed to start (§5.4).
      const t = roleIn(sessionId)
      if (t?.on === 'reviewer')
        apply(t.executor, { kind: 'reviewer-unavailable', detail: `the reviewer failed to start: ${err?.message ?? 'start failed'}` })
    }
  })

  // --- the clock ----------------------------------------------------------------------------

  /** The reviewer's start bound (§5.4): not `started` in 15 min, held by a plan
   *  whose reset falls after that, or a start failure. */
  function reviewerBound(id: string, st: LoopState, now: number): void {
    if (st.phase !== 'reviewing' || st.reviewer === undefined) return
    const r = rt(id)
    if (r.reviewerStarted) return
    const since = (r.reviewerSince ??= now)
    const limit = since + REVIEW_LOOP.reviewerStartMs
    const hold = sessions.planHoldOf(st.reviewer)
    if (now >= limit)
      apply(id, { kind: 'reviewer-unavailable', detail: 'the reviewer did not start within 15 minutes' })
    else if (hold?.until && Date.parse(hold.until) > limit)
      apply(id, { kind: 'reviewer-unavailable', detail: `the reviewer's account is held by a plan limit until ${hold.until}` })
  }

  function tick(): void {
    const now = clock.now()
    for (const [id, st] of [...loops]) {
      if (!loopIsLive(st)) continue
      reviewerBound(id, st, now)
      const cur = loops.get(id)
      if (!cur) continue
      const since = [id, cur.reviewer]
        .map((s) => (s === undefined ? undefined : awaitingSince.get(s)))
        .filter((t): t is number => t !== undefined)
      apply(id, {
        kind: 'tick',
        now: iso(now),
        ...(since.length ? { permissionOpenSince: iso(Math.min(...since)) } : {})
      })
    }
  }

  // --- the controller ------------------------------------------------------------------------

  // --- recovery (§8) -----------------------------------------------------------------------

  const seqOf = (turnId: string | undefined): number => {
    const n = Number(turnId?.slice(turnId.lastIndexOf(':') + 1))
    return Number.isInteger(n) ? n : 0
  }

  /** A reviewer created before the crash but not yet recorded in the state: the
   *  session carries `reviewOf.intent`, persisted before it was enqueued — adopt
   *  it, so its settle (if it finished) can be replayed and it is never created
   *  twice (§8, the `reviewer` row). */
  function adoptRecovered(id: string): void {
    const st = loops.get(id)
    const w = where.get(id)
    if (!st || !w || st.phase !== 'reviewing' || st.reviewer !== undefined) return
    const found = sessions
      .listForTask(w.ws, w.task)
      .find((i) => i.reviewOf?.executor === id && i.reviewOf.round === st.round)
    if (found) loops.set(id, { ...st, reviewer: found.id })
  }

  /** Feed the settled turns the controller had not consumed to `loopStep`,
   *  in order, before anything else (§8). */
  async function replaySettled(id: string): Promise<void> {
    const st = loops.get(id)
    if (!st || st.phase === 'ended') return
    const targets: { sid: string; on: 'executor' | 'reviewer' }[] = [{ sid: id, on: 'executor' }]
    if (st.reviewer) targets.push({ sid: st.reviewer, on: 'reviewer' })
    for (const t of targets) {
      const last = sessions.lastSettledOf(t.sid)
      const cur = loops.get(id)
      if (!last || !cur || seqOf(last.turnId) <= seqOf(cur.consumed[t.sid])) continue
      serial(id, () => onSettled(id, t.on, last))
      await rt(id).serial
    }
  }

  /** What one persisted, unconfirmed intent needs after a restart — the table of
   *  §8. Either it is found done (confirm it) or it is redone. Intents of a loop
   *  that has ended are only cleaned up: nothing new is started. */
  async function reconcileOne(id: string, a: LoopIntent): Promise<void> {
    const st = loops.get(id)
    const w = where.get(id)
    if (!st || !w) return
    const ended = st.phase === 'ended'
    switch (a.kind) {
      case 'check':
        // The leftover check's container was stopped by `stopLeftoverCheck`
        // (never "done": the check reruns, §5.3). A phase past `checking`
        // already consumed its result.
        if (ended || st.phase !== 'checking') return confirm(id, a.id)
        void track(runActions(id, [a]))
        return
      case 'message':
        // Found: waiting in the queue, taken off it (the in-flight marker) or
        // on the timeline. Not found: enqueue it.
        if (ended || !sessions.sessionInfo(id) || sessions.hostPromptSeen(id, a.id)) return confirm(id, a.id)
        return runActions(id, [a])
      case 'reviewer': {
        const found = sessions.listForTask(w.ws, w.task).find((i) => i.reviewOf?.intent === a.id)
        if (ended || st.phase !== 'reviewing' || st.round !== a.round) {
          // Created after the loop moved on, or never recorded: it must not
          // outlive the end. The reviewer the loop recorded stays as the record.
          if (found && found.id !== st.reviewer) sessions.deleteSession(found.id)
          return confirm(id, a.id)
        }
        if (!found) return runActions(id, [a])
        if (st.reviewer === undefined) await mutate(id, (x) => (x.reviewer === undefined ? { ...x, reviewer: found.id } : x))
        return confirm(id, a.id)
      }
      case 'stop-reviewer':
        if (sessions.sessionInfo(a.sessionId) && deps.containerUp(a.sessionId))
          await deps.stopContainer(a.sessionId).catch((e: unknown) => log.warn('reviewer stop failed', { s: a.sessionId, err: errCtx(e) }))
        return confirm(id, a.id)
      case 'delete-reviewer':
        if (sessions.sessionInfo(a.sessionId)) sessions.deleteSession(a.sessionId)
        return confirm(id, a.id)
      case 'cancel-turn':
        // No turn survives a restart; the interrupted flag is the user's to
        // resume or not once the loop has ended.
        return confirm(id, a.id)
      case 'deliver':
        // Found done: the state already records the step. Otherwise the step's
        // own probe looks at the clone and the remote (delivery.ts).
        if (st.phase !== 'delivering' || st.delivered.some((d) => d.repo === a.repo && d.step === a.step))
          return confirm(id, a.id)
        recovering.add(a.id)
        void track(runActions(id, [a]).finally(() => recovering.delete(a.id)))
        return
      case 'end':
        return executeEnd(id, a)
    }
  }

  /** An intent `check` found at boot was running when the app died: its
   *  process may still run in the executor's container, so the container is
   *  stopped and confirmed before anything reruns (§5.3, §8). It restarts
   *  through the attach path when the next host message needs it. Unconfirmed:
   *  a live loop ends `failed` (holding and retrying is fix round 3). */
  async function stopLeftoverCheck(id: string): Promise<void> {
    const st = loops.get(id)
    if (!st || !st.intents.some((i) => i.kind === 'check') || !deps.containerUp(id)) return
    const t = await runnerFor(id).stopContainer()
    if (!t.ok) fault(id, `a check left over from before the restart could not be stopped: ${t.detail}`)
  }

  /** Loop-owned work resumes without a human (§8): enabling the loop was the
   *  approval. A reviewer that was `starting` is restored as a draft: enqueued
   *  again with its start bound restarted. */
  function resume(id: string): void {
    const st = loops.get(id)
    if (!st || !loopIsLive(st)) return
    const go = (sid: string): void =>
      void track(sessions.resumeInterrupted(sid).catch((e: unknown) => log.warn('loop resume failed', { s: sid, err: errCtx(e) })))
    if (['dormant', 'fixing', 'proposing'].includes(st.phase)) go(id)
    if (st.phase !== 'reviewing' || st.reviewer === undefined) return
    const r = sessions.sessionInfo(st.reviewer)
    if (!r) {
      apply(id, { kind: 'reviewer-unavailable', detail: 'the reviewer session is gone' })
      return
    }
    const run = rt(id)
    if (r.state === 'draft') {
      run.reviewerSince = clock.now()
      run.reviewerStarted = false
      try {
        sessions.enqueue(r.id)
      } catch (e) {
        apply(id, { kind: 'reviewer-unavailable', detail: `the reviewer could not be started again: ${errText(e)}` })
      }
    } else if (r.state === 'started') {
      run.reviewerStarted = true
      go(r.id)
    }
  }

  async function recover(): Promise<void> {
    try {
      // A loop-enabled executor that settled a turn but whose loop file never
      // landed (the app went down right after the turn started): create it, so
      // its settle is replayed like any other.
      for (const { ws, task } of scopesLoaded)
        for (const i of sessions.listForTask(ws, task))
          if (i.review && sessionRole(i) === 'executor' && !loops.has(i.id) && sessions.lastSettledOf(i.id)) ensureLoop(i.id)
      const loaded = new Map([...loops].map(([id, st]) => [id, [...st.intents]]))
      for (const id of loops.keys()) adoptRecovered(id)
      // 1. settled turns; 2. the deadline (app-down time counts); 3. intents;
      // 4. resume — per loop, the loops independent of one another.
      for (const id of [...loops.keys()]) await replaySettled(id)
      tick()
      await Promise.all(
        [...loaded].map(async ([id, intents]) => {
          try {
            await stopLeftoverCheck(id)
            for (const a of intents) if (loops.get(id)?.intents.some((i) => i.id === a.id)) await reconcileOne(id, a)
            resume(id)
          } catch (e) {
            log.error('internal.fail', { site: 'loop-recover', s: id, err: errCtx(e) })
            fault(id, `recovery failed: ${errText(e)}`)
          }
        })
      )
    } catch (e) {
      log.error('internal.fail', { site: 'loop-recover', err: errCtx(e) })
    }
  }

  return {
    async load(scopes) {
      scopesLoaded = scopes
      for (const { ws, task } of scopes) {
        const file = await store.readReviewLoops(ws, task)
        for (const [id, st] of Object.entries(file)) {
          if (!sessions.sessionInfo(id)) continue // its executor is gone: the entry goes with the next write
          loops.set(id, st)
          where.set(id, { ws, task })
        }
        if (Object.keys(file).some((id) => !loops.has(id))) await persistScope({ ws, task })
      }
      // The holds, before the scheduler's first pass (§8): a live loop keeps its
      // clones with its container down; one that ended and has not notified
      // yet keeps them until the end has run (no keep-alive pings for that).
      for (const [id, st] of loops) {
        if (loopIsLive(st)) hold(id)
        else if (st.phase === 'ended' && !st.notified) hold(id, false)
      }
    },
    recover,
    start() {
      if (timer) return
      timer = setInterval(tick, clock.tickMs)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
      for (const id of runtimes.keys()) stopKeepAlive(id)
    },
    tick,
    state: (id) => {
      const s = loops.get(id)
      return s && structuredClone(s)
    },
    async stopLoop(id) {
      const st = loops.get(id)
      if (!st) throw new Error('this session has no review loop')
      if (st.phase === 'delivering')
        throw new Error('the loop is delivering — it cannot be stopped between steps; wait for the delivery to end')
      if (!loopIsLive(st)) return
      // Ended first, so the cancelled turn's settle finds a finished loop.
      apply(id, { kind: 'human', on: 'executor', did: 'stop' })
      sessions.cancel(id, 'host')
    },
    openFindings: (sessionId) => {
      const st = loops.get(sessionId)
      return st ? openRefs(st) : []
    },
    owns(sessionId) {
      const t = roleIn(sessionId)
      const st = t && loops.get(t.executor)
      return !!st && loopIsLive(st)
    },
    delivering(ws, task) {
      const out: string[] = []
      for (const [id, st] of loops) {
        const w = where.get(id)
        if (st.phase === 'delivering' && w?.ws === ws && w.task === task) out.push(id)
      }
      return out
    },
    live(ws, task) {
      for (const [id, st] of loops) {
        const w = where.get(id)
        if (w?.ws === ws && w.task === task && (loopIsLive(st) || (st.phase === 'ended' && !st.notified))) return true
      }
      return false
    },
    notifiesThrough(sessionId) {
      const info = sessions.sessionInfo(sessionId)
      if (!info?.review || sessionRole(info) !== 'executor') return false
      const st = loops.get(sessionId)
      return !(st?.phase === 'ended' && st.notified)
    },
    dropScope(ws, task) {
      for (const [id, w] of [...where]) {
        if (w.ws !== ws || w.task !== task) continue
        stopKeepAlive(id)
        loops.delete(id)
        where.delete(id)
        runtimes.delete(id)
      }
    },
    dropWorkspace(ws) {
      for (const [id, w] of [...where]) {
        if (w.ws !== ws) continue
        stopKeepAlive(id)
        loops.delete(id)
        where.delete(id)
        runtimes.delete(id)
      }
    },
    async idle() {
      while (background.size) await Promise.allSettled([...background])
    }
  }
}
