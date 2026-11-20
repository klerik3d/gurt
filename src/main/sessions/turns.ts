import type { Vocabulary } from '../../shared/agentVocabulary'
import type { PlanHold } from '../../shared/planUsage'
import type { SettledTurn } from '../../shared/reviewLoop'
import {
  roleHasTurnContract,
  sessionRole,
  type ChatEntry,
  type ChatEntryBase,
  type EnvRef,
  type PromptContext,
  type PromptImage,
  type SessionInfo
} from '../../shared/types'
import { isLimitReply, limitResetAt, turnOutcome, usageFields } from '../../shared/usage'
import {
  isWakeOrigin,
  wakeTaken,
  watcherActive,
  watcherTurnSatisfied,
  withoutWatch
} from '../../shared/watchers'
import { PROMPT_RESULT } from '../acp'
import type { Bus } from '../bus'
import { createLogger } from '../log'
import type { PiiMask } from '../pii'
import { isLoopSession, loopOf } from './pure'
import { contractToolFor, nudgePromptFor, postTurnDecision, turnHow } from './turnContract'
import type {
  Connection,
  LoopHooks,
  PendingPrompt,
  PostTurnAction,
  Session,
  SessionEvents,
  TurnHow,
  TurnResult,
  TurnTrack
} from './types'

const log = createLogger('sessions')

// Turns: one prompt round-trip (`sendTurn`), the logical turn around it with its
// nudge and its classification (`runPrompt`, `settleTurn`), and the drain loop
// that feeds a session's queue into them (docs/requirements-turn-contract.md,
// docs/requirements-session-queue.md).

/** What turns.ts needs of the session manager: its state and the manager's own
 *  operations it calls back into. */
export interface TurnsCtx {
  readonly agentKinds: Map<string, string>
  assertNotStopped(s: Session): void
  attach(s: Session): Promise<Connection>
  readonly bus: Bus
  clearLimited(s: Session): void
  decideTurn(s: Session, outcome: TurnResult, isNudge: boolean): PostTurnAction
  deliveryActive(s: Session): boolean
  drainPending(s: Session): Promise<void>
  earlierQueueItem(s: Session): Session | undefined
  readonly events: SessionEvents
  isWakeWork(p: PendingPrompt): boolean
  limitHold(s: Session): PlanHold | undefined
  readonly loopHooks: LoopHooks | undefined
  readonly mask: PiiMask
  maskEnabled(): boolean
  onLimited(s: Session, limit: { resetAt?: string | undefined }): string
  onWakeFailed(s: Session, reason: string): void
  onWatcherIncomplete(s: Session): void
  persistNow(s: Session): Promise<void>
  promptBlocks(s: Session, text: string, context?: PromptContext[], images?: PromptImage[]): unknown[]
  push(s: Session, entry: ChatEntryBase): ChatEntry
  repoHolder(s: Session): { info: Pick<SessionInfo, 'id' | 'title'> } | undefined
  reportTurn(s: Session, startedAt: number, outcome: TurnResult, detail?: string): void
  runPrompt(s: Session, text: string, context?: PromptContext[], images?: PromptImage[], loop?: string): Promise<void>
  schedule(): void
  schedulePersist(ref: EnvRef): void
  sendTurn(s: Session, text: string, entryKind: 'user' | 'system', isNudge: boolean, context?: PromptContext[], images?: PromptImage[], loop?: string): Promise<TurnResult>
  readonly sessions: Map<string, Session>
  settleTurn(s: Session, turn: TurnTrack, how: TurnHow): Promise<void>
  vocabulary(s: Session): Vocabulary
  watcherPaused(s: Session): boolean
  withLimit(s: Session, outcome: TurnResult, detail: string | undefined, firstEntry: number): TurnResult
}

