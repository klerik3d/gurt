import { randomUUID } from 'node:crypto'
import type {
  AcpHttpMcpServer,
  ChangeProposal,
  ChatEntry,
  ChatEntryBase,
  EnvRef,
  EnvStatus,
  McpSelection,
  PermissionOption,
  PersistedSession,
  PromptCapabilities,
  PromptContext,
  PromptImage,
  SessionConfigOption,
  SessionInfo,
  SessionLogRecord,
  SessionModes,
  SessionSnapshot,
  StoredProposal
} from '../shared/types'
import { applyLog } from '../shared/types'
import type { AgentDef } from '../shared/agents'
import type { CreateAction } from '../shared/api'
import { connKey, envKey, taskKey } from '../shared/keys'
import type { Bus } from './bus'
import { spawnAcpAdapter } from './provision'
import { JsonRpcPeer } from './jsonrpc'

/**
 * Normalize ACP `SessionConfigOption[]` into our flat shape. `select` options may be
 * either a flat list or grouped under headers — we inline groups (prefixing each label
 * with its group name) so the renderer sees one flat option list. Malformed entries are
 * skipped. Returns undefined when the agent reports no config options at all.
 */
function normalizeConfigOptions(raw: unknown[] | undefined): SessionConfigOption[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: SessionConfigOption[] = []
  for (const o of raw as any[]) {
    if (!o || typeof o.id !== 'string' || typeof o.name !== 'string') continue
    if (o.type === 'boolean') {
      out.push({
        id: o.id,
        name: o.name,
        description: o.description ?? undefined,
        category: o.category ?? undefined,
        type: 'boolean',
        currentValue: !!o.currentValue
      })
    } else if (o.type === 'select') {
      const flat: SessionConfigOption['options'] = []
      for (const item of (o.options ?? []) as any[]) {
        if (Array.isArray(item?.options)) {
          for (const v of item.options as any[])
            if (v && typeof v.value === 'string')
              flat.push({ value: v.value, name: `${item.name} · ${v.name ?? v.value}`, description: v.description ?? undefined })
        } else if (item && typeof item.value === 'string') {
          flat.push({ value: item.value, name: item.name ?? item.value, description: item.description ?? undefined })
        }
      }
      out.push({
        id: o.id,
        name: o.name,
        description: o.description ?? undefined,
        category: o.category ?? undefined,
        type: 'select',
        currentValue: typeof o.currentValue === 'string' ? o.currentValue : '',
        options: flat
      })
    }
  }
  return out
}

interface Connection {
  peer: JsonRpcPeer
  ref: EnvRef
  agent: string
  /** Prompt content the agent accepts, from the `initialize` response (agent-level). */
  promptCapabilities?: PromptCapabilities
  kill: () => void
}

interface Session {
  info: SessionInfo
  ref: EnvRef
  acpSessionId?: string
  /** The append-only log; the timeline below is its fold. */
  records: SessionLogRecord[]
  /** seq of the last appended record (monotonic from 1 per session). */
  lastSeq: number
  /** seq of the last record confirmed on disk; a flush appends the rest. */
  flushedSeq: number
  /** A log flush is awaiting its appendLog — don't start a second one. */
  flushInFlight: boolean
  /** Folded timeline, updated incrementally via `applyLog` on every append. */
  entries: ChatEntry[]
  nextEntryId: number
  /** Container workspace folder (agent cwd), set when the env is resolved this run.
   *  Used to turn repo-relative context paths into absolute `file://` resource links. */
  remoteCwd?: string
  busy: boolean
  /** The current turn has seen its `complete` call; reset at each prompt start. */
  turnComplete: boolean
  /** Latest change proposal (outcome=changes) from a `complete` call; last wins. */
  proposal?: StoredProposal
  modes?: SessionModes
  plan?: SessionSnapshot['plan']
  commands?: SessionSnapshot['commands']
  /** Live agent-reported config selectors (model/effort/…), from session/new & updates. */
  configOptions?: SessionConfigOption[]
  /** The live connection knows this ACP session (created or loaded this run). */
  attached: boolean
  /** session/load in progress — drop replayed updates, we keep our own history. */
  loading: boolean
  /** Last failure that put the session back to draft. */
  startError?: string
  /** entry id -> resolver of a pending permission request. */
  pendingPermissions: Map<number, (outcome: unknown) => void>
}

/** Everything needed to (re)spawn the agent process for an environment. */
export interface EnvContext {
  agent: AgentDef
  remoteWorkspaceFolder: string
  hostWorkspaceFolder: string
  configArgs: string[]
  secret: string
  secretEnv: string
  /** Extra env vars for the adapter (e.g. a local model's base URL). */
  env?: Record<string, string>
  /** Git-access injection (§6): broker URL + GIT_CONFIG_*; present only when the
   *  starting session enabled git access. Fixes git access for the shared
   *  (env, agent) adapter at its first spawn. */
  gitBrokerEnv?: Record<string, string>
}

/** Capabilities the session manager needs from the env/mcp/store layers.
 *  Notifications ride the domain bus instead. */
