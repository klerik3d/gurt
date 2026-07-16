import { randomUUID } from 'node:crypto'
import type {
  AcpHttpMcpServer,
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
  SessionModes,
  SessionSnapshot
} from '../shared/types'
import type { AgentDef } from '../shared/agents'
import { connKey, envKey, taskKey } from '../shared/keys'
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
  entries: ChatEntry[]
  nextEntryId: number
  /** Container workspace folder (agent cwd), set when the env is resolved this run.
   *  Used to turn repo-relative context paths into absolute `file://` resource links. */
  remoteCwd?: string
  busy: boolean
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

export interface SessionEvents {
  onSessionsChanged: () => void
  onSessionChanged: (sessionId: string) => void
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
  /** Current infra status of the env (for the scheduler's free-repo predicate). */
  envStatus: (ref: EnvRef) => Promise<EnvStatus>
  persist: (ws: string, task: string, records: PersistedSession[]) => void
  /** No session on this env is busy or starting — safe to schedule an idle auto-stop. */
  onEnvIdle: (ref: EnvRef) => void
  /** A session on this env started work (or the user is typing) — cancel any pending auto-stop. */
  onEnvActive: (ref: EnvRef) => void
}

export type CreateAction = 'run' | 'queue' | 'draft'

export class SessionManager {
  private connections = new Map<string, Connection>()
  private sessions = new Map<string, Session>()
  private persistTimers = new Map<string, NodeJS.Timeout>()
  /** (env, agent) pairs whose adapter is installed this app run. */
  private installedAdapters = new Set<string>()

  constructor(private events: SessionEvents) {}

  /** Load sessions persisted by a previous run; they reattach lazily on prompt. */
  restore(records: PersistedSession[]): void {
    for (const r of records) {
      if (this.sessions.has(r.info.id)) continue
      this.sessions.set(r.info.id, {
        info: r.info,
        ref: { workspace: r.info.workspace, task: r.info.task, repo: r.info.envRepo },
        acpSessionId: r.acpSessionId,
        entries: r.entries,
        nextEntryId: Math.max(0, ...r.entries.map((e) => e.id)) + 1,
        busy: false,
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
        modes: s.modes,
        plan: s.plan,
        commands: s.commands,
        configOptions: s.configOptions,
        promptCapabilities: this.connections.get(connKey(s.ref, s.info.agent ?? ''))
          ?.promptCapabilities,
        startError: s.startError,
        queuePosition: this.queuePosition(sessionId)
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
      entries: [],
      nextEntryId: 1,
      busy: false,
      attached: false,
      loading: false,
      pendingPermissions: new Map()
    })
    this.events.onSessionsChanged()
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
    this.events.onSessionsChanged()
    this.schedulePersist(s.ref)
    this.schedule()
  }

  /** Cancel a queued session — back to draft. */
  cancelQueue(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s || s.info.state !== 'queued') return
    s.info.state = 'draft'
    s.info.queuedAt = undefined
    this.events.onSessionsChanged()
    this.schedulePersist(s.ref)
  }