/** Build the ACP prompt content blocks: the message text, a `resource_link` for
 *  every attached context item, and an `image` block per attached image (only sent
 *  when the agent advertised `promptCapabilities.image`). Context paths are resolved
 *  against the container workspace folder so the agent gets an absolute `file://` uri. */
export function promptBlocks(s: Session,
  text: string,
  context?: PromptContext[],
  images?: PromptImage[]): unknown[] {
  const blocks: unknown[] = [{ type: 'text', text }]
  for (const c of context ?? []) {
    const uri = c.path.startsWith('git:')
      ? c.path
      : `file://${c.path.startsWith('/') ? c.path : `${s.remoteCwd ?? '.'}/${c.path}`}`
    blocks.push({ type: 'resource_link', uri, name: c.name })
  }
  for (const img of images ?? [])
    blocks.push({ type: 'image', mimeType: img.mimeType, data: img.data })
  return blocks
}

/**
 * Run one prompt turn end-to-end: push its timeline entry (a `user` message or,
 * for the nudge, a `system` line), reset the turn-complete flag, run
 * `session/prompt`, and surface a non-`end_turn` stop or a thrown error. Returns
 * the raw turn outcome the enforcement decision consumes.
 */
export async function sendTurn(mgr: TurnsCtx, s: Session,
  text: string,
  entryKind: 'user' | 'system',
  isNudge: boolean,
  context?: PromptContext[],
  images?: PromptImage[],
  /** The review loop's intent id, when this turn is one of its host messages
   *  (shown as a `system` entry that carries it). */
  loop?: string): Promise<TurnResult> {
  mgr.bus.emit('session.activity', { sessionId: s.info.id })
  // The one outbound seam (§2.1): from here on the agent only ever sees
  // tokens, and the timeline records the same tokenized text — the chat view
  // reveals it from the table. A detector that is down must end the turn with
  // a visible error, never silently send the cleartext; the error is held
  // until the `try` below so it is reported like any other turn failure.
  let outbound = text
  let maskError: Error | undefined
  if (mgr.maskEnabled()) {
    try {
      outbound = await mgr.mask.encode(s.info.id, text)
    } catch (e) {
      maskError = e instanceof Error ? e : new Error(String(e))
    }
  }
  const promptEntry = mgr.push(
    s,
    loop === undefined ? { kind: entryKind, text: outbound } : { kind: 'system', text: outbound, loop }
  )
  // Prompt start: the turn is incomplete until `complete` fires; clear any
  // prior violation overlay.
  s.turnComplete = false
  s.turnRejected = false
  s.info.incomplete = undefined
  s.busy = true
  s.turns++
  // Where this turn's own entries start — the limit detector reads the
  // agent's reply from here on.
  const firstEntry = s.nextEntryId
  mgr.bus.emit('session.changed', { sessionId: s.info.id })
  mgr.bus.emit('session.turn', { sessionId: s.info.id, ref: s.ref, phase: 'started' })
  const startedAt = Date.now()
  // Defaults to "threw" (→ final=true) so an unexpected throw between here and
  // the assignments below never reports a user-visible turn end as non-final.
  let outcome: TurnResult = { threw: true }
  // What the accounting record reports as the turn's ending — a non-`end_turn`
  // stop or the thrown error's message, i.e. exactly the text the limit
  // detector needs to tell "the plan said no" from "the code broke".
  let detail: string | undefined
  s.interrupted = true
  try {
    await mgr.persistNow(s)
  } catch (err) {
    s.busy = false
    s.recovering = true
    throw err
  }
  try {
    if (maskError) throw maskError
    mgr.assertNotStopped(s)
    const conn = await mgr.attach(s)
    // A review-loop host message lands as a `system` entry — not a rewind point.
    if (promptEntry.kind === 'user') await mgr.events.snapshotCheckpoint?.(s.info, promptEntry.id)
    const preface = s.preface
    // Everything above was asynchronous: a Stop may have landed meanwhile.
    mgr.assertNotStopped(s)
    // The start's own prompt: the end-to-end start phase ends at the first
    // update the agent sends back for it (`onSessionUpdate`).
    if (s.startTiming) s.startTiming.promptSent = true
    const result = await conn.peer.request(
      'session/prompt',
      {
        sessionId: s.acpSessionId,
        prompt: [
          ...(preface ? [{ type: 'text', text: preface }] : []),
          ...mgr.promptBlocks(s, outbound, context, images)
        ]
      },
      PROMPT_RESULT
    )
    // Only once the agent has taken it: a failed send keeps it for the retry.
    if (preface && s.preface === preface) {
      s.preface = undefined
      mgr.schedulePersist(s.ref)
    }
    const reason = result.stopReason ?? undefined
    s.lastStopReason = reason
    if (reason && reason !== 'end_turn') {
      mgr.push(s, { kind: 'system', text: `stopped: ${reason}` })
      detail = reason
    }
    outcome = mgr.withLimit(s, { stopReason: reason, threw: false }, detail, firstEntry)
    return outcome
  } catch (e) {
    s.lastStopReason = 'error'
    log.warn('turn failed', { s: s.info.id, err: e })
    detail = e instanceof Error ? e.message : String(e)
    mgr.push(s, { kind: 'system', text: `error: ${detail}` })
    outcome = mgr.withLimit(s, { threw: true }, detail, firstEntry)
    return outcome
  } finally {
    // Decided and published before `busy` drops: the persist below yields, and
    // a queue event in that gap must already see the session as awaiting its
    // nudge. False only for the nudge turn's own boundary — the healing
    // follow-up runPrompt is about to send, not the user-visible end of the
    // turn. See the `final` field on `session.turn` in shared/events.ts.
    const final = mgr.decideTurn(s, outcome, isNudge) !== 'nudge'
    s.nudgePending = !final
    s.busy = false
    s.interrupted = false
    await mgr.persistNow(s)
    mgr.bus.emit('session.changed', { sessionId: s.info.id })
    mgr.schedulePersist(s.ref)
    mgr.reportTurn(s, startedAt, outcome, detail)
    mgr.bus.emit('session.turn', { sessionId: s.info.id, ref: s.ref, phase: 'ended', final })
  }
}

