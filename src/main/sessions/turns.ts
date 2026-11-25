import type { Vocabulary } from '../../shared/agentVocabulary'
import type { PlanHold } from '../../shared/planUsage'
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
import type { SettledTurn } from '../../rpm/main'
import { chatLineSummary, type RpmChatLine } from '../../rpm/core'
import { RPM_TAKEN_MAX, roleSettlesTurns, turnOriginOf } from './pure'
import { contractToolFor, nudgePromptFor, postTurnDecision } from './turnContract'
import type {
  Connection,
  NewLogRecord,
  PendingPrompt,
  PostTurnAction,
  Session,
  SessionEvents,
  TurnOrigin,
  TurnResult,
  TurnTrack
} from './types'

const log = createLogger('sessions')

// Turns: one prompt round-trip (`sendTurn`), the logical turn around it with its
// nudge (`runPrompt`), and the drain loop
// that feeds a session's queue into them (docs/requirements-turn-contract.md,
// docs/requirements-session-queue.md).

/** What turns.ts needs of the session manager: its state and the manager's own
 *  operations it calls back into. */
export interface TurnsCtx {
  readonly agentKinds: Map<string, string>
  append(s: Session, record: NewLogRecord): void
  assertNotStopped(s: Session): void
  attach(s: Session): Promise<Connection>
  readonly bus: Bus
  clearLimited(s: Session): void
  decideTurn(s: Session, outcome: TurnResult, isNudge: boolean): PostTurnAction
  drainPending(s: Session): Promise<void>
  earlierQueueItem(s: Session): Session | undefined
  readonly events: SessionEvents
  isWakeWork(p: PendingPrompt): boolean
  limitHold(s: Session): PlanHold | undefined
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
  runPrompt(s: Session, text: string, context?: PromptContext[], images?: PromptImage[], origin?: TurnOrigin): Promise<void>
  settleTurn(s: Session, turn: TurnTrack, outcome: SettledTurn['outcome']): Promise<void>
  schedule(): void
  schedulePersist(ref: EnvRef): void
  sendTurn(s: Session, text: string, entryKind: 'user' | 'system', isNudge: boolean, context?: PromptContext[], images?: PromptImage[], line?: RpmChatLine): Promise<TurnResult>
  readonly sessions: Map<string, Session>
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
  /** An RPM message (t3v2 §10.2): the chat shows this line, not a user message. */
  line?: RpmChatLine): Promise<TurnResult> {
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
  // A message the user typed (or the start prompt) that opens a logical turn —
  // not a cut turn's "continue", not the app's own prompt.
  const userTurn = !line && entryKind === 'user' && s.turn?.origin === 'user' && !s.turn.carried ? s.turn.id : undefined
  // An RPM message is the host's, not the user's: a system line, no
  // checkpoint. A user message carries its logical turn for RPM's
  // `userPrompts` / `checkpointBefore`.
  // TODO(rpm): `line.text` rides unmasked inside the entry's `rpm`.
  const promptEntry = line
    ? mgr.push(s, { kind: 'system', text: line.text !== undefined ? outbound : chatLineSummary(line), rpm: line })
    : mgr.push(s, { kind: entryKind, text: outbound, ...(userTurn ? { turn: userTurn } : {}) })
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
  } catch (e) {
    s.busy = false
    s.recovering = true
    throw e
  }
  try {
    if (maskError) throw maskError
    mgr.assertNotStopped(s)
    const conn = await mgr.attach(s)
    // A nudge lands as a `system` entry — not a rewind point.
    if (promptEntry.kind === 'user') {
      const checkpoint = await mgr.events.snapshotCheckpoint?.(s.info, promptEntry.id)
      if (checkpoint && userTurn) mgr.append(s, { type: 'patch', id: promptEntry.id, patch: { checkpoint } })
    }
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
  /** Where the prompt came from; the start prompt is the user's. */
  origin: TurnOrigin = { origin: 'user' }): Promise<void> {
  s.promptRunning = true
  const startedAt = Date.now()
  s.turnStartedAt = startedAt
  const fromWake = s.info.role === 'watcher' && s.ranOrigin === 'wake'
  s.turnGuard = fromWake || (s.info.role === 'watcher' && !!s.guardStart)
  s.guardStart = undefined
  // The logical turn of an executor or reviewer (t3v2 §4.1): this prompt and
  // its nudge. Opened before the first await so tool calls can file into it;
  // settled in the `finally`, whatever happened. Every other role's turn
  // ends as it always did.
  // A cut turn's "continue" carries that turn on (t3v2 §4.1, §12): its origin,
  // key and accepted calls. Every other prompt is a turn of its own.
  const carried = !!origin.continues && !!s.carry
  const from = carried ? s.carry! : origin
  const turn: TurnTrack | undefined = roleSettlesTurns(sessionRole(s.info))
    ? {
        id: `${s.info.id}:${++s.turnSeq}`,
        origin: from.origin,
        ...(from.key ? { key: from.key } : {}),
        tools: structuredClone(from.tools ?? []),
        ...(carried ? { carried: true } : {})
      }
    : undefined
  s.turn = turn
  // Until the body says how it ended, it threw.
  let outcome: SettledTurn['outcome'] = 'failed'
  try {
    const first = await mgr.sendTurn(s, text, 'user', false, context, images, carried ? undefined : origin.line)
    if (first.limit) {
      mgr.onLimited(s, first.limit)
      outcome = 'limited'
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
      if (turn) outcome = settledOutcome(s, turn, first, false)
      return
    }
    const second = await mgr.sendTurn(
      s,
      nudgePromptFor(sessionRole(s.info), !!s.info.watcher?.final),
      'system',
      true
    )
    if (second.limit) {
      mgr.onLimited(s, second.limit)
      outcome = 'limited'
      return
    }
    // The nudge turn failing leaves a watcher blind just as the first would (§7).
    if (fromWake && watcherActive(s.info.watcher)) {
      const failed = second.threw || (!!second.stopReason && second.stopReason !== 'end_turn' && second.stopReason !== 'cancelled')
      if (failed) mgr.onWakeFailed(s, second.threw ? 'the turn failed' : `stopped: ${second.stopReason}`)
      else if (second.stopReason === 'end_turn') s.wakeFailures = 0
    }
    const incomplete = mgr.decideTurn(s, second, true) === 'incomplete'
    if (turn) outcome = settledOutcome(s, turn, second, incomplete)
    if (incomplete) {
      mgr.push(s, { kind: 'system', text: `turn ended without ${contractToolFor(sessionRole(s.info))}` })
      s.info.incomplete = true
      if (sessionRole(s.info) === 'watcher') mgr.onWatcherIncomplete(s)
      mgr.bus.emit('session.changed', { sessionId: s.info.id })
      mgr.schedulePersist(s.ref)
    }
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
    // An ordinary session drops `promptRunning` right here; an executor or
    // reviewer after its settled turn is written (`settleTurn`).
    if (turn) await mgr.settleTurn(s, turn, outcome)
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

/** How a logical turn ended, from its last round-trip (its nudge, when it had
 *  one): threw, the user's Esc, another non-`end_turn` stop, no contract tool,
 *  or what the contract tool said — an executor's `complete` outcome, a
 *  reviewer's accepted `submit_review` (`no_changes`: its result is in `tools`). */
function settledOutcome(s: Session, turn: TurnTrack, last: TurnResult, incomplete: boolean): SettledTurn['outcome'] {
  if (last.threw) return 'failed'
  if (last.stopReason === 'cancelled') return 'cancelled'
  if (last.stopReason && last.stopReason !== 'end_turn') return 'failed'
  if (incomplete) return 'incomplete'
  if (sessionRole(s.info) === 'reviewer') return s.turnComplete ? 'no_changes' : 'incomplete'
  return turn.complete?.outcome ?? 'incomplete'
}

/**
 * The end of an executor's or reviewer's logical turn (t3v2 §4.1): record it
 * as `lastSettled` and persist it, *then* emit `session.settled` — the bus
 * replays nothing, so RPM reads the record at boot if it missed the event.
 * `promptRunning` drops after the write and before the emit, so a subscriber
 * that queues a message from the handler finds the session free. A deleted
 * session settles to nobody.
 */
export async function settleTurn(mgr: TurnsCtx, s: Session, turn: TurnTrack, outcome: SettledTurn['outcome']): Promise<void> {
  if (s.turn === turn) s.turn = undefined
  const settled: SettledTurn = {
    sessionId: s.info.id,
    turnId: turn.id,
    origin: turn.origin,
    ...(turn.key ? { key: turn.key } : {}),
    outcome,
    ...(outcome === 'blocked' && turn.complete?.reason ? { reason: turn.complete.reason } : {}),
    tools: turn.tools
  }
  s.lastSettled = settled
  // `limited` is no boundary: its "continue" carries this turn on. Written in
  // the same record as `lastSettled`.
  // TODO(rpm): a second turn cut while an earlier cut turn's "continue" still
  // waits replaces that carry.
  if (outcome === 'limited')
    s.carry = { origin: turn.origin, ...(turn.key ? { key: turn.key } : {}), tools: structuredClone(turn.tools) }
  else if (turn.carried) s.carry = undefined
  // Never an event without the record on disk (t3v2 §4.1): retry until the
  // write lands. The session holds its next turn meanwhile (`promptRunning`),
  // so turns settle in order. A deleted session settles to nobody.
  // TODO(rpm): no storage-fault signal to the UI while a disk keeps failing.
  for (let attempt = 0; ; attempt++) {
    if (mgr.sessions.get(s.info.id) !== s) {
      s.promptRunning = false
      return
    }
    try {
      await mgr.persistNow(s)
      break
    } catch (e) {
      log.error('session.persist.fail', { err: e, attempt })
      await new Promise((r) => setTimeout(r, SETTLE_RETRY_MS[Math.min(attempt, SETTLE_RETRY_MS.length - 1)]))
    }
  }
  s.promptRunning = false
  if (mgr.sessions.get(s.info.id) === s)
    mgr.bus.emit('session.settled', { sessionId: s.info.id, ref: s.ref, turn: structuredClone(settled) })
}

/** Back-off between failed writes of a settled turn. */
const SETTLE_RETRY_MS = [50, 200, 1000, 5000, 30000]

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
    while (
      s.pending.length &&
      !s.busy &&
      // The logical turn in flight (its nudge, its settle) ends first: the
      // start prompt runs outside this loop, and `busy` drops between its
      // round-trips.
      !s.promptRunning &&
      s.info.state === 'started' &&
      !mgr.repoHolder(s) &&
      !mgr.earlierQueueItem(s) &&
      !mgr.limitHold(s) &&
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
      // Taken into a turn: `SessionsPort.sent` answers `taken` from here on,
      // written with `interrupted` by the turn's first persist.
      if (next.origin && 'rpm' in next.origin)
        s.rpmTaken = [...(s.rpmTaken ?? []), next.origin.rpm].slice(-RPM_TAKEN_MAX)
      if (s.info.role === 'watcher') {
        s.ranOrigin = mgr.isWakeWork(next) ? 'wake' : 'user'
        // The wake counts when the drain takes it, in this same record (§5.1).
        if (isWakeOrigin(next.origin) && watcherActive(s.info.watcher)) {
          s.info.watcher = wakeTaken(s.info.watcher, next.origin)
          s.wakeNote = next.origin.note
        }
      }
      await mgr.runPrompt(s, next.text, next.context, next.images, turnOriginOf(next))
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
