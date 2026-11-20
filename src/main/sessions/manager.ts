import {
  applyLog,
  missingRepoReason,
  repoMode,
  sessionRole,
  type AcpHttpMcpServer,
  type AgentConfig,
  type InterruptedSession,
  type AgentConfigCache,
  type AgentSessionRequest,
  type ChangeProposal,
  type ChatEntry,
  type ChatEntryBase,
  type EnvRef,
  type McpSelection,
  type SkillSelection,
  type PendingPromptInfo,
  type PersistedSession,
  type PromptContext,
  type PromptImage,
  type SessionContainer,
  type HostBusy,
  type SessionInfo,
  type SessionNetwork,
  type RepoMode,
  type ReviewVerdict,
  type SessionRole,
  type SessionSnapshot,
  type StoredProposal,
} from '../../shared/types'
import { defaultAgentConfig } from '../../shared/agentConfig'
import type { AgentManifest } from '../../shared/agentPlugin'
import {
  AUTO_WORDS,
  MANUAL_WORDS,
  agentVocabulary,
  modeHas,
  type Vocabulary
} from '../../shared/agentVocabulary'
import { agentDef } from '../../shared/agents'
import type { SessionDraftPatch } from '../../shared/api'
import { taskKey } from '../../shared/keys'
import type { SettledTurn } from '../../shared/reviewLoop'
import type { PlanHold } from '../../shared/planUsage'
import type { Bus } from '../bus'
import type { AdminHooks, ProactiveHooks, WatcherToolHooks } from '../mcp/gurtServer'
import {
  watcherActive,
  type PendingWake,
  type WakeLate,
  type WatcherState,
} from '../../shared/watchers'
import type { SessionStateReason } from '../../shared/events'
import type { LaunchContext } from '../containers'
import type { PiiMask } from '../pii'
import type { resolveProxyPlan, ResolvedProxyPlan } from '../proxy/config'
import type {
  AcpToolContent
} from '../acp'
import { errCtx } from '../log'

import {
  pendingInfo,
  assertNotTemplate,
} from './pure'
import {
  proposalForRepo,
} from './turnContract'
import type {
  Claim,
  Connection,
  CreateAction,
  DraftInheritance,
  LoopHooks,
  NewLogRecord,
  PendingPrompt,
  PostTurnAction,
  PreparedDraft,
  RestoredSession,
  TurnHow,
  Session,
  SessionEvents,
  TurnResult,
  TurnTrack,
  WatcherHooks
} from './types'
import * as queue from './queue'
import * as wake from './wake'
import * as connection from './connection'
import * as start from './start'
import * as turns from './turns'
import * as agentEvents from './agentEvents'
import * as prompts from './prompts'
import * as persistence from './persistence'
import * as drafts from './drafts'
import * as lifecycle from './lifecycle'

/** One context object per manager instance and module: the modules take what they
 *  need through it (see the `*Ctx` interfaces), built over the manager's live
 *  state so it never goes stale. */
const ctxCache = new WeakMap<object, Record<string, unknown>>()
const cachedCtx = <C>(m: object, key: string, make: () => C): C => {
  let all = ctxCache.get(m)
  if (!all) ctxCache.set(m, (all = {}))
  return (all[key] ??= make()) as C
}

export class SessionManager {
  /** One ACP adapter per session, held under the session id. */
  private connections = new Map<string, Connection>()
  /** Bumped by `detach`; an `attachMcp` that began before it must not arm the
   *  live-scope keeper after it (docs/requirements-oauth-credentials.md §5.2). */
  private readonly detachEpoch = new Map<string, number>()
  /** In-flight adapter spawn per session — concurrent callers (a prompt's
   *  attach racing a config change's) must share one, or the loser's spawn
   *  leaks a second adapter process. Same shape as `prepInFlight` in
   *  containers.ts. */
  private connectsInFlight = new Map<string, Promise<Connection>>()
  /** In-flight attach per session, for the same reason one level up: two
   *  overlapping attaches would each issue their own `session/load`. */
  private attachesInFlight = new Map<string, Promise<Connection>>()
  private sessions = new Map<string, Session>()
  private persistTimers = new Map<string, NodeJS.Timeout>()
  /** Per agent-instance id, its last-known config surface (models/effort/commands/
   *  modes). Seeded from the persisted cache at restore, refreshed on every live
   *  session start/load/update — the source of truth the New Session modal reads
   *  and the fallback a detached session's snapshot uses. */
  private agentConfigs = new Map<string, AgentConfig>()
  /** Serialized form of the last cache write per agent — skips redundant saves. */
  private agentConfigWritten = new Map<string, string>()
  /** Last logged "why still queued" per session id (see `noteQueued`). */
  private queuedReasons = new Map<string, string>()
  /** Ids for queued prompts. Process-wide and monotonic — the renderer keys
   *  rows on them and cancels by them, and reusing one across sessions would
   *  make a stale cancel land on the wrong message. */
  private pendingSeq = 0
  /** Per-task cap on concurrently running sessions (`TaskFile.maxConcurrentSessions`),
   *  keyed by `taskKey(ws, task)`. Absent = unlimited. Mirrors `review.ts`'s
   *  in-memory lock set: the scheduler asks synchronously on every pass and
   *  cannot await a disk read, so this is seeded from disk at boot
   *  (`loadTaskCaps`) and kept current by every later edit (`setTaskCap`). */
  private taskCaps = new Map<string, number>()
  /** Per agent-instance id, its kind (`AgentManifest.id`) — mirrors agents.json so
   *  a seed config, a plugin's hooks and its vocabulary can resolve without a
   *  live container's launch context (see `loadAgentKinds`). */
  private agentKinds = new Map<string, string>()
  /** Per agent-instance id, the credential it runs on — the account a plan
   *  limit is pooled over. Kept beside `agentKinds`, from the same file. */
  private agentAccounts = new Map<string, string>()
  /** The one re-check armed for the earliest limit hold to lift. */
  private limitTimer: NodeJS.Timeout | undefined
  /** The review loop's controller, once it registers (`setLoopHooks`). */
  private loopHooks: LoopHooks | undefined
  /** The watcher manager, once it registers (`setWatcherHooks`). */
  private watcherHooks: WatcherHooks | undefined
  private readonly bootAt = Date.now()
  /** Executors the review loop holds (docs/requirements-review-loop.md §5.5):
   *  runtime only — the controller places them again at boot, before the
   *  scheduler's first pass. */
  private loopHolds = new Map<string, { info: Pick<SessionInfo, 'id' | 'title'>; claims: Claim[] }>()

  constructor(
    private events: SessionEvents,
    private bus: Bus,
    /** The ACP seam's masking layer (docs/requirements-pii-mask.md). Encodes the
     *  outbound prompt; the timeline keeps tokens and the chat view reveals them
     *  from the session's table. */
    private mask: PiiMask
  ) {}

  // --- what the modules are given of this manager ---------------------------------

  private static lifecycleCtx(m: SessionManager): lifecycle.LifecycleCtx {
    return cachedCtx(m, 'lifecycle', () => ({
      assertSessionWritable: (id) => m.assertSessionWritable(id),
      get bus() { return m.bus },
      clearCheckpoints: (s) => m.clearCheckpoints(s),
      detach: (sessionId) => m.detach(sessionId),
      get events() { return m.events },
      get loopHolds() { return m.loopHolds },
      get mask() { return m.mask },
      get persistTimers() { return m.persistTimers },
      recordsFor: (ws, task) => m.recordsFor(ws, task),
      schedule: () => m.schedule(),
      schedulePersist: (ref) => m.schedulePersist(ref),
      get sessions() { return m.sessions }
    }))
  }