/**
 * File one finished round-trip with the usage ledger. Accounting only: it
 * never touches session state, and a kind it cannot resolve (an agent deleted
 * from the registry mid-run) is recorded with an empty kind rather than
 * dropped — the turn happened either way, and a card that shows it under
 * "unknown agent" beats a window that silently under-counts.
 */
export function reportTurn(mgr: TurnsCtx, s: Session,
  startedAt: number,
  outcome: TurnResult,
  detail?: string): void {
  const agent = s.info.agent ?? ''
  const resetAt = outcome.limit?.resetAt
  mgr.bus.emit('agent.turn', {
    ts: new Date().toISOString(),
    agent,
    kind: mgr.agentKinds.get(agent) ?? '',
    sessionId: s.info.id,
    workspace: s.ref.workspace,
    task: s.ref.task,
    ms: Date.now() - startedAt,
    outcome: outcome.limit ? 'limited' : turnOutcome({ ...outcome, detail }, mgr.vocabulary(s).limits),
    ...usageFields(s.usage),
    ...(detail ? { detail } : {}),
    ...(resetAt ? { resetAt } : {})
  })
}

/** Post-turn decision for this session: `postTurnDecision` with the role's
 *  contract folded in — a researcher or inspector is never offered `complete`, so
 *  it is never nudged for skipping it. */
export function decideTurn(s: Session, outcome: TurnResult, isNudge: boolean): PostTurnAction {
  return postTurnDecision({
    ...outcome,
    limited: !!outcome.limit,
    // A watcher's contract is its state, not a tool call of this turn (§7).
    turnComplete: s.info.role === 'watcher' ? watcherTurnSatisfied(s.info, Date.now()) : s.turnComplete,
    isNudge,
    hasContract:
      roleHasTurnContract(sessionRole(s.info)) &&
      (sessionRole(s.info) !== 'watcher' || watcherActive(s.info.watcher))
  })
}