  editPrompt(sessionId: string, text: string): void {
    const s = this.sessions.get(sessionId)
    if (!s || s.info.state !== 'draft') return
    s.info.startPrompt = text
    this.events.onSessionChanged(sessionId)
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
    this.schedulePersist(s.ref)
    this.events.onSessionsChanged()
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
    this.events.onEnvActive(s.ref)
    s.info.state = 'starting'
    s.info.queuedAt = undefined
    s.startError = undefined
    this.events.onSessionsChanged()
    this.events.onSessionChanged(sessionId)
    try {
      const ctx = await this.events.resolveEnv(s.ref, s.info.agent!, s.info.gitAccess ?? false)
      s.remoteCwd = ctx.remoteWorkspaceFolder
      const conn = await this.connection(s.ref, s.info.agent!, ctx)
      const mcpServers = await this.events.resolveMcpServers(s.ref, s.info.mcp)
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
      this.events.onSessionsChanged()
      this.schedulePersist(s.ref)
      await this.runPrompt(s, s.info.startPrompt)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      s.info.state = 'draft'
      s.info.queuedAt = undefined
      s.startError = message
      this.push(s, { kind: 'system', text: `start failed: ${message}` })
      this.events.onSessionsChanged()
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
    this.events.onSessionsChanged()
  }

  private schedulePersist(ref: EnvRef): void {
    const key = taskKey(ref.workspace, ref.task)
    clearTimeout(this.persistTimers.get(key))
    this.persistTimers.set(
      key,
      setTimeout(() => {
        const records: PersistedSession[] = [...this.sessions.values()]
          .filter((s) => taskKey(s.ref.workspace, s.ref.task) === key)
          .map((s) => {
            const info = { ...s.info }
            // `starting` is runtime-only; persist it as draft (crash-safe).
            if (info.state === 'starting') {
              info.state = 'draft'
              info.queuedAt = undefined
            }
            return { info, acpSessionId: s.acpSessionId, entries: s.entries }
          })
        this.events.persist(ref.workspace, ref.task, records)
      }, 300)
    )
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
        for (const resolve of s.pendingPermissions.values())
          resolve({ outcome: { outcome: 'cancelled' } })
        s.pendingPermissions.clear()
        if (s.busy) {
          s.busy = false
          this.push(s, { kind: 'system', text: 'agent process exited' })
        }
      }
      // A crashed adapter leaves its sessions idle — reconsider the auto-stop.
      this.checkEnvIdle(ref)
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
      s.loading = true
      this.push(s, { kind: 'system', text: 'resuming session...' })
      try {
        const mcpServers = await this.events.resolveMcpServers(s.ref, s.info.mcp)
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
        this.push(s, { kind: 'system', text: 'session resumed' })
      } catch (e) {
        this.push(s, {
          kind: 'system',
          text: `could not resume (${e instanceof Error ? e.message : e}) — create a new session`
        })
        throw e
      } finally {
        s.loading = false
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

  private async runPrompt(
    s: Session,
    text: string,
    context?: PromptContext[],
    images?: PromptImage[]
  ): Promise<void> {
    this.events.onEnvActive(s.ref)
    this.push(s, { kind: 'user', text })
    s.busy = true
    this.events.onSessionChanged(s.info.id)
    try {
      const conn = await this.attach(s)
      const result = await conn.peer.request<{ stopReason?: string }>('session/prompt', {
        sessionId: s.acpSessionId,
        prompt: this.promptBlocks(s, text, context, images)
      })
      const reason = result?.stopReason
      if (reason && reason !== 'end_turn')
        this.push(s, { kind: 'system', text: `stopped: ${reason}` })
    } catch (e) {
      this.push(s, { kind: 'system', text: `error: ${e instanceof Error ? e.message : e}` })
    } finally {
      s.busy = false
      this.events.onSessionChanged(s.info.id)
      this.schedulePersist(s.ref)
      this.checkEnvIdle(s.ref)
    }
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

  /** Schedule an idle auto-stop once every session sharing this env has finished its turn. */
  private checkEnvIdle(ref: EnvRef): void {
    if (this.isEnvIdle(ref)) this.events.onEnvIdle(ref)
  }

  /** Ping from the UI (e.g. typing in the composer) — postpones a pending auto-stop. */
  activity(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    this.events.onEnvActive(s.ref)
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
    await this.runPrompt(s, text, context, images)
  }

  cancel(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const conn = this.connections.get(connKey(s.ref, s.info.agent ?? ''))
    if (s.acpSessionId) conn?.peer.notify('session/cancel', { sessionId: s.acpSessionId })
    for (const resolve of s.pendingPermissions.values())
      resolve({ outcome: { outcome: 'cancelled' } })
    s.pendingPermissions.clear()
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
    this.events.onSessionChanged(sessionId)
    this.schedulePersist(s.ref)
  }

  respondPermission(sessionId: string, entryId: number, optionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const resolve = s.pendingPermissions.get(entryId)
    if (!resolve) return
    s.pendingPermissions.delete(entryId)
    const entry = s.entries.find((e) => e.id === entryId)
    if (entry && entry.kind === 'permission') entry.chosen = optionId
    resolve({ outcome: { outcome: 'selected', optionId } })
    this.events.onSessionChanged(sessionId)
    this.schedulePersist(s.ref)
  }

  private bySessionId(acpSessionId: string): Session | undefined {
    return [...this.sessions.values()].find((s) => s.acpSessionId === acpSessionId)
  }

  private push(s: Session, entry: ChatEntryBase): ChatEntry {
    const full = { ...entry, id: s.nextEntryId++ }
    s.entries.push(full)
    this.events.onSessionChanged(s.info.id)
    this.schedulePersist(s.ref)
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
    this.events.onSessionChanged(sessionId)
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
          last.text += text
          this.events.onSessionChanged(s.info.id)
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
          if (u.status) entry.status = u.status
          if (u.title) entry.title = u.title
          const detail = this.toolDetail(u.content)
          if (detail) entry.detail = detail
          this.events.onSessionChanged(s.info.id)
        }
        break
      }
      case 'plan':
        s.plan = (u.entries ?? []).map((e: any) => ({
          content: e.content,
          priority: e.priority,
          status: e.status
        }))
        this.events.onSessionChanged(s.info.id)
        break
      case 'available_commands_update':
        s.commands = (u.availableCommands ?? []).map((c: any) => ({
          name: c.name,
          description: c.description
        }))
        this.events.onSessionChanged(s.info.id)
        break
      case 'current_mode_update':
        if (s.modes) s.modes.currentModeId = u.currentModeId
        else s.modes = { currentModeId: u.currentModeId, availableModes: [] }
        this.events.onSessionChanged(s.info.id)
        break
      case 'config_option_update':
        s.configOptions = normalizeConfigOptions(u.configOptions) ?? s.configOptions
        this.events.onSessionChanged(s.info.id)
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

    const entry = this.push(s, { kind: 'permission', title, options })
    return new Promise((resolve) => {
      s.pendingPermissions.set(entry.id, resolve)
    })
  }
}