  private emitState(s: Session, reason?: SessionStateReason, err?: unknown): void {
    this.bus.emit('session.state', {
      sessionId: s.info.id,
      ref: s.ref,
      state: s.info.state,
      ...(reason === undefined ? {} : { reason }),
      ...(err === undefined ? {} : { err: errCtx(err) })
    })
  }

  restore(records: RestoredSession[]): void { return persistence.restore(SessionManager.persistenceCtx(this), records) }

  /** Seed the in-memory config cache from the persisted one (called once at boot). */
  loadAgentConfigs(cache: AgentConfigCache): void {
    for (const [id, cfg] of Object.entries(cache)) {
      this.agentConfigs.set(id, cfg)
      this.agentConfigWritten.set(id, JSON.stringify(cfg))
    }
  }

  /** The session's agent kind's prompt-cache lifetime, if its manifest states one. */
  private cacheHint(s: Session): { cacheSeconds?: number } {
    const kind = this.agentKinds.get(s.info.agent ?? '')
    const seconds = kind ? agentDef(kind)?.promptCacheSeconds : undefined
    return seconds ? { cacheSeconds: seconds } : {}
  }

  /** How this session's agent words its modes, tool titles and limit
   *  notices — its kind's plugin vocabulary, or the core's plain one. */
  private vocabulary(s: Session): Vocabulary {
    return agentVocabulary(this.agentKinds.get(s.info.agent ?? ''))
  }

  /** Refresh the agent-instance→kind lookup — called once at boot and again
   *  whenever agents.json is saved, so it never goes stale. */
  loadAgentKinds(agents: Record<string, { kind: string; credentialId?: string | undefined }>): void {
    this.agentKinds.clear()
    this.agentAccounts.clear()
    for (const [id, a] of Object.entries(agents)) {
      this.agentKinds.set(id, a.kind)
      if (a.credentialId) this.agentAccounts.set(id, a.credentialId)
    }
    // A re-pointed credential can move a session onto (or off) a held account.
    this.schedule()
  }

  private limitHold(s: Session): PlanHold | undefined { return wake.limitHold(SessionManager.wakeCtx(this), s) }
  planHoldOf(sessionId: string): PlanHold | undefined { return wake.planHoldOf(SessionManager.wakeCtx(this), sessionId) }

  // --- review loop seams (docs/requirements-review-loop.md §5.4–§5.6) -------

  /** Register the loop's controller (or drop it with `undefined`). */
  setLoopHooks(hooks: LoopHooks | undefined): void {
    this.loopHooks = hooks
  }

  /** Register the watcher manager (or drop it with `undefined`). */
  setWatcherHooks(hooks: WatcherHooks | undefined): void {
    this.watcherHooks = hooks
  }

  private loopOwned(s: Session): boolean { return queue.loopOwned(SessionManager.queueCtx(this), s) }
  private deliveryActive(s: Session): boolean { return queue.deliveryActive(SessionManager.queueCtx(this), s) }
  holdForLoop(sessionId: string, stored?: { ws: string; task: string; repos: string[] }): void { return queue.holdForLoop(SessionManager.queueCtx(this), sessionId, stored) }
  releaseLoopHold(sessionId: string): boolean { return queue.releaseLoopHold(SessionManager.queueCtx(this), sessionId) }
  isLoopHeld(sessionId: string): boolean { return queue.isLoopHeld(SessionManager.queueCtx(this), sessionId) }
  ensureContainerUp(sessionId: string): Promise<void> { return connection.ensureContainerUp(SessionManager.connectionCtx(this), sessionId) }

  /** The last logical turn gurt finished classifying (persisted before
   *  `session.settled`): what a booting loop replays (§8). */
  lastSettledOf(sessionId: string): SettledTurn | undefined {
    const t = this.sessions.get(sessionId)?.lastSettled
    return t && structuredClone(t)
  }

  hostPromptSeen(sessionId: string, intent: string): boolean { return prompts.hostPromptSeen(SessionManager.promptsCtx(this), sessionId, intent) }
  dropHostPrompts(sessionId: string): number { return prompts.dropHostPrompts(SessionManager.promptsCtx(this), sessionId) }
  private holdText(h: PlanHold): string { return wake.holdText(h) }
  private armLimitTimer(holds: PlanHold[], instants: number[] = []): void { return wake.armLimitTimer(SessionManager.wakeCtx(this), holds, instants) }

  /** Cached config for an agent instance, or its kind's hardcoded default. */
  agentConfig(agentId: string, kind?: string): AgentConfig {
    return this.agentConfigs.get(agentId) ?? defaultAgentConfig(kind ?? agentId)
  }

  /** Fold a started session's live surface into the agent cache and persist it
   *  (deduped). No-op for sessions without an agent id. */
  private cacheAgentConfig(s: Session): void {
    const agentId = s.info.agent
    if (!agentId) return
    const prev = this.agentConfigs.get(agentId)
    const modes = s.modes ?? prev?.modes
    const promptCapabilities = this.connections.get(s.info.id)?.promptCapabilities ?? prev?.promptCapabilities
    const cfg: AgentConfig = {
      configOptions: s.configOptions ?? prev?.configOptions ?? [],
      commands: s.commands ?? prev?.commands ?? [],
      ...(modes ? { modes } : {}),
      ...(promptCapabilities ? { promptCapabilities } : {}),
      updatedAt: new Date().toISOString()
    }
    this.agentConfigs.set(agentId, cfg)
    // Compare without the timestamp so a pure re-report doesn't churn the file.
    const key = JSON.stringify({ ...cfg, updatedAt: undefined })
    if (this.agentConfigWritten.get(agentId) === key) return
    this.agentConfigWritten.set(agentId, key)
    this.events.saveAgentConfig(agentId, cfg)
  }

  listForTask(ws: string, task: string): SessionInfo[] {
    return [...this.sessions.values()]
      .filter((s) => s.ref.workspace === ws && s.ref.task === task)
      .map((s) => this.infoWithRuntime(s))
  }

  /** First of its role in the task carries no index; each further one counts
   *  up from there. `excludeId` leaves the session being renamed itself out
   *  of the count. */
  private defaultTitleForRole(ref: EnvRef, role: SessionRole, excludeId?: string): string {
    const sameRole = this.listForTask(ref.workspace, ref.task).filter(
      (s) => s.id !== excludeId && sessionRole(s) === role
    ).length
    return sameRole === 0 ? role : `${role} ${sameRole + 1}`
  }

  /** `info` plus the non-persisted runtime overlay the tree renders as status. */
  private infoWithRuntime(s: Session): SessionInfo {
    return {
      ...s.info,
      busy: s.busy || undefined,
      hostBusy: s.hostBusy,
      awaitingInput: s.pendingPermissions.size > 0 || undefined,
      pending: s.pending.length ? s.pending.map(pendingInfo) : undefined,
      queueWaiting: s.recovering ? 'waiting for resume' : this.pendingBlocked(s) ?? (s.info.state === 'queued' ? this.queuedWaiting(s) : undefined)
    }
  }

  private queueTime(s: Session): string { return queue.queueTime(s) }
  private queuedSessions(): Session[] { return queue.queuedSessions(SessionManager.queueCtx(this)) }
  private earlierQueueItem(s: Session): Session | undefined { return queue.earlierQueueItem(SessionManager.queueCtx(this), s) }
  private queuePosition(sessionId: string): number | undefined { return queue.queuePosition(SessionManager.queueCtx(this), sessionId) }
  private pendingBlocked(s: Session): string | undefined { return queue.pendingBlocked(SessionManager.queueCtx(this), s) }
  private queuedWaiting(s: Session): string | undefined { return queue.queuedWaiting(SessionManager.queueCtx(this), s) }
  private loopHoldText(c: { holder: { info: Pick<SessionInfo, 'id' | 'title'> }; repo: string }, does: 'sends' | 'starts'): string { return queue.loopHoldText(SessionManager.queueCtx(this), c, does) }