/**
 * The limit detector: did the provider, not the code, end this turn? Three
 * signals, any one of which is enough —
 *
 *   - a live rate-limit event during the turn said `rejected`;
 *   - the thrown error / non-`end_turn` stop reads like a limit
 *     (`turnOutcome`'s patterns, unchanged);
 *   - the agent's whole reply is a short limit notice — some adapters answer
 *     a refused turn with one ("You've hit your limit · resets 3pm") as
 *     ordinary text and a clean `end_turn`, which neither of the above would
 *     see.
 *
 * The last two read the session's agent's own wording (its plugin's
 * `limits`) on top of the generic patterns.
 *
 * Logged with the signal that fired, so a miss or a false hit can be traced
 * back to what the adapter actually sent.
 */
export function withLimit(mgr: TurnsCtx, s: Session, outcome: TurnResult, detail: string | undefined, firstEntry: number): TurnResult {
  const reply = s.entries
    .flatMap((e) => (e.id >= firstEntry && e.kind === 'agent' ? [e.text] : []))
    .join('\n')
  const limits = mgr.vocabulary(s).limits
  const signal = s.turnRejected
    ? 'rate-limit-event'
    : turnOutcome({ ...outcome, detail }, limits) === 'limited'
      ? 'error-text'
      : isLimitReply(reply, limits)
        ? 'agent-reply'
        : undefined
  if (!signal) return outcome
  const resetAt = limitResetAt(detail, limits) ?? limitResetAt(reply, limits)
  log.info('turn.limited', { s: s.info.id, agent: s.info.agent, signal, resetAt })
  return { ...outcome, limit: { ...(resetAt ? { resetAt } : {}) } }
}

/**
 * Send a user prompt, then enforce the turn contract. A turn that ends cleanly
 * without a `complete` call is a protocol violation: because the ACP session is
 * still alive, one automatic follow-up (`NUDGE_PROMPT`) costs seconds and usually
 * heals it. A nudge turn that still skips `complete` marks the session
 * `incomplete` and gives up — no second nudge. Roles without the contract
 * (researcher, inspector, operator) skip all of this: their turns just end.
 */