export interface SessionEvents {
  /** Ensure the container is up (clone + up, reusing a stopped container) and
   *  return the agent's launch context. When `gitAccess`, also starts the git
   *  broker, installs shims, and includes the injection env. Throws on failure. */
  resolveEnv: (ref: EnvRef, agentId: string, gitAccess: boolean) => Promise<EnvContext>
  /** Install the agent's adapter packages in the container (idempotent). */
  installAdapter: (ref: EnvRef, ctx: EnvContext) => Promise<void>
  /** Ensure the host MCP servers for this selection are up; return ACP descriptors. */
  resolveMcpServers: (ref: EnvRef, selection: McpSelection[] | undefined) => Promise<AcpHttpMcpServer[]>
  /** Tear down the env's host MCP servers (env stop/delete). */
  stopMcpServers: (ref: EnvRef) => void
  /** Ensure the per-session `gurt` server (the turn contract) is up; return its
   *  ACP descriptor. Attached to every session unconditionally. */
  resolveGurtServer: (
    ref: EnvRef,
    sessionId: string,
    onComplete: (p: ChangeProposal) => void
  ) => Promise<AcpHttpMcpServer>
  /** Tear down one session's `gurt` server (session deleted). */
  stopGurtServer: (sessionId: string) => void
  /** Current infra status of the env (for the scheduler's free-repo predicate). */
  envStatus: (ref: EnvRef) => Promise<EnvStatus>
  persist: (ws: string, task: string, records: PersistedSession[]) => void
  /** Append records to the session's JSONL log (append-only, ordered).
   *  Resolves once the records are on disk — the flush cursor waits for it. */
  appendLog: (ws: string, task: string, sessionId: string, records: SessionLogRecord[]) => Promise<void>
  /** Remove the session's JSONL log (session deleted). */
  deleteLog: (ws: string, task: string, sessionId: string) => void
}

/** A persisted session plus its read (or just-migrated) JSONL log. */
export interface RestoredSession {
  info: SessionInfo
  acpSessionId?: string
  proposal?: StoredProposal
  log: SessionLogRecord[]
}

/** A log record before `append()` stamps its seq (distributive over the union). */
type NewLogRecord = SessionLogRecord extends infer R
  ? R extends SessionLogRecord
    ? Omit<R, 'seq'>
    : never
  : never

export type { CreateAction }

/** The one automatic follow-up sent when a turn ends without `complete`. */
export const NUDGE_PROMPT =
  'You ended your turn without calling the `complete` tool. Call `complete` ' +
  'now with the correct outcome (changes / no_changes / blocked) and do ' +
  'nothing else.'

export type PostTurnAction = 'none' | 'nudge' | 'incomplete'

/**
 * Decide what to do once a turn ends, from whether `complete` was seen. Pure and
 * unit-tested (scripts/turn-contract.test.mjs): only a clean `end_turn` that
 * skipped `complete` triggers healing — one nudge for a regular turn, an
 * `incomplete` mark for the nudge turn itself. A thrown prompt, a cancel, or any
 * non-`end_turn` stop never nudges.
 */
export function postTurnDecision(o: {
  stopReason?: string
  turnComplete: boolean
  threw: boolean
  isNudge: boolean
}): PostTurnAction {
  if (o.threw) return 'none'
  if (o.stopReason !== 'end_turn') return 'none'
  if (o.turnComplete) return 'none'
  return o.isNudge ? 'incomplete' : 'nudge'
}

export class SessionManager {
  private connections = new Map<string, Connection>()
  private sessions = new Map<string, Session>()
  private persistTimers = new Map<string, NodeJS.Timeout>()
  /** (env, agent) pairs whose adapter is installed this app run. */
  private installedAdapters = new Set<string>()

  constructor(
    private events: SessionEvents,
    private bus: Bus
  ) {}

  private emitState(s: Session): void {
    this.bus.emit('session.state', { sessionId: s.info.id, ref: s.ref, state: s.info.state })
  }

  /** Load sessions persisted by a previous run; they reattach lazily on prompt. */
  restore(records: RestoredSession[]): void {
    for (const r of records) {
      if (this.sessions.has(r.info.id)) continue
      const entries = applyLog([], r.log)
      const lastSeq = r.log.length ? r.log[r.log.length - 1].seq : 0
      this.sessions.set(r.info.id, {
        info: r.info,
        ref: { workspace: r.info.workspace, task: r.info.task, repo: r.info.envRepo },
        acpSessionId: r.acpSessionId,
        proposal: r.proposal,
        records: r.log,
        lastSeq,
        flushedSeq: lastSeq,
        flushInFlight: false,
        entries,
        nextEntryId: Math.max(0, ...entries.map((e) => e.id)) + 1,
        busy: false,
        turnComplete: false,
        attached: false,
        loading: false,
        pendingPermissions: new Map()
      })
    }
  }

  listForTask(ws: string, task: string): SessionInfo[] {
    return [...this.sessions.values()]
      .filter((s) => s.ref.workspace === ws && s.ref.task === task)
      .map((s) => this.infoWithRuntime(s))
  }

  /** `info` plus the non-persisted runtime overlay the tree renders as status. */
  private infoWithRuntime(s: Session): SessionInfo {
    return {
      ...s.info,
      busy: s.busy || undefined,
      awaitingInput: s.pendingPermissions.size > 0 || undefined
    }
  }