  snapshot(sessionId: string): SessionSnapshot | undefined {
    const s = this.sessions.get(sessionId)
    if (!s) return undefined
    // A started-but-detached session (e.g. restored after a restart, or an env
    // that auto-stopped) has no live surface yet — fall back to the agent cache
    // so the composer still shows its commands/modes and running one wakes it.
    const cached = s.info.agent ? this.agentConfigs.get(s.info.agent) : undefined
    // Never-run agent instance: no live surface AND no cache either — fall
    // back one step further, to the kind's hardcoded seed (e.g. claude-code's
    // model row), so the composer offers a model pick from the first draft on.
    const kind = s.info.agent ? this.agentKinds.get(s.info.agent) : undefined
    return {
      info: this.infoWithRuntime(s),
      entries: s.entries,
      logSeq: s.lastSeq,
      busy: s.busy,
      resuming: s.loading || undefined,
      modes: s.modes ?? cached?.modes,
      plan: s.plan,
      commands: s.commands ?? cached?.commands,
      configOptions:
        s.configOptions ?? cached?.configOptions ?? (kind ? defaultAgentConfig(kind).configOptions : undefined),
      promptCapabilities: this.connections.get(sessionId)?.promptCapabilities ?? cached?.promptCapabilities,
      startError: s.startError,
      queuePosition: this.queuePosition(sessionId),
      waiting: s.info.state === 'queued' ? this.queuedWaiting(s) : undefined,
      pending: s.pending.length ? s.pending.map(pendingInfo) : undefined,
      pendingBlocked: this.pendingBlocked(s),
      proposal: s.proposal,
      usage: s.usage
    }
  }

  createSession(ref: EnvRef,
    repos: string[],
    agentId: string,
    startPrompt: string,
    action: CreateAction,
    mcp: McpSelection[] = [],
    autoAllow = true,
    configValues: Record<string, string | boolean> = {},
    role: SessionRole = 'executor',
    /** `undefined` = never chosen, which is what the draft's `defaultSkills`
     *  seeding keys on; `[]` = chosen to be none, which it must not overwrite
     *  (docs/requirements-skills.md §4.3). */
    skills: SkillSelection[] | undefined = undefined,
    network?: SessionNetwork,
    /** How each repo is mounted; anything missing or invalid takes the default
     *  (docs/requirements-repo-mounts.md §2). */
    repoModes?: Partial<Record<string, unknown>>): SessionInfo {
    return drafts.createSession(SessionManager.draftsCtx(this), ref, repos, agentId, startPrompt, action, mcp, autoAllow, configValues, role, skills, network, repoModes)
  }

  private startNowOrQueue(sessionId: string): void { return queue.startNowOrQueue(SessionManager.queueCtx(this), sessionId) }

  /** Run now — bypass the queue and start immediately (see {@link startNowOrQueue}
   *  for the one exception: a task already at its concurrency cap). */
  run(sessionId: string): void {
    this.assertSessionWritable(sessionId)
    const s = this.sessions.get(sessionId)
    if (!s || s.info.state === 'starting' || s.info.state === 'started') return
    assertNotTemplate(s.info)
    // Gate 2 (see createSession's gate 1 for the rule).
    const missing = missingRepoReason(s.info)
    if (missing) throw new Error(missing)
    this.startNowOrQueue(sessionId)
  }

  enqueue(sessionId: string): void {
    this.assertSessionWritable(sessionId)
    const s = this.sessions.get(sessionId)
    if (!s || s.info.state === 'starting' || s.info.state === 'started') return
    assertNotTemplate(s.info)
    // Gate 3 (see createSession's gate 1 for the rule).
    const missing = missingRepoReason(s.info)
    if (missing) throw new Error(missing)
    s.info.state = 'queued'
    s.info.queuedAt = new Date().toISOString()
    s.startError = undefined
    this.bus.emit('tree.changed', undefined)
    this.emitState(s, 'user')
    this.schedulePersist(s.ref)
    this.schedule()
  }

