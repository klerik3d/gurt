import { randomUUID } from 'node:crypto'
import type {
  ChatEntry,
  ChatEntryBase,
  EnvRef,
  PermissionOption,
  PersistedSession,
  SessionInfo,
  SessionModes,
  SessionSnapshot
} from '../shared/types'
import type { AgentDef } from '../shared/agents'
import { spawnAcpAdapter } from './provision'
import { JsonRpcPeer } from './jsonrpc'

const envKey = (ref: EnvRef) => `${ref.workspace}/${ref.task}/${ref.repo}`
const taskKey = (ref: EnvRef) => `${ref.workspace}/${ref.task}`

interface Connection {
  peer: JsonRpcPeer
  ref: EnvRef
  kill: () => void
}

interface Session {
  info: SessionInfo
  ref: EnvRef
  acpSessionId: string
  entries: ChatEntry[]
  nextEntryId: number
  busy: boolean
  autoAllow: boolean
  modes?: SessionModes
  plan?: SessionSnapshot['plan']
  commands?: SessionSnapshot['commands']
  /** The live connection knows this ACP session (created or loaded this run). */
  attached: boolean
  /** session/load in progress — drop replayed updates, we keep our own history. */
  loading: boolean
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
}

export interface SessionEvents {
  onSessionsChanged: () => void
  onSessionChanged: (sessionId: string) => void
  resolveEnv: (ref: EnvRef) => Promise<EnvContext>
  persist: (ws: string, task: string, records: PersistedSession[]) => void
}