export async function runPrompt(mgr: TurnsCtx, s: Session,
  text: string,
  context?: PromptContext[],
  images?: PromptImage[],
  loop?: string): Promise<void> {
  s.promptRunning = true
  const startedAt = Date.now()
  s.turnStartedAt = startedAt
  const fromWake = s.info.role === 'watcher' && s.ranOrigin === 'wake'
  s.turnGuard = fromWake || (s.info.role === 'watcher' && !!s.guardStart)
  s.guardStart = undefined
  // The logical turn: this prompt and its nudge (docs/requirements-review-
  // loop.md §5.1). Opened before the first await so the contract tools can
  // file into it once a round-trip is busy; closed in the `finally`, whatever
  // happened. Only a loop session has one — the record, its write and its
  // event are the loop's, and any other session's turn ends as it always did.
  const turn: TurnTrack | undefined = isLoopSession(s.info)
    ? { id: `${s.info.id}:${++s.turnSeq}` }
    : undefined
  s.turn = turn
  // Until the body says how it ended, it threw.
  let how: TurnHow = { failed: { stopReason: 'error' }, incomplete: false }
  try {
    const first = await mgr.sendTurn(s, text, 'user', false, context, images, loop)
    if (first.limit) {
      how = { limited: { until: mgr.onLimited(s, first.limit) }, incomplete: false }
      return
    }
    if (!first.threw) mgr.clearLimited(s)
    if (fromWake && watcherActive(s.info.watcher)) {
      const failed = first.threw || (!!first.stopReason && first.stopReason !== 'end_turn' && first.stopReason !== 'cancelled')
      if (failed) mgr.onWakeFailed(s, first.threw ? 'the turn failed' : `stopped: ${first.stopReason}`)
    }
    if (mgr.decideTurn(s, first, false) !== 'nudge') {
      // The whole logical turn went through: the failure streak ends (§7).
      if (fromWake && first.stopReason === 'end_turn') s.wakeFailures = 0
      how = turnHow(first, false)
      return
    }
    const second = await mgr.sendTurn(
      s,
      nudgePromptFor(sessionRole(s.info), !!s.info.watcher?.final),
      'system',
      true
    )
    if (second.limit) {
      how = { limited: { until: mgr.onLimited(s, second.limit) }, incomplete: false }
      return
    }
    // The nudge turn failing leaves a watcher blind just as the first would (§7).
    if (fromWake && watcherActive(s.info.watcher)) {
      const failed = second.threw || (!!second.stopReason && second.stopReason !== 'end_turn' && second.stopReason !== 'cancelled')
      if (failed) mgr.onWakeFailed(s, second.threw ? 'the turn failed' : `stopped: ${second.stopReason}`)
      else if (second.stopReason === 'end_turn') s.wakeFailures = 0
    }
    const incomplete = mgr.decideTurn(s, second, true) === 'incomplete'
    if (incomplete) {
      mgr.push(s, { kind: 'system', text: `turn ended without ${contractToolFor(sessionRole(s.info))}` })
      s.info.incomplete = true
      if (sessionRole(s.info) === 'watcher') mgr.onWatcherIncomplete(s)
      mgr.bus.emit('session.changed', { sessionId: s.info.id })
      mgr.schedulePersist(s.ref)
    }
    how = turnHow(second, incomplete)
  } finally {
    s.nudgePending = false
    // A turn the user cancelled leaves nothing scheduled that it scheduled
    // itself: its last `wake_me` may land after the cancel (§5.3).
    if (s.info.watcher) {
      if (s.cancelledAt && s.cancelledAt >= startedAt && s.info.wake && Date.parse(s.info.wake.setAt) >= startedAt) {
        s.info.wake = undefined
        mgr.schedulePersist(s.ref)
      }
      const cur = s.info.watcher
      if (s.cancelledAt && s.cancelledAt >= startedAt && cur?.watch && Date.parse(cur.watch.setAt) >= startedAt) {
        s.info.watcher = withoutWatch(cur)
        mgr.schedulePersist(s.ref)
      }
      s.cancelledAt = undefined
    }
    // An ordinary session drops `promptRunning` right here, with no write and
    // no event in between, exactly as before the loop (it is the update
    // deferral's and the drain's gate); only a loop session pays for the
    // settled-turn record (`settleTurn` drops it after its write).
    if (turn) await mgr.settleTurn(s, turn, how)
    else s.promptRunning = false
    // Whatever was typed while this turn ran goes next. A no-op when the drain
    // loop is what called this (it owns `draining` and continues on its own) —
    // this is here for the one turn it does not drive, the start prompt.
    void mgr.drainPending(s).then(() => {
      // The end of a turn ends a hold a due wake waited on (§5.1).
      if (s.info.watcher) mgr.schedule()
    })
  }
}

/**
 * The end of a logical turn, once gurt has classified how it ended
 * (docs/requirements-review-loop.md §5.1, §8): record it as `lastSettled` and
 * persist it, *then* emit `session.settled` — the bus replays nothing, so a
 * loop that misses the event reads the record at boot. A failed write is
 * logged and the event still goes out: the live loop must not hang on a disk
 * error, and only the replay after a crash is lost.
 *
 * A deleted session settles to nobody (`session.deleted` is its event).
 * `promptRunning` drops after the write and before the emit, so a subscriber
 * that queues a host message from the handler finds the session free.
 */