  /** Cancel a queued session — back to draft. */
  cancelQueue(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s || s.info.state !== 'queued') return
    s.info.state = 'draft'
    s.info.queuedAt = undefined
    this.bus.emit('tree.changed', undefined)
    this.emitState(s, 'user')
    this.schedulePersist(s.ref)
  }

  editPrompt(sessionId: string, text: string, images?: PromptImage[]): void {
    this.assertSessionWritable(sessionId)
    const s = this.sessions.get(sessionId)
    if (!s || s.info.state !== 'draft') return
    s.info.startPrompt = text
    // Kept in memory only: a draft's images are not worth bloating the persisted
    // session file with megabytes of base64.
    s.startImages = images?.length ? images : undefined
    this.bus.emit('session.changed', { sessionId })
    this.schedulePersist(s.ref)
  }

  editDraft(sessionId: string, patch: SessionDraftPatch): void { return drafts.editDraft(SessionManager.draftsCtx(this), sessionId, patch) }
  duplicateSession(sessionId: string): SessionInfo { return drafts.duplicateSession(SessionManager.draftsCtx(this), sessionId) }
  recreateSession(sessionId: string): SessionInfo { return drafts.recreateSession(SessionManager.draftsCtx(this), sessionId) }
  rewindSession(sessionId: string, entryId: number): Promise<{ text: string }> { return drafts.rewindSession(SessionManager.draftsCtx(this), sessionId, entryId) }
  branchSession(sessionId: string, entryId: number): SessionInfo { return drafts.branchSession(SessionManager.draftsCtx(this), sessionId, entryId) }
  private draftFrom(source: SessionInfo): SessionInfo { return drafts.draftFrom(SessionManager.draftsCtx(this), source) }
  deleteSession(sessionId: string): void { return lifecycle.deleteSession(SessionManager.lifecycleCtx(this), sessionId) }
  private clearCheckpoints(s: Session): Promise<void> { return lifecycle.clearCheckpoints(SessionManager.lifecycleCtx(this), s) }

  // --- scheduler ----------------------------------------------------------

  /**
   * Walk the global FIFO queue and start every item whose start condition
   * currently holds. Items for independent repos may start in one pass; a repo
   * occupied by a just-started item keeps its later items queued.
   */
  schedule(): void {
    this.scheduleSync()
  }

  private scheduleSync(): void { return queue.scheduleSync(SessionManager.queueCtx(this)) }
  private wakeBlock(s: Session): { why: WakeLate; hold?: PlanHold } | undefined { return wake.wakeBlock(SessionManager.wakeCtx(this), s) }
  canPoll(sessionId: string): boolean { return wake.canPoll(SessionManager.wakeCtx(this), sessionId) }
  setPolling(sessionId: string, polling: boolean): void { return wake.setPolling(SessionManager.wakeCtx(this), sessionId, polling) }
  private wakePass(holds: PlanHold[]): number[] { return wake.wakePass(SessionManager.wakeCtx(this), holds) }
  private assertNotStopped(s: Session): void { return wake.assertNotStopped(s) }
  private queuedWakes(s: Session): PendingPrompt[] { return wake.queuedWakes(s) }
  private watcherPaused(s: Session): boolean { return wake.watcherPaused(SessionManager.wakeCtx(this), s) }
  private isWakeWork(p: PendingPrompt): boolean { return wake.isWakeWork(p) }
  holdWakes(sessionId: string): void { return wake.holdWakes(SessionManager.wakeCtx(this), sessionId) }

  patchWatcher(sessionId: string,
    patch: { watcher?: WatcherState | undefined; wake?: PendingWake | undefined },
    opts: { persist?: boolean } = {}): void {
    return wake.patchWatcher(SessionManager.wakeCtx(this), sessionId, patch, opts)
  }

  wakeNow(sessionId: string): void { return wake.wakeNow(SessionManager.wakeCtx(this), sessionId) }
  endWatcher(sessionId: string, end: NonNullable<WatcherState['end']>): void { return wake.endWatcher(SessionManager.wakeCtx(this), sessionId, end) }
  recoverWatcher(sessionId: string, paused: boolean): boolean { return wake.recoverWatcher(SessionManager.wakeCtx(this), sessionId, paused) }
  private onWakeFailed(s: Session, reason: string): void { return wake.onWakeFailed(SessionManager.wakeCtx(this), s, reason) }
  private onWatcherIncomplete(s: Session): void { return wake.onWatcherIncomplete(SessionManager.wakeCtx(this), s) }
  private noteQueued(s: Session, reason: string, by?: string): void { return queue.noteQueued(SessionManager.queueCtx(this), s, reason, by) }
  private claims(s: Session): Claim[] { return queue.claims(s) }
  private repoConflict(s: Session): { holder: { info: Pick<SessionInfo, 'id' | 'title'> }; repo: string } | undefined { return queue.repoConflict(SessionManager.queueCtx(this), s) }
  private loopHoldConflict(s: Session): { holder: { info: Pick<SessionInfo, 'id' | 'title'> }; repo: string } | undefined { return queue.loopHoldConflict(SessionManager.queueCtx(this), s) }
  private repoHolder(s: Session): { info: Pick<SessionInfo, 'id' | 'title'> } | undefined { return queue.repoHolder(SessionManager.queueCtx(this), s) }
  private isActive(s: Session): boolean { return queue.isActive(s) }
  private holdsClone(s: Session): boolean { return queue.holdsClone(SessionManager.queueCtx(this), s) }
  private activeSessionCount(ws: string, task: string): number { return queue.activeSessionCount(SessionManager.queueCtx(this), ws, task) }
  private capExempt(s: Session): boolean { return queue.capExempt(s) }
  loadTaskCaps(entries: { ws: string; task: string; max?: number | undefined }[]): void { return queue.loadTaskCaps(SessionManager.queueCtx(this), entries) }
  setTaskCap(ws: string, task: string, max: number | undefined): void { return queue.setTaskCap(SessionManager.queueCtx(this), ws, task, max) }
  repoHolderFor(ws: string, task: string, repo: string): SessionInfo | undefined { return queue.repoHolderFor(SessionManager.queueCtx(this), ws, task, repo) }
  holdersBlockingQueue(): string[] { return queue.holdersBlockingQueue(SessionManager.queueCtx(this)) }
  private noteUnattachedMcp(s: Session, attached: AcpHttpMcpServer[]): void { return start.noteUnattachedMcp(SessionManager.startCtx(this), s, attached) }
  private attachMcp(s: Session, ctx: LaunchContext): Promise<AcpHttpMcpServer[]> { return start.attachMcp(SessionManager.startCtx(this), s, ctx) }

  private keepOAuthScopeFresh(s: Session,
    ctx: LaunchContext,
    selection: McpSelection[] | undefined,
    planOpts: Parameters<typeof resolveProxyPlan>[4],
    pushedPlan: ResolvedProxyPlan): void {
    return start.keepOAuthScopeFresh(SessionManager.startCtx(this), s, ctx, selection, planOpts, pushedPlan)
  }

  private materializeSkills(s: Session): Promise<void> { return start.materializeSkills(SessionManager.startCtx(this), s) }
  private startSession(sessionId: string, by: 'user' | 'scheduler'): Promise<void> { return start.startSession(SessionManager.startCtx(this), sessionId, by) }
  detach(sessionId: string): void { return connection.detach(SessionManager.connectionCtx(this), sessionId) }

  /** Read a session's persisted info (the container manager's view of it). */
  sessionInfo(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId)?.info
  }

  /** Every live session's info — the boot reconcile and task teardown walk these. */
  allSessions(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info)
  }

  patchContainer(sessionId: string, container: SessionContainer | undefined): void { return lifecycle.patchContainer(SessionManager.lifecycleCtx(this), sessionId, container) }
  dropTaskSessions(ws: string, task: string): void { return lifecycle.dropTaskSessions(SessionManager.lifecycleCtx(this), ws, task) }
  dropWorkspaceSessions(ws: string): void { return lifecycle.dropWorkspaceSessions(SessionManager.lifecycleCtx(this), ws) }
  private recordsFor(ws: string, task: string): PersistedSession[] { return persistence.recordsFor(SessionManager.persistenceCtx(this), ws, task) }
  private sessionsFor(ws: string, task: string): Session[] { return persistence.sessionsFor(SessionManager.persistenceCtx(this), ws, task) }
  private persistNow(s: Session): Promise<void> { return persistence.persistNow(SessionManager.persistenceCtx(this), s) }
  flushForRestart(): Promise<void> { return persistence.flushForRestart(SessionManager.persistenceCtx(this)) }
  flushTask(ws: string, task: string): Promise<void> { return persistence.flushTask(SessionManager.persistenceCtx(this), ws, task) }
  private flushSessions(sessions: Session[]): Promise<void> { return persistence.flushSessions(SessionManager.persistenceCtx(this), sessions) }

  private frozenTasks = new Set<string>()

  assertTaskWritable(ws: string, task: string): void {
    if (this.frozenTasks.has(taskKey(ws, task))) throw new Error('Scope is being archived')
  }

  private assertSessionWritable(id: string): void {
    const s = this.sessions.get(id)
    if (s) this.assertTaskWritable(s.ref.workspace, s.ref.task)
  }

  async withTaskFrozen<T>(ws: string, task: string, action: () => Promise<T>): Promise<T> {
    this.assertTaskWritable(ws, task)
    this.frozenTasks.add(taskKey(ws, task))
    try { return await action() } finally { this.frozenTasks.delete(taskKey(ws, task)) }
  }

  noteTaskActivity(ws: string, task: string): void {
    const sessions = this.sessionsFor(ws, task)
    if (!sessions.length) return
    for (const s of sessions) s.info.lastActivityAt = new Date().toISOString()
    this.schedulePersist(sessions[0]!.ref)
  }

  taskHasPendingWork(ws: string, task: string): boolean {
    // A live review loop is work too: nothing is queued or running at the
    // moment of a check, but the loop owns the clones (§5.6).
    if (this.loopHooks?.live(ws, task) === true) return true
    return this.sessionsFor(ws, task).some((s) => s.busy || s.draining || s.loading || s.promptRunning ||
      s.pendingPermissions.size > 0 || s.pending.length > 0 || s.recovering ||
      s.info.state === 'starting' || s.info.state === 'queued' || !!s.info.limitedUntil || !!s.startImages?.length ||
      watcherActive(s.info.watcher))
  }

  dropArchivedSession(id: string): Promise<void> { return lifecycle.dropArchivedSession(SessionManager.lifecycleCtx(this), id) }

  setArchiveRead(marks: Record<string, string>): void {
    for (const [id, stamp] of Object.entries(marks)) {
      const s = this.sessions.get(id)
      if (!s || this.frozenTasks.has(taskKey(s.ref.workspace, s.ref.task))) continue
      s.info.archiveSeenAt = stamp === 'unread' ? undefined :
        Number.isFinite(Date.parse(stamp)) ? stamp : s.info.archiveSeenAt
      this.schedulePersist(s.ref)
    }
  }

  interruptedSessions(): InterruptedSession[] { return persistence.interruptedSessions(SessionManager.persistenceCtx(this)) }
  hasUnfinishedWork(): boolean { return persistence.hasUnfinishedWork(SessionManager.persistenceCtx(this)) }
  resumeInterrupted(id: string): Promise<void> { return persistence.resumeInterrupted(SessionManager.persistenceCtx(this), id) }
  private schedulePersist(ref: EnvRef): void { return persistence.schedulePersist(SessionManager.persistenceCtx(this), ref) }
  renameTask(ws: string, oldTask: string, newTask: string): void { return lifecycle.renameTask(SessionManager.lifecycleCtx(this), ws, oldTask, newTask) }
  renameSession(sessionId: string, title: string): void { return lifecycle.renameSession(SessionManager.lifecycleCtx(this), sessionId, title) }
  private flushLog(s: Session): void { return persistence.flushLog(SessionManager.persistenceCtx(this), s) }
  private connection(s: Session, ctx: LaunchContext): Promise<Connection> { return connection.connection(SessionManager.connectionCtx(this), s, ctx) }
  private connectionUncoalesced(s: Session, ctx: LaunchContext): Promise<Connection> { return connection.connectionUncoalesced(SessionManager.connectionCtx(this), s, ctx) }
  private attach(s: Session): Promise<Connection> { return connection.attach(SessionManager.connectionCtx(this), s) }
  private attachUncoalesced(s: Session): Promise<Connection> { return connection.attachUncoalesced(SessionManager.connectionCtx(this), s) }

  /**
   * Whether this session's prompts are masked right now. Masking is global
   * (Settings → Masking): every session masks while a detector backend resolves
   * and none does while it does not (§5.1's "nothing is masked while no backend
   * is selected").
   *
   * The timeline itself holds the *tokenized* text — what the agent saw and
   * wrote — and the chat view substitutes reals from the session's table when
   * it renders (so its open/closed toggle is a pure view setting, and nothing
   * on disk but the table ever holds a real value). Tool calls the agent makes
   * through MCP servers are a separate seam (§7).
   */
  private maskEnabled(): boolean {
    return this.mask.ready()
  }

  private promptBlocks(s: Session,
    text: string,
    context?: PromptContext[],
    images?: PromptImage[]): unknown[] {
    return turns.promptBlocks(s, text, context, images)
  }

  private sendTurn(s: Session,
    text: string,
    entryKind: 'user' | 'system',
    isNudge: boolean,
    context?: PromptContext[],
    images?: PromptImage[],
    /** The review loop's intent id, when this turn is one of its host messages
     *  (shown as a `system` entry that carries it). */
    loop?: string): Promise<TurnResult> {
    return turns.sendTurn(SessionManager.turnsCtx(this), s, text, entryKind, isNudge, context, images, loop)
  }

  private reportTurn(s: Session,
    startedAt: number,
    outcome: TurnResult,
    detail?: string): void {
    return turns.reportTurn(SessionManager.turnsCtx(this), s, startedAt, outcome, detail)
  }

  private decideTurn(s: Session, outcome: TurnResult, isNudge: boolean): PostTurnAction { return turns.decideTurn(s, outcome, isNudge) }
  private withLimit(s: Session, outcome: TurnResult, detail: string | undefined, firstEntry: number): TurnResult { return turns.withLimit(SessionManager.turnsCtx(this), s, outcome, detail, firstEntry) }
  private onLimited(s: Session, limit: { resetAt?: string | undefined }): string { return wake.onLimited(SessionManager.wakeCtx(this), s, limit) }
  private clearLimited(s: Session): void { return wake.clearLimited(SessionManager.wakeCtx(this), s) }

  private runPrompt(s: Session,
    text: string,
    context?: PromptContext[],
    images?: PromptImage[],
    loop?: string): Promise<void> {
    return turns.runPrompt(SessionManager.turnsCtx(this), s, text, context, images, loop)
  }

  private settleTurn(s: Session, turn: TurnTrack, how: TurnHow): Promise<void> { return turns.settleTurn(SessionManager.turnsCtx(this), s, turn, how) }
  private onComplete(sessionId: string, p: ChangeProposal): void { return agentEvents.onComplete(SessionManager.agentEventsCtx(this), sessionId, p) }
  private onSubmitReview(sessionId: string, v: ReviewVerdict): void { return agentEvents.onSubmitReview(SessionManager.agentEventsCtx(this), sessionId, v) }

  private gurtHooks(s: Session): {
    role: SessionRole
    mounts: { repo: string; mode: RepoMode }[]
    onComplete: (p: ChangeProposal) => void
    onSubmitReview: (v: ReviewVerdict) => void
    onCreateSession: (req: AgentSessionRequest) => Promise<{ sessionId: string; title: string }>
    reviewLoop?: boolean
    admin?: AdminHooks
    proactive?: ProactiveHooks
    watcher?: WatcherToolHooks
    cacheSeconds?: number
  } {
    return agentEvents.gurtHooks(SessionManager.agentEventsCtx(this), s)
  }

  private proactiveHooks(s: Session): ProactiveHooks { return agentEvents.proactiveHooks(SessionManager.agentEventsCtx(this), s) }
  markTemplate(sessionId: string): void { return drafts.markTemplate(SessionManager.draftsCtx(this), sessionId) }
  spawnRun(templateId: string, title: string): SessionInfo { return drafts.spawnRun(SessionManager.draftsCtx(this), templateId, title) }

  createReviewer(executorId: string,
    req: { round: number; intent: string; prompt: string }): Promise<SessionInfo> {
    return drafts.createReviewer(SessionManager.draftsCtx(this), executorId, req)
  }

  createAgentDraft(spawnerId: string,
    req: AgentSessionRequest): Promise<{ sessionId: string; title: string }> {
    return drafts.createAgentDraft(SessionManager.draftsCtx(this), spawnerId, req)
  }

  inheritanceOf(info: SessionInfo): DraftInheritance { return drafts.inheritanceOf(info) }
  prepareDraft(ws: string, req: AgentSessionRequest, inherit: DraftInheritance): Promise<PreparedDraft> { return drafts.prepareDraft(SessionManager.draftsCtx(this), ws, req, inherit) }
  createPreparedDraft(ws: string, task: string, prepared: PreparedDraft, inherit: DraftInheritance): SessionInfo { return drafts.createPreparedDraft(SessionManager.draftsCtx(this), ws, task, prepared, inherit) }
  private resolveDraftEnv(ws: string, req: AgentSessionRequest): Promise<string> { return drafts.resolveDraftEnv(SessionManager.draftsCtx(this), ws, req) }

  /** Newest stored proposal for this (task, repo) among the sessions that
   *  *write* it (all outcome=changes), resolved to that repo — its own entry
   *  when it has one, else the shared commit/pr (docs/requirements-repo-mounts.md
   *  §3). A proposal with neither for this repo does not count. */
  latestProposal(ws: string, task: string, repo: string): StoredProposal | undefined {
    let best: StoredProposal | undefined
    for (const s of this.sessions.values()) {
      if (s.ref.workspace !== ws || s.ref.task !== task) continue
      if (!s.info.repos.includes(repo) || repoMode(s.info, repo) !== 'write') continue
      const p = s.proposal && proposalForRepo(s.proposal, repo)
      if (!p) continue
      if (!best || p.at > best.at) best = p
    }
    return best
  }

  /** No session sharing this env is busy or mid-start. */
  isSessionIdle(sessionId: string): boolean {
    const s = this.sessions.get(sessionId)
    if (!s) return false
    return !s.busy && !s.nudgePending && s.info.state !== 'starting'
  }

  /** Ping from the UI (e.g. typing in the composer) — postpones a pending auto-stop. */
  activity(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    if (this.frozenTasks.has(taskKey(s.ref.workspace, s.ref.task))) return
    s.info.lastActivityAt = new Date().toISOString()
    this.schedulePersist(s.ref)
    this.bus.emit('session.activity', { sessionId: s.info.id })
  }

  prompt(sessionId: string,
    text: string,
    context?: PromptContext[],
    images?: PromptImage[]): Promise<void> {
    return prompts.prompt(SessionManager.promptsCtx(this), sessionId, text, context, images)
  }

  private human(s: Session, did: 'prompt' | 'cancel'): void { return prompts.human(SessionManager.promptsCtx(this), s, did) }
  hostPrompt(sessionId: string, text: string, intent: string): Promise<void> { return prompts.hostPrompt(SessionManager.promptsCtx(this), sessionId, text, intent) }
  private drainPending(s: Session): Promise<void> { return turns.drainPending(SessionManager.turnsCtx(this), s) }
  clearPending(sessionId: string): PendingPromptInfo[] { return prompts.clearPending(SessionManager.promptsCtx(this), sessionId) }
  cancelPending(sessionId: string, promptId: string): PendingPromptInfo | undefined { return prompts.cancelPending(SessionManager.promptsCtx(this), sessionId, promptId) }
  private dropAuto(s: Session, which: 'all' | 'limit' | 'wake', finalWithdrawn = false): void { return prompts.dropAuto(SessionManager.promptsCtx(this), s, which, finalWithdrawn) }
  cancelWake(sessionId: string): void { return prompts.cancelWake(SessionManager.promptsCtx(this), sessionId) }
  cancel(sessionId: string, by: 'user' | 'host' = 'user'): void { return prompts.cancel(SessionManager.promptsCtx(this), sessionId, by) }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    this.assertSessionWritable(sessionId)
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error('unknown session')
    const conn = this.connections.get(s.info.id)
    if (!conn) throw new Error('agent is not running — send a prompt first')
    await conn.peer.request('session/set_mode', { sessionId: s.acpSessionId, modeId })
    if (s.modes) s.modes.currentModeId = modeId
    // The pick itself is what a reattach restores — the bool below only drives
    // the auto/manual tag and is far too coarse to rebuild a mode from.
    s.info.modeId = modeId
    // Keep the persisted preference in step so a later reattach restores this choice.
    const mode = s.modes?.availableModes.find((m) => m.id === modeId)
    const picked = { id: mode?.id ?? modeId, name: mode?.name ?? '' }
    if (modeHas(picked, [...this.vocabulary(s).modes.bypass, ...AUTO_WORDS])) s.info.autoAllow = true
    else if (modeHas(picked, MANUAL_WORDS)) s.info.autoAllow = false
    this.bus.emit('session.changed', { sessionId })
    this.schedulePersist(s.ref)
  }

  /**
   * gurt's own confirmation for an operator's `apply_held`
   * (docs/requirements-session-operator.md §4.3) — the one prompt auto-allow
   * cannot reach. It is raised here, not through ACP, so neither the
   * gurt-tools blanket allow in `onPermission` nor a bypass mode ever sees
   * it; it rides the timeline as a permission entry so the decision is on the
   * record afterwards. No timeout and no default: a cancelled turn, a dead
   * adapter or a deleted session resolves it as "no", and an app restart
   * leaves nothing to resume — every exit fails closed.
   */
  confirmHeld(sessionId: string, title: string, detail: string): Promise<{ ok: boolean; entryId: number }> {
    const s = this.sessions.get(sessionId)
    if (!s) return Promise.resolve({ ok: false, entryId: -1 })
    const entry = this.push(s, {
      kind: 'permission',
      title,
      detail,
      options: [
        { optionId: 'apply', name: 'Apply', kind: 'allow_once' },
        { optionId: 'reject', name: 'Keep held', kind: 'reject_once' }
      ]
    })
    return new Promise((resolve) => {
      s.pendingPermissions.set(entry.id, (outcome) => {
        const o = (outcome as { outcome?: { outcome?: string; optionId?: string } }).outcome
        resolve({ ok: o?.outcome === 'selected' && o.optionId === 'apply', entryId: entry.id })
      })
      if (s.pendingPermissions.size === 1)
        this.bus.emit('session.awaiting', { sessionId: s.info.id, ref: s.ref, awaiting: true })
    })
  }

  respondPermission(sessionId: string, entryId: number, optionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const resolve = s.pendingPermissions.get(entryId)
    if (!resolve) return
    s.pendingPermissions.delete(entryId)
    const entry = s.entries.find((e) => e.id === entryId)
    if (entry && entry.kind === 'permission')
      this.append(s, { type: 'patch', id: entryId, patch: { chosen: optionId } })
    resolve({ outcome: { outcome: 'selected', optionId } })
    if (s.pendingPermissions.size === 0)
      this.bus.emit('session.awaiting', { sessionId, ref: s.ref, awaiting: false })
    this.bus.emit('session.changed', { sessionId })
    this.schedulePersist(s.ref)
  }

  private bySessionId(acpSessionId: string): Session | undefined { return agentEvents.bySessionId(SessionManager.agentEventsCtx(this), acpSessionId) }

  /** The review loop writes into the executor's chat: a block gurt ran itself
   *  (`host` tool) or a note. Returns the entry's id, undefined for a session
   *  that is gone. */
  loopFeedPush(sessionId: string, entry: ChatEntryBase): number | undefined {
    const s = this.sessions.get(sessionId)
    return s ? this.push(s, entry).id : undefined
  }

  /** Mark (or clear) gurt's own work on the session between its turns — the
   *  review loop's automatic check. Runtime only: the status marks blink on it,
   *  and a restart drops it with the check it described. */
  setHostBusy(sessionId: string, what: HostBusy | undefined): void {
    const s = this.sessions.get(sessionId)
    if (!s || s.hostBusy === what) return
    s.hostBusy = what
    this.bus.emit('session.changed', { sessionId })
  }

  /** Settle or update a block `loopFeedPush` wrote. */
  loopFeedPatch(
    sessionId: string,
    entryId: number,
    patch: { status?: string; title?: string; detail?: string; endAt?: number }
  ): void {
    const s = this.sessions.get(sessionId)
    if (!s || !s.entries.some((e) => e.id === entryId)) return
    this.append(s, { type: 'patch', id: entryId, patch })
  }

  /** The ONE writer of the session log: assigns seq, applies, announces, persists. */
  private append(s: Session, record: NewLogRecord): void {
    s.info.lastActivityAt = new Date().toISOString()
    s.info.lastContentAt = s.info.lastActivityAt
    const rec = { ...record, seq: ++s.lastSeq }
    s.records.push(rec)
    s.entries = applyLog(s.entries, [rec])
    this.bus.emit('session.log', { sessionId: s.info.id, records: [rec] })
    // A streaming text delta changes nothing outside the timeline, and the
    // timeline rides session.log — skip the per-chunk snapshot broadcast.
    if (rec.type !== 'append') this.bus.emit('session.changed', { sessionId: s.info.id })
    this.schedulePersist(s.ref)
  }

  private push(s: Session, entry: ChatEntryBase): ChatEntry {
    const full = { ...entry, id: s.nextEntryId++, at: Date.now() }
    this.append(s, { type: 'entry', entry: full })
    return full
  }

  private startMeta(agent: AgentManifest,
    configValues: Record<string, string | boolean> | undefined): Record<string, unknown> | undefined {
    return start.startMeta(agent, configValues)
  }

  private applyStartConfig(s: Session, conn: Connection): Promise<void> { return start.applyStartConfig(SessionManager.startCtx(this), s, conn) }

  private pushConfigOption(s: Session,
    conn: Connection,
    configId: string,
    value: string | boolean): Promise<void> {
    return start.pushConfigOption(SessionManager.startCtx(this), s, conn, configId, value)
  }

  setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<void> { return start.setConfigOption(SessionManager.startCtx(this), sessionId, configId, value) }
  private applyAutoAllow(s: Session, conn: Connection): Promise<void> { return start.applyAutoAllow(SessionManager.startCtx(this), s, conn) }
  private toolDetail(content: AcpToolContent | undefined): string | undefined { return agentEvents.toolDetail(content) }
  private onSessionUpdate(params: unknown): void { return agentEvents.onSessionUpdate(SessionManager.agentEventsCtx(this), params) }
  private onPermission(params: unknown): unknown { return agentEvents.onPermission(SessionManager.agentEventsCtx(this), params) }

  // --- what the modules are given of this manager ---------------------------------

  private static draftsCtx(m: SessionManager): drafts.DraftsCtx {
    return cachedCtx(m, 'drafts', () => ({
      append: (s, record) => m.append(s, record),
      applyAutoAllow: (s, conn) => m.applyAutoAllow(s, conn),
      applyStartConfig: (s, conn) => m.applyStartConfig(s, conn),
      assertSessionWritable: (id) => m.assertSessionWritable(id),
      assertTaskWritable: (ws, task) => m.assertTaskWritable(ws, task),
      attach: (s) => m.attach(s),
      attachMcp: (s, ctx) => m.attachMcp(s, ctx),
      get bus() { return m.bus },
      cacheAgentConfig: (s) => m.cacheAgentConfig(s),
      createPreparedDraft: (ws, task, prepared, inherit) => m.createPreparedDraft(ws, task, prepared, inherit),
      createSession: (ref, repos, agentId, startPrompt, action, mcp, autoAllow, configValues, role, skills, network, repoModes) => m.createSession(ref, repos, agentId, startPrompt, action, mcp, autoAllow, configValues, role, skills, network, repoModes),
      defaultTitleForRole: (ref, role, excludeId) => m.defaultTitleForRole(ref, role, excludeId),
      deleteSession: (sessionId) => m.deleteSession(sessionId),
      draftFrom: (source) => m.draftFrom(source),
      emitState: (s, reason, err) => m.emitState(s, reason, err),
      enqueue: (sessionId) => m.enqueue(sessionId),
      get events() { return m.events },
      inheritanceOf: (info) => m.inheritanceOf(info),
      isActive: (s) => m.isActive(s),
      get mask() { return m.mask },
      maskEnabled: () => m.maskEnabled(),
      persistNow: (s) => m.persistNow(s),
      prepareDraft: (ws, req, inherit) => m.prepareDraft(ws, req, inherit),
      push: (s, entry) => m.push(s, entry),
      renameSession: (sessionId, title) => m.renameSession(sessionId, title),
      repoHolder: (s) => m.repoHolder(s),
      resolveDraftEnv: (ws, req) => m.resolveDraftEnv(ws, req),
      schedulePersist: (ref) => m.schedulePersist(ref),
      get sessions() { return m.sessions },
      set sessions(v) { m.sessions = v },
      startMeta: (agent, configValues) => m.startMeta(agent, configValues),
      startNowOrQueue: (sessionId) => m.startNowOrQueue(sessionId)
    }))
  }

  private static persistenceCtx(m: SessionManager): persistence.PersistenceCtx {
    return cachedCtx(m, 'persistence', () => ({
      drainPending: (s) => m.drainPending(s),
      get events() { return m.events },
      flushLog: (s) => m.flushLog(s),
      flushSessions: (sessions) => m.flushSessions(sessions),
      loopOwned: (s) => m.loopOwned(s),
      get pendingSeq() { return m.pendingSeq },
      set pendingSeq(v) { m.pendingSeq = v },
      persistNow: (s) => m.persistNow(s),
      get persistTimers() { return m.persistTimers },
      recordsFor: (ws, task) => m.recordsFor(ws, task),
      get sessions() { return m.sessions },
      sessionsFor: (ws, task) => m.sessionsFor(ws, task),
      watcherPaused: (s) => m.watcherPaused(s)
    }))
  }

  private static promptsCtx(m: SessionManager): prompts.PromptsCtx {
    return cachedCtx(m, 'prompts', () => ({
      assertSessionWritable: (id) => m.assertSessionWritable(id),
      get bus() { return m.bus },
      get connections() { return m.connections },
      drainPending: (s) => m.drainPending(s),
      dropAuto: (s, which, finalWithdrawn) => m.dropAuto(s, which, finalWithdrawn),
      endWatcher: (sessionId, end) => m.endWatcher(sessionId, end),
      human: (s, did) => m.human(s, did),
      get pendingSeq() { return m.pendingSeq },
      set pendingSeq(v) { m.pendingSeq = v },
      persistNow: (s) => m.persistNow(s),
      queuedWakes: (s) => m.queuedWakes(s),
      schedule: () => m.schedule(),
      schedulePersist: (ref) => m.schedulePersist(ref),
      get sessions() { return m.sessions }
    }))
  }

  private static agentEventsCtx(m: SessionManager): agentEvents.AgentEventsCtx {
    return cachedCtx(m, 'agentEvents', () => ({
      get agentKinds() { return m.agentKinds },
      append: (s, record) => m.append(s, record),
      get bus() { return m.bus },
      bySessionId: (acpSessionId) => m.bySessionId(acpSessionId),
      cacheAgentConfig: (s) => m.cacheAgentConfig(s),
      cacheHint: (s) => m.cacheHint(s),
      createAgentDraft: (spawnerId, req) => m.createAgentDraft(spawnerId, req),
      get events() { return m.events },
      onComplete: (sessionId, p) => m.onComplete(sessionId, p),
      onSubmitReview: (sessionId, v) => m.onSubmitReview(sessionId, v),
      proactiveHooks: (s) => m.proactiveHooks(s),
      push: (s, entry) => m.push(s, entry),
      get sessions() { return m.sessions },
      toolDetail: (content) => m.toolDetail(content),
      vocabulary: (s) => m.vocabulary(s)
    }))
  }

  private static turnsCtx(m: SessionManager): turns.TurnsCtx {
    return cachedCtx(m, 'turns', () => ({
      get agentKinds() { return m.agentKinds },
      assertNotStopped: (s) => m.assertNotStopped(s),
      attach: (s) => m.attach(s),
      get bus() { return m.bus },
      clearLimited: (s) => m.clearLimited(s),
      decideTurn: (s, outcome, isNudge) => m.decideTurn(s, outcome, isNudge),
      deliveryActive: (s) => m.deliveryActive(s),
      drainPending: (s) => m.drainPending(s),
      earlierQueueItem: (s) => m.earlierQueueItem(s),
      get events() { return m.events },
      isWakeWork: (p) => m.isWakeWork(p),
      limitHold: (s) => m.limitHold(s),
      get loopHooks() { return m.loopHooks },
      get mask() { return m.mask },
      maskEnabled: () => m.maskEnabled(),
      onLimited: (s, limit) => m.onLimited(s, limit),
      onWakeFailed: (s, reason) => m.onWakeFailed(s, reason),
      onWatcherIncomplete: (s) => m.onWatcherIncomplete(s),
      persistNow: (s) => m.persistNow(s),
      promptBlocks: (s, text, context, images) => m.promptBlocks(s, text, context, images),
      push: (s, entry) => m.push(s, entry),
      repoHolder: (s) => m.repoHolder(s),
      reportTurn: (s, startedAt, outcome, detail) => m.reportTurn(s, startedAt, outcome, detail),
      runPrompt: (s, text, context, images, loop) => m.runPrompt(s, text, context, images, loop),
      schedule: () => m.schedule(),
      schedulePersist: (ref) => m.schedulePersist(ref),
      sendTurn: (s, text, entryKind, isNudge, context, images, loop) => m.sendTurn(s, text, entryKind, isNudge, context, images, loop),
      get sessions() { return m.sessions },
      settleTurn: (s, turn, how) => m.settleTurn(s, turn, how),
      vocabulary: (s) => m.vocabulary(s),
      watcherPaused: (s) => m.watcherPaused(s),
      withLimit: (s, outcome, detail, firstEntry) => m.withLimit(s, outcome, detail, firstEntry)
    }))
  }

  private static startCtx(m: SessionManager): start.StartCtx {
    return cachedCtx(m, 'start', () => ({
      get agentKinds() { return m.agentKinds },
      applyAutoAllow: (s, conn) => m.applyAutoAllow(s, conn),
      applyStartConfig: (s, conn) => m.applyStartConfig(s, conn),
      assertSessionWritable: (id) => m.assertSessionWritable(id),
      attach: (s) => m.attach(s),
      attachMcp: (s, ctx) => m.attachMcp(s, ctx),
      get bus() { return m.bus },
      cacheAgentConfig: (s) => m.cacheAgentConfig(s),
      connection: (s, ctx) => m.connection(s, ctx),
      get detachEpoch() { return m.detachEpoch },
      emitState: (s, reason, err) => m.emitState(s, reason, err),
      get events() { return m.events },
      gurtHooks: (s) => m.gurtHooks(s),
      keepOAuthScopeFresh: (s, ctx, selection, planOpts, pushedPlan) => m.keepOAuthScopeFresh(s, ctx, selection, planOpts, pushedPlan),
      get mask() { return m.mask },
      maskEnabled: () => m.maskEnabled(),
      materializeSkills: (s) => m.materializeSkills(s),
      noteUnattachedMcp: (s, attached) => m.noteUnattachedMcp(s, attached),
      push: (s, entry) => m.push(s, entry),
      pushConfigOption: (s, conn, configId, value) => m.pushConfigOption(s, conn, configId, value),
      repoConflict: (s) => m.repoConflict(s),
      runPrompt: (s, text, context, images, loop) => m.runPrompt(s, text, context, images, loop),
      schedule: () => m.schedule(),
      schedulePersist: (ref) => m.schedulePersist(ref),
      get sessions() { return m.sessions },
      startMeta: (agent, configValues) => m.startMeta(agent, configValues),
      vocabulary: (s) => m.vocabulary(s)
    }))
  }

  private static connectionCtx(m: SessionManager): connection.ConnectionCtx {
    return cachedCtx(m, 'connection', () => ({
      applyAutoAllow: (s, conn) => m.applyAutoAllow(s, conn),
      applyStartConfig: (s, conn) => m.applyStartConfig(s, conn),
      get attachesInFlight() { return m.attachesInFlight },
      attachMcp: (s, ctx) => m.attachMcp(s, ctx),
      attachUncoalesced: (s) => m.attachUncoalesced(s),
      get bus() { return m.bus },
      cacheAgentConfig: (s) => m.cacheAgentConfig(s),
      connection: (s, ctx) => m.connection(s, ctx),
      get connections() { return m.connections },
      connectionUncoalesced: (s, ctx) => m.connectionUncoalesced(s, ctx),
      get connectsInFlight() { return m.connectsInFlight },
      get detachEpoch() { return m.detachEpoch },
      get events() { return m.events },
      get mask() { return m.mask },
      maskEnabled: () => m.maskEnabled(),
      onPermission: (params) => m.onPermission(params),
      onSessionUpdate: (params) => m.onSessionUpdate(params),
      push: (s, entry) => m.push(s, entry),
      repoConflict: (s) => m.repoConflict(s),
      get sessions() { return m.sessions },
      startMeta: (agent, configValues) => m.startMeta(agent, configValues)
    }))
  }

  private static wakeCtx(m: SessionManager): wake.WakeCtx {
    return cachedCtx(m, 'wake', () => ({
      get agentAccounts() { return m.agentAccounts },
      get bootAt() { return m.bootAt },
      get bus() { return m.bus },
      drainPending: (s) => m.drainPending(s),
      endWatcher: (sessionId, end) => m.endWatcher(sessionId, end),
      get events() { return m.events },
      isWakeWork: (p) => m.isWakeWork(p),
      limitHold: (s) => m.limitHold(s),
      get limitTimer() { return m.limitTimer },
      set limitTimer(v) { m.limitTimer = v },
      get pendingSeq() { return m.pendingSeq },
      set pendingSeq(v) { m.pendingSeq = v },
      persistNow: (s) => m.persistNow(s),
      push: (s, entry) => m.push(s, entry),
      queuedWakes: (s) => m.queuedWakes(s),
      schedule: () => m.schedule(),
      schedulePersist: (ref) => m.schedulePersist(ref),
      get sessions() { return m.sessions },
      wakeBlock: (s) => m.wakeBlock(s),
      get watcherHooks() { return m.watcherHooks },
      watcherPaused: (s) => m.watcherPaused(s)
    }))
  }

  private static queueCtx(m: SessionManager): queue.QueueCtx {
    return cachedCtx(m, 'queue', () => ({
      activeSessionCount: (ws, task) => m.activeSessionCount(ws, task),
      armLimitTimer: (holds, instants) => m.armLimitTimer(holds, instants),
      get bus() { return m.bus },
      capExempt: (s) => m.capExempt(s),
      claims: (s) => m.claims(s),
      deliveryActive: (s) => m.deliveryActive(s),
      drainPending: (s) => m.drainPending(s),
      earlierQueueItem: (s) => m.earlierQueueItem(s),
      enqueue: (sessionId) => m.enqueue(sessionId),
      get frozenTasks() { return m.frozenTasks },
      holdsClone: (s) => m.holdsClone(s),
      holdText: (h) => m.holdText(h),
      isActive: (s) => m.isActive(s),
      limitHold: (s) => m.limitHold(s),
      loopHoldConflict: (s) => m.loopHoldConflict(s),
      get loopHolds() { return m.loopHolds },
      loopHoldText: (c, does) => m.loopHoldText(c, does),
      get loopHooks() { return m.loopHooks },
      noteQueued: (s, reason, by) => m.noteQueued(s, reason, by),
      get queuedReasons() { return m.queuedReasons },
      queuedSessions: () => m.queuedSessions(),
      queueTime: (s) => m.queueTime(s),
      repoConflict: (s) => m.repoConflict(s),
      repoHolder: (s) => m.repoHolder(s),
      schedule: () => m.schedule(),
      get sessions() { return m.sessions },
      startSession: (sessionId, by) => m.startSession(sessionId, by),
      get taskCaps() { return m.taskCaps },
      wakePass: (holds) => m.wakePass(holds)
    }))
  }

}