export class SessionManager {
  private connections = new Map<string, Connection>()
  private sessions = new Map<string, Session>()
  private persistTimers = new Map<string, NodeJS.Timeout>()

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
        autoAllow: false,
        attached: false,
        loading: false,
        pendingPermissions: new Map()
      })
    }
  }

  listForEnv(ref: EnvRef): SessionInfo[] {
    return [...this.sessions.values()]
      .filter((s) => envKey(s.ref) === envKey(ref))
      .map((s) => s.info)
  }

  snapshot(sessionId: string): SessionSnapshot | undefined {
    const s = this.sessions.get(sessionId)
    return (
      s && {
        info: s.info,
        entries: s.entries,
        busy: s.busy,
        autoAllow: s.autoAllow,
        modes: s.modes,
        plan: s.plan,
        commands: s.commands
      }
    )
  }

  /** Kill the adapter process of an environment (env stop/delete). */
  closeEnv(ref: EnvRef): void {
    this.connections.get(envKey(ref))?.kill()
  }

  /** Forget sessions of an environment and persist the removal (env delete). */
  dropEnvSessions(ref: EnvRef): void {
    this.closeEnv(ref)
    for (const [id, s] of this.sessions) if (envKey(s.ref) === envKey(ref)) this.sessions.delete(id)
    this.schedulePersist(ref)
    this.events.onSessionsChanged()
  }

  /** Forget sessions of a whole task without persisting (task dir is removed). */
  dropTaskSessions(ws: string, task: string): void {
    for (const [id, s] of this.sessions) {
      if (s.ref.workspace !== ws || s.ref.task !== task) continue
      this.closeEnv(s.ref)
      this.sessions.delete(id)
    }
    this.events.onSessionsChanged()
  }

  private schedulePersist(ref: EnvRef): void {
    const key = taskKey(ref)
    clearTimeout(this.persistTimers.get(key))
    this.persistTimers.set(
      key,
      setTimeout(() => {
        const records = [...this.sessions.values()]
          .filter((s) => taskKey(s.ref) === key)
          .map((s) => ({ info: s.info, acpSessionId: s.acpSessionId, entries: s.entries }))
        this.events.persist(ref.workspace, ref.task, records)
      }, 300)
    )
  }

  /** One ACP connection (one adapter process) per environment. */
  private async connection(ref: EnvRef, ctx: EnvContext): Promise<Connection> {
    const key = envKey(ref)
    const existing = this.connections.get(key)
    if (existing) return existing

    const child = spawnAcpAdapter(
      ref,
      ctx.agent,
      ctx.configArgs,
      ctx.hostWorkspaceFolder,
      ctx.secret,
      ctx.secretEnv
    )
    child.stderr.on('data', (d: Buffer) => console.error(`[acp ${key}]`, d.toString().trim()))
    const peer = new JsonRpcPeer(child, (err) => console.error(`[acp ${key}]`, err))
    child.on('close', () => {
      this.connections.delete(key)
      for (const s of this.sessions.values()) {
        if (envKey(s.ref) !== key) continue
        s.attached = false
        for (const resolve of s.pendingPermissions.values())
          resolve({ outcome: { outcome: 'cancelled' } })
        s.pendingPermissions.clear()
        if (s.busy) {
          s.busy = false
          this.push(s, { kind: 'system', text: 'agent process exited' })
        }
      }
    })

    peer.onNotification('session/update', (params) => this.onSessionUpdate(params))
    peer.onRequest('session/request_permission', (params) => this.onPermission(params))

    await peer.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
    })

    const conn: Connection = { peer, ref, kill: () => child.kill() }
    this.connections.set(key, conn)
    return conn
  }

  async create(ref: EnvRef): Promise<SessionInfo> {
    const ctx = await this.events.resolveEnv(ref)
    const conn = await this.connection(ref, ctx)
    const result = await conn.peer.request<{ sessionId: string; modes?: SessionModes }>(
      'session/new',
      { cwd: ctx.remoteWorkspaceFolder, mcpServers: [] }
    )
    const info: SessionInfo = {
      id: randomUUID(),
      envRepo: ref.repo,
      task: ref.task,
      workspace: ref.workspace,
      title: `session ${this.listForEnv(ref).length + 1}`,
      agent: ctx.agent.id
    }
    this.sessions.set(info.id, {
      info,
      ref,
      acpSessionId: result.sessionId,
      entries: [],
      nextEntryId: 1,
      busy: false,
      autoAllow: false,
      modes: result.modes ?? undefined,
      attached: true,
      loading: false,
      pendingPermissions: new Map()
    })
    this.events.onSessionsChanged()
    this.schedulePersist(ref)
    return info
  }

  /** Reconnect a restored session: spawn the adapter if needed and session/load. */
  private async attach(s: Session): Promise<Connection> {
    const ctx = await this.events.resolveEnv(s.ref)
    const conn = await this.connection(s.ref, ctx)
    if (!s.attached) {
      s.loading = true
      this.push(s, { kind: 'system', text: 'resuming session...' })
      try {
        const result = await conn.peer.request<{ modes?: SessionModes }>('session/load', {
          sessionId: s.acpSessionId,
          cwd: ctx.remoteWorkspaceFolder,
          mcpServers: []
        })
        s.modes = result?.modes ?? s.modes
        s.attached = true
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

  async prompt(sessionId: string, text: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error('unknown session')
    this.push(s, { kind: 'user', text })
    s.busy = true
    this.events.onSessionChanged(sessionId)
    try {
      const conn = await this.attach(s)
      const result = await conn.peer.request<{ stopReason?: string }>('session/prompt', {
        sessionId: s.acpSessionId,
        prompt: [{ type: 'text', text }]
      })
      const reason = result?.stopReason
      if (reason && reason !== 'end_turn')
        this.push(s, { kind: 'system', text: `stopped: ${reason}` })
    } catch (e) {
      this.push(s, { kind: 'system', text: `error: ${e instanceof Error ? e.message : e}` })
    } finally {
      s.busy = false
      this.events.onSessionChanged(sessionId)
      this.schedulePersist(s.ref)
    }
  }

  cancel(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const conn = this.connections.get(envKey(s.ref))
    conn?.peer.notify('session/cancel', { sessionId: s.acpSessionId })
    for (const resolve of s.pendingPermissions.values())
      resolve({ outcome: { outcome: 'cancelled' } })
    s.pendingPermissions.clear()
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error('unknown session')
    const conn = this.connections.get(envKey(s.ref))
    if (!conn) throw new Error('agent is not running — send a prompt first')
    await conn.peer.request('session/set_mode', { sessionId: s.acpSessionId, modeId })
    if (s.modes) s.modes.currentModeId = modeId
    this.events.onSessionChanged(sessionId)
  }

  setAutoAllow(sessionId: string, value: boolean): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.autoAllow = value
    this.events.onSessionChanged(sessionId)
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
      default:
        break // user_message_chunk — we add our own copy of the prompt
    }
  }

  /** Permission requests: interactive by default, auto-allow per session. */
  private onPermission(params: any): unknown {
    const s = this.bySessionId(params?.sessionId)
    const options: PermissionOption[] = (params?.options ?? []).map((o: any) => ({
      optionId: o.optionId,
      name: o.name ?? o.optionId,
      kind: o.kind
    }))
    const title = params?.toolCall?.title ?? 'permission request'
    if (!s) return { outcome: { outcome: 'cancelled' } }

    if (s.autoAllow) {
      const allow = options.find((o) => o.kind?.startsWith('allow')) ?? options[0]
      this.push(s, { kind: 'permission', title, options, chosen: allow?.optionId ?? 'auto' })
      return { outcome: { outcome: 'selected', optionId: allow?.optionId ?? '' } }
    }

    const entry = this.push(s, { kind: 'permission', title, options })
    return new Promise((resolve) => {
      s.pendingPermissions.set(entry.id, resolve)
    })
  }
}