  private queuePosition(sessionId: string): number | undefined {
    const queued = [...this.sessions.values()]
      .filter((s) => s.info.state === 'queued')
      .sort((a, b) => (a.info.queuedAt ?? '').localeCompare(b.info.queuedAt ?? ''))
    const i = queued.findIndex((s) => s.info.id === sessionId)
    return i < 0 ? undefined : i + 1
  }

  snapshot(sessionId: string): SessionSnapshot | undefined {
    const s = this.sessions.get(sessionId)
    return (
      s && {
        info: this.infoWithRuntime(s),
        entries: s.entries,
        busy: s.busy,
        resuming: s.loading || undefined,
        modes: s.modes,
        plan: s.plan,
        commands: s.commands,
        configOptions: s.configOptions,
        promptCapabilities: this.connections.get(connKey(s.ref, s.info.agent ?? ''))
          ?.promptCapabilities,
        startError: s.startError,
        queuePosition: this.queuePosition(sessionId),
        proposal: s.proposal
      }
    )
  }

  // --- lifecycle: create / run / enqueue / cancel / edit / delete ---------

  createSession(
    ref: EnvRef,
    agentId: string,
    startPrompt: string,
    action: CreateAction,
    mcp: McpSelection[] = [],
    autoAllow = true,
    gitAccess = false
  ): SessionInfo {
    const n = this.listForTask(ref.workspace, ref.task).length + 1
    const info: SessionInfo = {
      id: randomUUID(),
      envRepo: ref.repo,
      task: ref.task,
      workspace: ref.workspace,
      title: `session ${n}`,
      agent: agentId,
      autoAllow,
      state: 'draft',
      mcp,
      gitAccess,
      startPrompt
    }
    this.sessions.set(info.id, {
      info,
      ref,
      records: [],
      lastSeq: 0,
      flushedSeq: 0,
      flushInFlight: false,
      entries: [],
      nextEntryId: 1,
      busy: false,
      turnComplete: false,
      attached: false,
      loading: false,
      pendingPermissions: new Map()
    })
    this.bus.emit('tree.changed', undefined)
    this.emitState(this.sessions.get(info.id)!)
    this.schedulePersist(ref)
    if (action === 'queue') this.enqueue(info.id)
    else if (action === 'run') void this.startSession(info.id)
    return info
  }