export async function settleTurn(mgr: TurnsCtx, s: Session, turn: TurnTrack, how: TurnHow): Promise<void> {
  if (s.turn === turn) s.turn = undefined
  const settled: SettledTurn = {
    turnId: turn.id,
    ...(turn.complete ? { complete: turn.complete } : {}),
    ...(turn.verdict ? { verdict: turn.verdict } : {}),
    ...how
  }
  const previous = s.lastSettled
  s.lastSettled = settled
  // §5.1/§8: never hand the controller an input absent from durable storage.
  // Bounded retries absorb transient writes; exhaustion faults with the hold.
  let durable = false
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await mgr.persistNow(s)
      durable = true
      break
    } catch (err) {
      log.error('session.persist.fail', { err })
    }
  }
  s.promptRunning = false
  if (!durable) {
    s.lastSettled = previous
    mgr.loopHooks?.storageFault?.(s.info.id)
    return
  }
  if (mgr.sessions.get(s.info.id) === s)
    mgr.bus.emit('session.settled', { sessionId: s.info.id, ref: s.ref, turn: settled })
}

/**
 * Run everything this session has waiting, one turn at a time, for as long as
 * it can: a queue that empties into a session whose clone was taken away
 * mid-drain stops where it is and waits to be called again (`schedule()`).
 *
 * Never rejects — it is called for its effect from event handlers and from
 * the tail of every turn, and a rejected floating promise here would be a
 * crash the user could not connect to anything they did.
 */
export async function drainPending(mgr: TurnsCtx, s: Session): Promise<void> {
  if (s.draining || s.recovering) return
  s.draining = true
  let consumed = false
  try {
    // `busy` covers the one turn this loop does not own: the start prompt,
    // which `startSession` runs directly. `repoHolder` is case two — the
    // clone is elsewhere, and attaching would only fail with it.
    // Case three: the account is at its limit — what is waiting would only be
    // refused, so it stays put until the hold lifts (`schedule()` again).
    // Case four: a review loop is delivering in this scope — its steps are
    // irreversible, so a typed message waits and runs after the loop has
    // ended (docs/requirements-review-loop.md §5.6, "During delivery"); the
    // controller calls `schedule()` when it does.
    while (
      s.pending.length &&
      !s.busy &&
      s.info.state === 'started' &&
      !mgr.repoHolder(s) &&
      !mgr.earlierQueueItem(s) &&
      !mgr.limitHold(s) &&
      !mgr.deliveryActive(s) &&
      // A wake whose write has not landed is not delivered yet (§5.1).
      s.pending[0] !== s.wakeWriting &&
      // A poll in flight ends first (§6.1); `setPolling(false)` drains again.
      !s.polling &&
      // A paused watcher runs no unattended turn of any kind (§3).
      !(mgr.isWakeWork(s.pending[0]!) && mgr.watcherPaused(s))
    ) {
      const next = s.pending.shift()!
      consumed = true
      s.interrupted = true
      // Beside `interrupted`, in the same write as the prompt's removal (§8).
      s.loopRan = loopOf(next.origin)
      if (s.info.role === 'watcher') {
        s.ranOrigin = mgr.isWakeWork(next) ? 'wake' : 'user'
        // The wake counts when the drain takes it, in this same record (§5.1).
        if (isWakeOrigin(next.origin) && watcherActive(s.info.watcher)) {
          s.info.watcher = wakeTaken(s.info.watcher, next.origin)
          s.wakeNote = next.origin.note
        }
      }
      await mgr.runPrompt(s, next.text, next.context, next.images, loopOf(next.origin))
    }
  } catch (e) {
    log.error('internal.fail', { site: 'pending-drain', s: s.info.id, err: e })
  } finally {
    s.draining = false
    // One emit for both endings: the queue is empty, or it is stuck and the
    // pane has to say why.
    mgr.bus.emit('session.changed', { sessionId: s.info.id })
    if (consumed) mgr.schedule()
  }
}