  /** Run now — bypass the queue and start immediately. */
  run(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s || s.info.state === 'starting' || s.info.state === 'started') return
    void this.startSession(sessionId)
  }

  enqueue(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s || s.info.state === 'starting' || s.info.state === 'started') return
    s.info.state = 'queued'
    s.info.queuedAt = new Date().toISOString()
    s.startError = undefined
    this.bus.emit('tree.changed', undefined)
    this.emitState(s)
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
    this.emitState(s)
    this.schedulePersist(s.ref)
  }

  editPrompt(sessionId: string, text: string): void {
    const s = this.sessions.get(sessionId)
    if (!s || s.info.state !== 'draft') return
    s.info.startPrompt = text
    this.bus.emit('session.changed', { sessionId })
    this.schedulePersist(s.ref)
  }

  /**
   * Edit a draft's settings before it starts. A draft has no env or connection
   * yet, so re-pointing its repo/agent is safe — the (env, agent) adapter is
   * resolved only at start. Only supplied keys change; unknown ids and
   * non-draft sessions are ignored.
   */
  editDraft(
    sessionId: string,
    patch: {
      agent?: string
      envRepo?: string
      autoAllow?: boolean
      gitAccess?: boolean
      mcp?: McpSelection[]
      startPrompt?: string
    }
  ): void {
    const s = this.sessions.get(sessionId)
    if (!s || s.info.state !== 'draft') return
    if (patch.agent !== undefined) s.info.agent = patch.agent
    if (patch.autoAllow !== undefined) s.info.autoAllow = patch.autoAllow
    if (patch.gitAccess !== undefined) s.info.gitAccess = patch.gitAccess
    if (patch.mcp !== undefined) s.info.mcp = patch.mcp
    if (patch.startPrompt !== undefined) s.info.startPrompt = patch.startPrompt
    if (patch.envRepo !== undefined && patch.envRepo !== s.info.envRepo) {
      s.info.envRepo = patch.envRepo
      s.ref = { ...s.ref, repo: patch.envRepo }
    }
    this.bus.emit('tree.changed', undefined)
    this.bus.emit('session.changed', { sessionId })
    this.schedulePersist(s.ref)
  }

  deleteSession(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    // Adapter connections are shared per (env, agent); leave them for other
    // sessions. Just resolve any pending permission and drop the record.
    for (const resolve of s.pendingPermissions.values())
      resolve({ outcome: { outcome: 'cancelled' } })
    this.sessions.delete(sessionId)
    this.events.deleteLog(s.ref.workspace, s.ref.task, sessionId)
    this.events.stopGurtServer(sessionId)
    this.schedulePersist(s.ref)
    this.bus.emit('tree.changed', undefined)
  }

  // --- scheduler ----------------------------------------------------------

  /**
   * Walk the global FIFO queue and start every item whose start condition
   * currently holds. Items for independent repos may start in one pass; a repo
   * occupied by a just-started item keeps its later items queued.
   */
  schedule(): void {
    void this.scheduleAsync()
  }

  private async scheduleAsync(): Promise<void> {
    const queued = [...this.sessions.values()]
      .filter((s) => s.info.state === 'queued')
      .sort((a, b) => (a.info.queuedAt ?? '').localeCompare(b.info.queuedAt ?? ''))
    const claimed = new Set<string>()
    for (const s of queued) {
      const key = envKey(s.ref)
      if (claimed.has(key)) continue
      if (!(await this.startConditionHolds(s))) continue
      claimed.add(key)
      void this.startSession(s.info.id)
    }
  }

  /**
   * Composable start-condition predicate. The only condition implemented now:
   * the target (task, repo) is free — no session is starting there and the
   * container is down. Future predicates (concurrency limits, priorities,
   * time windows) slot into this array.
   */
  private async startConditionHolds(s: Session): Promise<boolean> {
    const predicates: Array<(s: Session) => boolean | Promise<boolean>> = [
      (s) => this.repoIsFree(s.ref, s.info.id)
    ]
    for (const p of predicates) if (!(await p(s))) return false
    return true
  }

  private async repoIsFree(ref: EnvRef, exceptSessionId: string): Promise<boolean> {
    const key = envKey(ref)
    for (const o of this.sessions.values()) {
      if (o.info.id === exceptSessionId) continue
      if (envKey(o.ref) === key && o.info.state === 'starting') return false
    }
    const status = await this.events.envStatus(ref)
    return status !== 'starting' && status !== 'running'
  }

  /** Provision (if needed), open the ACP session, and send the start prompt. */
  private async startSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s || s.info.state === 'starting' || s.info.state === 'started') return
    this.bus.emit('env.activity', { ref: s.ref })
    s.info.state = 'starting'
    s.info.queuedAt = undefined
    s.startError = undefined
    this.bus.emit('tree.changed', undefined)
    this.emitState(s)
    this.bus.emit('session.changed', { sessionId })
    try {
      const ctx = await this.events.resolveEnv(s.ref, s.info.agent!, s.info.gitAccess ?? false)
      s.remoteCwd = ctx.remoteWorkspaceFolder
      const conn = await this.connection(s.ref, s.info.agent!, ctx)
      const mcpServers = [
        ...(await this.events.resolveMcpServers(s.ref, s.info.mcp)),
        await this.events.resolveGurtServer(s.ref, s.info.id, (p) => this.onComplete(s.info.id, p))
      ]
      const result = await conn.peer.request<{
        sessionId: string
        modes?: SessionModes
        configOptions?: unknown[]
      }>('session/new', { cwd: ctx.remoteWorkspaceFolder, mcpServers })
      s.acpSessionId = result.sessionId
      s.modes = result.modes ?? s.modes
      s.configOptions = normalizeConfigOptions(result.configOptions)
      s.attached = true
      s.info.state = 'started'
      await this.applyAutoAllow(s, conn)
      this.bus.emit('tree.changed', undefined)
      this.emitState(s)
      this.schedulePersist(s.ref)
      await this.runPrompt(s, s.info.startPrompt)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      s.info.state = 'draft'
      s.info.queuedAt = undefined
      s.startError = message
      this.push(s, { kind: 'system', text: `start failed: ${message}` })
      this.bus.emit('tree.changed', undefined)
      this.emitState(s)
      this.schedulePersist(s.ref)
      // A failed start must not block the queue — let the next item try.
      this.schedule()
    }
  }

  // --- connections --------------------------------------------------------

  /** Kill the adapter processes of an environment (all agents) — env stop/delete. */
  closeEnv(ref: EnvRef): void {
    for (const conn of this.connections.values())
      if (envKey(conn.ref) === envKey(ref)) conn.kill()
    this.events.stopMcpServers(ref)
  }

  /** Forget sessions of a whole task without persisting (task dir is removed). */
  dropTaskSessions(ws: string, task: string): void {
    for (const [id, s] of this.sessions) {
      if (s.ref.workspace !== ws || s.ref.task !== task) continue
      this.sessions.delete(id)
    }
    for (const conn of this.connections.values())
      if (conn.ref.workspace === ws && conn.ref.task === task) {
        conn.kill()
        this.events.stopMcpServers(conn.ref)
      }
    this.bus.emit('tree.changed', undefined)
  }

  private schedulePersist(ref: EnvRef): void {
    const key = taskKey(ref.workspace, ref.task)
    clearTimeout(this.persistTimers.get(key))
    this.persistTimers.set(
      key,
      setTimeout(() => {
        const sessions = [...this.sessions.values()].filter(
          (s) => taskKey(s.ref.workspace, s.ref.task) === key
        )
        const records: PersistedSession[] = sessions.map((s) => {
          const info = { ...s.info }
          // `starting` is runtime-only; persist it as draft (crash-safe).
          if (info.state === 'starting') {
            info.state = 'draft'
            info.queuedAt = undefined
          }
          // `incomplete` is a runtime overlay — never persisted.
          delete info.incomplete
          return { info, acpSessionId: s.acpSessionId, proposal: s.proposal }
        })
        this.events.persist(ref.workspace, ref.task, records)
        // Flush each session's unflushed log tail (the JSONL is append-only).
        for (const s of sessions) this.flushLog(s)
      }, 300)
    )
  }

  /** Append the unflushed log tail; `flushedSeq` advances only once the write is
   *  confirmed, so a failed append is retried by the next flush instead of being
   *  silently dropped. One flush per session at a time keeps the tail ordered. */
  private flushLog(s: Session): void {
    if (s.flushInFlight || s.lastSeq <= s.flushedSeq) return
    const upTo = s.lastSeq
    const tail = s.records.filter((r) => r.seq > s.flushedSeq)
    s.flushInFlight = true
    this.events
      .appendLog(s.ref.workspace, s.ref.task, s.info.id, tail)
      .then(
        () => {
          s.flushedSeq = upTo
        },
        (e) => console.error('session-log append failed:', e)
      )
      .then(() => {
        s.flushInFlight = false
        // Records that landed mid-flight (or joined a failed batch) flush now; a
        // failed batch alone waits for the next persist tick. Never resurrect a
        // deleted session's file.
        if (this.sessions.get(s.info.id) === s && s.lastSeq > upTo) this.flushLog(s)
      })
  }

  private async connection(ref: EnvRef, agentId: string, ctx: EnvContext): Promise<Connection> {
    const key = connKey(ref, agentId)
    const existing = this.connections.get(key)
    if (existing) return existing

    if (!this.installedAdapters.has(key)) {
      await this.events.installAdapter(ref, ctx)
      this.installedAdapters.add(key)
    }

    const child = spawnAcpAdapter(
      ref,
      ctx.agent,
      ctx.configArgs,
      ctx.hostWorkspaceFolder,
      ctx.secret,
      ctx.secretEnv,
      ctx.env,
      ctx.gitBrokerEnv
    )
    child.stderr.on('data', (d: Buffer) => console.error(`[acp ${key}]`, d.toString().trim()))
    const peer = new JsonRpcPeer(child, (err) => console.error(`[acp ${key}]`, err))
    child.on('close', () => {
      this.connections.delete(key)
      for (const s of this.sessions.values()) {
        if (connKey(s.ref, s.info.agent ?? '') !== key) continue
        s.attached = false
        const wasAwaiting = s.pendingPermissions.size > 0
        for (const resolve of s.pendingPermissions.values())
          resolve({ outcome: { outcome: 'cancelled' } })
        s.pendingPermissions.clear()
        if (wasAwaiting)
          this.bus.emit('session.awaiting', { sessionId: s.info.id, ref: s.ref, awaiting: false })
        if (s.busy) {
          s.busy = false
          this.push(s, { kind: 'system', text: 'agent process exited' })
        }
        // The in-flight `session/prompt` of a busy session rejects with the peer,
        // so its runPrompt still emits the `session.turn` ended the idle policy needs.
      }
      // Covers the sessions that were NOT busy: the auto-stop policy re-evaluates
      // the env on adapter death even when no turn end will ever fire.
      this.bus.emit('env.adapterExited', { ref, agent: agentId })
    })

    peer.onNotification('session/update', (params) => this.onSessionUpdate(params))
    peer.onRequest('session/request_permission', (params) => this.onPermission(params))

    const init = await peer.request<{
      agentCapabilities?: { promptCapabilities?: PromptCapabilities }
    }>('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        // Opt in to boolean config options so agents may expose native toggles
        // (e.g. Claude's "Fast mode") instead of degrading them to a select.
        session: { configOptions: { boolean: {} } }
      }
    })

    const conn: Connection = {
      peer,
      ref,
      agent: agentId,
      promptCapabilities: init?.agentCapabilities?.promptCapabilities,
      kill: () => child.kill()
    }
    this.connections.set(key, conn)
    return conn
  }

  /** Reconnect a session: spawn the adapter if needed and session/load. */
  private async attach(s: Session): Promise<Connection> {
    const agentId = s.info.agent ?? 'claude-code'
    const existing = this.connections.get(connKey(s.ref, agentId))
    if (existing && s.attached) return existing
    const ctx = await this.events.resolveEnv(s.ref, agentId, s.info.gitAccess ?? false)
    s.remoteCwd = ctx.remoteWorkspaceFolder
    const conn = await this.connection(s.ref, agentId, ctx)
    if (!s.attached) {
      if (!s.acpSessionId) throw new Error('session was never started')
      // Resuming is a live indicator (snapshot.resuming), not chat history —
      // the timeline stays clean of "resuming/resumed" noise.
      s.loading = true
      this.bus.emit('session.changed', { sessionId: s.info.id })
      try {
        const mcpServers = [
          ...(await this.events.resolveMcpServers(s.ref, s.info.mcp)),
          await this.events.resolveGurtServer(s.ref, s.info.id, (p) => this.onComplete(s.info.id, p))
        ]
        const result = await conn.peer.request<{
          modes?: SessionModes
          configOptions?: unknown[]
        }>('session/load', {
          sessionId: s.acpSessionId,
          cwd: ctx.remoteWorkspaceFolder,
          mcpServers
        })
        s.modes = result?.modes ?? s.modes
        s.configOptions = normalizeConfigOptions(result?.configOptions) ?? s.configOptions
        s.attached = true
        await this.applyAutoAllow(s, conn)
      } catch (e) {
        this.push(s, {
          kind: 'system',
          text: `could not resume (${e instanceof Error ? e.message : e}) — create a new session`
        })
        throw e
      } finally {
        s.loading = false
        this.bus.emit('session.changed', { sessionId: s.info.id })
      }
    }
    return conn
  }

  /** Build the ACP prompt content blocks: the message text, a `resource_link` for
   *  every attached context item, and an `image` block per attached image (only sent
   *  when the agent advertised `promptCapabilities.image`). Context paths are resolved
   *  against the container workspace folder so the agent gets an absolute `file://` uri. */
  private promptBlocks(
    s: Session,
    text: string,
    context?: PromptContext[],
    images?: PromptImage[]
  ): unknown[] {
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
  private async sendTurn(
    s: Session,
    text: string,
    entryKind: 'user' | 'system',
    context?: PromptContext[],
    images?: PromptImage[]
  ): Promise<{ stopReason?: string; threw: boolean }> {
    this.bus.emit('env.activity', { ref: s.ref })
    this.push(s, { kind: entryKind, text })
    // Prompt start: the turn is incomplete until `complete` fires; clear any
    // prior violation overlay.
    s.turnComplete = false
    s.info.incomplete = undefined
    s.busy = true
    this.bus.emit('session.changed', { sessionId: s.info.id })
    this.bus.emit('session.turn', { sessionId: s.info.id, ref: s.ref, phase: 'started' })
    try {
      const conn = await this.attach(s)
      const result = await conn.peer.request<{ stopReason?: string }>('session/prompt', {
        sessionId: s.acpSessionId,
        prompt: this.promptBlocks(s, text, context, images)
      })
      const reason = result?.stopReason
      if (reason && reason !== 'end_turn')
        this.push(s, { kind: 'system', text: `stopped: ${reason}` })
      return { stopReason: reason, threw: false }
    } catch (e) {
      this.push(s, { kind: 'system', text: `error: ${e instanceof Error ? e.message : e}` })
      return { threw: true }
    } finally {
      s.busy = false
      this.bus.emit('session.changed', { sessionId: s.info.id })
      this.schedulePersist(s.ref)
      this.bus.emit('session.turn', { sessionId: s.info.id, ref: s.ref, phase: 'ended' })
    }
  }

  /**
   * Send a user prompt, then enforce the turn contract. A turn that ends cleanly
   * without a `complete` call is a protocol violation: because the ACP session is
   * still alive, one automatic follow-up (`NUDGE_PROMPT`) costs seconds and usually
   * heals it. A nudge turn that still skips `complete` marks the session
   * `incomplete` and gives up — no second nudge.
   */
  private async runPrompt(
    s: Session,
    text: string,
    context?: PromptContext[],
    images?: PromptImage[]
  ): Promise<void> {
    const first = await this.sendTurn(s, text, 'user', context, images)
    if (postTurnDecision({ ...first, turnComplete: s.turnComplete, isNudge: false }) !== 'nudge')
      return
    const second = await this.sendTurn(s, NUDGE_PROMPT, 'system')
    if (
      postTurnDecision({ ...second, turnComplete: s.turnComplete, isNudge: true }) === 'incomplete'
    ) {
      this.push(s, { kind: 'system', text: 'turn ended without complete' })
      s.info.incomplete = true
      this.bus.emit('session.changed', { sessionId: s.info.id })
      this.schedulePersist(s.ref)
    }
  }

  /**
   * A `complete` call landed for this session (via the per-session `gurt` MCP
   * server). Records the turn as complete, stores a proposal when there is work to
   * ship, adds a system timeline line, and — for outcome=changes — emits
   * `session.proposal`, the seam the committer stage consumes. Fires even outside a
   * busy turn (a benign late POST): the proposal/events still update.
   */
  private onComplete(sessionId: string, p: ChangeProposal): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.turnComplete = true
    let text: string
    if (p.outcome === 'changes') {
      s.proposal = { ...p, at: new Date().toISOString() }
      text = `complete: changes — ${p.commit?.subject ?? ''}`
    } else if (p.outcome === 'blocked') {
      text = `complete: blocked — ${p.reason ?? ''}`
    } else {
      text = 'complete: no_changes'
    }
    // push emits session.log + session.changed + schedulePersist.
    this.push(s, { kind: 'system', text })
    if (p.outcome === 'changes' && s.proposal)
      this.bus.emit('session.proposal', { sessionId, ref: s.ref, proposal: s.proposal })
  }

  /** Newest stored proposal among this env's sessions (all outcome=changes). */
  latestProposal(ws: string, task: string, repo: string): StoredProposal | undefined {
    let best: StoredProposal | undefined
    for (const s of this.sessions.values()) {
      if (s.ref.workspace !== ws || s.ref.task !== task || s.ref.repo !== repo) continue
      if (!s.proposal) continue
      if (!best || s.proposal.at > best.at) best = s.proposal
    }
    return best
  }

  /** No session sharing this env is busy or mid-start. */
  isEnvIdle(ref: EnvRef): boolean {
    const key = envKey(ref)
    for (const s of this.sessions.values()) {
      if (envKey(s.ref) !== key) continue
      if (s.busy || s.info.state === 'starting') return false
    }
    return true
  }

  /** Ping from the UI (e.g. typing in the composer) — postpones a pending auto-stop. */
  activity(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    this.bus.emit('env.activity', { ref: s.ref })
  }

  async prompt(
    sessionId: string,
    text: string,
    context?: PromptContext[],
    images?: PromptImage[]
  ): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error('unknown session')
    if (s.info.state !== 'started') throw new Error('session is not started')
    // One turn at a time: overlapping prompts would share `turnComplete`, so a
    // `complete` for one turn could silently satisfy the other (and both could
    // nudge). The composer already disables send while busy — this makes the
    // invariant hold for any caller.
    if (s.busy) throw new Error('session is busy')
    await this.runPrompt(s, text, context, images)
  }

  cancel(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const conn = this.connections.get(connKey(s.ref, s.info.agent ?? ''))
    if (s.acpSessionId) conn?.peer.notify('session/cancel', { sessionId: s.acpSessionId })
    const wasAwaiting = s.pendingPermissions.size > 0
    for (const resolve of s.pendingPermissions.values())
      resolve({ outcome: { outcome: 'cancelled' } })
    s.pendingPermissions.clear()
    if (wasAwaiting)
      this.bus.emit('session.awaiting', { sessionId: s.info.id, ref: s.ref, awaiting: false })
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error('unknown session')
    const conn = this.connections.get(connKey(s.ref, s.info.agent ?? ''))
    if (!conn) throw new Error('agent is not running — send a prompt first')
    await conn.peer.request('session/set_mode', { sessionId: s.acpSessionId, modeId })
    if (s.modes) s.modes.currentModeId = modeId
    // Keep the persisted preference in step so a later reattach restores this choice.
    const mode = s.modes?.availableModes.find((m) => m.id === modeId)
    const k = `${mode?.id ?? modeId} ${mode?.name ?? ''}`.toLowerCase()
    if (/bypass|yolo|accept|auto/.test(k)) s.info.autoAllow = true
    else if (/default|manual|ask|confirm/.test(k)) s.info.autoAllow = false
    this.bus.emit('session.changed', { sessionId })
    this.schedulePersist(s.ref)
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

  private bySessionId(acpSessionId: string): Session | undefined {
    return [...this.sessions.values()].find((s) => s.acpSessionId === acpSessionId)
  }

  /** The ONE writer of the session log: assigns seq, applies, announces, persists. */
  private append(s: Session, record: NewLogRecord): void {
    const rec = { ...record, seq: ++s.lastSeq } as SessionLogRecord
    s.records.push(rec)
    s.entries = applyLog(s.entries, [rec])
    this.bus.emit('session.log', { sessionId: s.info.id, records: [rec] })
    // A streaming text delta changes nothing outside the timeline, and the
    // timeline rides session.log — skip the per-chunk snapshot broadcast.
    if (rec.type !== 'append') this.bus.emit('session.changed', { sessionId: s.info.id })
    this.schedulePersist(s.ref)
  }

  private push(s: Session, entry: ChatEntryBase): ChatEntry {
    const full = { ...entry, id: s.nextEntryId++ }
    this.append(s, { type: 'entry', entry: full })
    return full
  }

  /** Change a live agent-reported config option (model, effort, fast-mode, …) via
   *  ACP `session/set_config_option`. The agent echoes back the full option set with
   *  the new current values, which we adopt (some options change others, e.g. picking
   *  a model swaps the available effort levels). */
  async setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error('unknown session')
    const conn = this.connections.get(connKey(s.ref, s.info.agent ?? ''))
    if (!conn) throw new Error('agent is not running — send a prompt first')
    const params =
      typeof value === 'boolean'
        ? { sessionId: s.acpSessionId, configId, type: 'boolean', value }
        : { sessionId: s.acpSessionId, configId, value }
    const res = await conn.peer.request<{ configOptions?: unknown[] }>(
      'session/set_config_option',
      params
    )
    const next = normalizeConfigOptions(res?.configOptions)
    if (next) s.configOptions = next
    this.bus.emit('session.changed', { sessionId })
    this.schedulePersist(s.ref)
  }

  /** Pick the ACP mode that matches the session's auto-allow preference. Modes are
   *  agent-defined, so this is a best-effort match over id/name (mirrors the
   *  renderer's `modeVisual`). Returns undefined if the current mode already fits
   *  or no matching mode is exposed. */
  private desiredModeId(autoAllow: boolean, modes: SessionModes | undefined): string | undefined {
    const list = modes?.availableModes
    if (!list?.length) return undefined
    const has = (m: { id: string; name: string }, ...needles: string[]) => {
      const k = `${m.id} ${m.name}`.toLowerCase()
      return needles.some((n) => k.includes(n))
    }
    const pick = (pred: (m: { id: string; name: string }) => boolean) => list.find(pred)?.id
    const target = autoAllow
      ? // "auto" = auto-accept edits, still confirm the risky stuff. Fall back to
        // a full bypass only for agents that expose no accept/auto mode.
        pick((m) => has(m, 'accept', 'auto')) ?? pick((m) => has(m, 'bypass', 'yolo'))
      : pick((m) => m.id === 'default') ?? pick((m) => has(m, 'default', 'manual', 'ask', 'confirm'))
    if (!target || target === modes!.currentModeId) return undefined
    return target
  }

  /** Switch the freshly (re)opened ACP session into the mode implied by the
   *  session-start auto/manual choice. Best-effort: unknown mode sets are left alone. */
  private async applyAutoAllow(s: Session, conn: Connection): Promise<void> {
    if (!s.acpSessionId) return
    const target = this.desiredModeId(s.info.autoAllow ?? true, s.modes)
    if (!target) return
    try {
      await conn.peer.request('session/set_mode', { sessionId: s.acpSessionId, modeId: target })
      if (s.modes) s.modes.currentModeId = target
    } catch (e) {
      this.push(s, {
        kind: 'system',
        text: `could not set mode: ${e instanceof Error ? e.message : e}`
      })
    }
  }

  /** Flatten ACP tool-call content blocks into a plain-text preview. */
  private toolDetail(content: any[] | undefined): string | undefined {
    if (!content?.length) return undefined
    const parts: string[] = []
    for (const c of content) {
      if (c?.type === 'diff') {
        parts.push(`--- ${c.path}\n${c.newText ?? ''}`.slice(0, 2000))
      } else if (c?.type === 'content' && c.content?.type === 'text') {
        parts.push(String(c.content.text).slice(0, 2000))
      }
    }
    return parts.length ? parts.join('\n') : undefined
  }

  private onSessionUpdate(params: any): void {
    const s = this.bySessionId(params?.sessionId)
    if (!s || s.loading) return
    const u = params.update ?? {}
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const kind = u.sessionUpdate === 'agent_message_chunk' ? 'agent' : 'thought'
        const text = u.content?.type === 'text' ? u.content.text : ''
        if (!text) return
        const last = s.entries[s.entries.length - 1]
        if (last && last.kind === kind) {
          this.append(s, { type: 'append', id: last.id, text })
        } else {
          this.push(s, { kind, text })
        }
        break
      }
      case 'tool_call':
        this.push(s, {
          kind: 'tool',
          toolCallId: u.toolCallId,
          title: u.title ?? u.kind ?? 'tool call',
          status: u.status ?? 'pending',
          toolKind: u.kind,
          detail: this.toolDetail(u.content)
        })
        break
      case 'tool_call_update': {
        const entry = s.entries.find((e) => e.kind === 'tool' && e.toolCallId === u.toolCallId)
        if (entry && entry.kind === 'tool') {
          const detail = this.toolDetail(u.content)
          this.append(s, {
            type: 'patch',
            id: entry.id,
            patch: {
              ...(u.status ? { status: u.status } : {}),
              ...(u.title ? { title: u.title } : {}),
              ...(detail ? { detail } : {})
            }
          })
        }
        break
      }
      case 'plan':
        s.plan = (u.entries ?? []).map((e: any) => ({
          content: e.content,
          priority: e.priority,
          status: e.status
        }))
        this.bus.emit('session.changed', { sessionId: s.info.id })
        break
      case 'available_commands_update':
        s.commands = (u.availableCommands ?? []).map((c: any) => ({
          name: c.name,
          description: c.description
        }))
        this.bus.emit('session.changed', { sessionId: s.info.id })
        break
      case 'current_mode_update':
        if (s.modes) s.modes.currentModeId = u.currentModeId
        else s.modes = { currentModeId: u.currentModeId, availableModes: [] }
        this.bus.emit('session.changed', { sessionId: s.info.id })
        break
      case 'config_option_update':
        s.configOptions = normalizeConfigOptions(u.configOptions) ?? s.configOptions
        this.bus.emit('session.changed', { sessionId: s.info.id })
        break
      default:
        break // user_message_chunk — we add our own copy of the prompt
    }
  }

  /** Permission requests are always interactive — use session modes (e.g. a
   *  bypass/accept-edits mode) to reduce how often the agent asks. */
  private onPermission(params: any): unknown {
    const s = this.bySessionId(params?.sessionId)
    const options: PermissionOption[] = (params?.options ?? []).map((o: any) => ({
      optionId: o.optionId,
      name: o.name ?? o.optionId,
      kind: o.kind
    }))
    const title = params?.toolCall?.title ?? 'permission request'
    if (!s) return { outcome: { outcome: 'cancelled' } }

    // The gurt turn-contract tool is our own plumbing — every turn must end
    // with `complete`, so asking the user to approve it is pure friction (and
    // a walked-away session would hang on it). Always allow, no timeline entry.
    if (/^mcp__gurt__/.test(title)) {
      const allow =
        options.find((o) => o.kind === 'allow_once') ??
        options.find((o) => o.kind?.startsWith('allow'))
      if (allow) return { outcome: { outcome: 'selected', optionId: allow.optionId } }
    }

    const entry = this.push(s, { kind: 'permission', title, options })
    return new Promise((resolve) => {
      s.pendingPermissions.set(entry.id, resolve)
      if (s.pendingPermissions.size === 1)
        this.bus.emit('session.awaiting', { sessionId: s.info.id, ref: s.ref, awaiting: true })
    })
  }
}
