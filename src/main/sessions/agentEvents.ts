import { mcpToolOf, type Vocabulary } from '../../shared/agentVocabulary'
import {
  repoMode,
  roleReadsAdmin,
  sessionRole,
  writeRepos,
  type AgentSessionRequest,
  type ChangeProposal,
  type ChatEntry,
  type ChatEntryBase,
  type PermissionOption,
  type RepoMode,
  type SessionRole,
  type StoredProposal
} from '../../shared/types'
import {
  COMMANDS_UPDATE,
  CONFIG_OPTION_UPDATE,
  MODE_UPDATE,
  PERMISSION_REQUEST,
  PLAN_UPDATE,
  SESSION_UPDATE,
  TEXT_CHUNK,
  TOOL_CALL,
  USAGE_UPDATE,
  parseOrDrop,
  type AcpToolContent
} from '../acp'
import { agentMain } from '../agentPlugins'
import type { Bus } from '../bus'
import type { AdminHooks, ProactiveHooks, WatcherToolHooks } from '../mcp/gurtServer'
import { logPhase } from '../provision'
import { normalizeConfigOptions } from './modes'
import { isTerminalToolStatus } from './pure'
import { assertProposalFits } from './turnContract'
import type { NewLogRecord, Session, SessionEvents } from './types'

// What the agent says back: ACP `session/update` notifications and permission
// requests, and the calls its `gurt` tools make into the host (`complete`, ...).

/** What agentEvents.ts needs of the session manager: its state and the manager's own
 *  operations it calls back into. */
export interface AgentEventsCtx {
  readonly agentKinds: Map<string, string>
  append(s: Session, record: NewLogRecord): void
  readonly bus: Bus
  bySessionId(acpSessionId: string): Session | undefined
  cacheAgentConfig(s: Session): void
  cacheHint(s: Session): { cacheSeconds?: number }
  createAgentDraft(spawnerId: string, req: AgentSessionRequest): Promise<{ sessionId: string; title: string }>
  readonly events: SessionEvents
  onComplete(sessionId: string, p: ChangeProposal): void
  proactiveHooks(s: Session): ProactiveHooks
  push(s: Session, entry: ChatEntryBase): ChatEntry
  readonly sessions: Map<string, Session>
  toolDetail(content: AcpToolContent | undefined): string | undefined
  vocabulary(s: Session): Vocabulary
}

export function bySessionId(mgr: AgentEventsCtx, acpSessionId: string): Session | undefined {
  return [...mgr.sessions.values()].find((s) => s.acpSessionId === acpSessionId)
}

/** Flatten ACP tool-call content blocks into a plain-text preview. Tokens stay
 *  tokens here, like every other inbound field — the chat view reveals them. */
export function toolDetail(content: AcpToolContent | undefined): string | undefined {
  if (!content?.length) return undefined
  const parts: string[] = []
  for (const c of content) {
    if (c.type === 'diff') {
      parts.push(`--- ${c.path ?? ''}\n${c.newText ?? ''}`.slice(0, 2000))
    } else if (c.type === 'content' && c.content?.type === 'text') {
      parts.push((c.content.text ?? '').slice(0, 2000))
    }
  }
  return parts.length ? parts.join('\n') : undefined
}

/**
 * A `session/update` notification. The envelope says which session and which
 * variant; each variant parses its own payload, so an adapter that changes
 * the shape of one update (or sends one gurt has never heard of) costs that
 * update only — the timeline around it keeps flowing.
 */
export function onSessionUpdate(mgr: AgentEventsCtx, params: unknown): void {
  const p = parseOrDrop(SESSION_UPDATE, params, 'session/update')
  if (!p?.update) return
  const s = mgr.bySessionId(p.sessionId)
  if (!s || s.loading) return
  if (s.startTiming?.promptSent) {
    logPhase(s.info.id, 'start-to-first-update', Date.now() - s.startTiming.since)
    s.startTiming = undefined
  }
  const raw = p.update
  switch (raw.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const u = parseOrDrop(TEXT_CHUNK, raw, raw.sessionUpdate)
      const kind = raw.sessionUpdate === 'agent_message_chunk' ? 'agent' : 'thought'
      const received = u?.content?.type === 'text' ? (u.content.text ?? '') : ''
      if (!received) return
      // Inbound text goes onto the timeline exactly as the agent wrote it,
      // tokens included: a token split across two chunks is whole again in the
      // accumulated entry, and the chat view reveals it at render time.
      const text = received
      const last = s.entries[s.entries.length - 1]
      const messageId = kind === 'agent' && u?.messageId ? u.messageId : undefined
      // A new message id starts a new entry, so each entry names exactly one
      // fork point; chunks without ids (or of one message) still merge.
      if (last && last.kind === kind && (!messageId || messageId === last.acpMessageId)) {
        mgr.append(s, { type: 'append', id: last.id, text, at: Date.now() })
      } else {
        mgr.push(s, { kind, text, ...(messageId ? { acpMessageId: messageId } : {}) })
      }
      break
    }
    case 'tool_call': {
      const u = parseOrDrop(TOOL_CALL, raw, 'tool_call')
      if (!u) return
      const detail = mgr.toolDetail(u.content)
      mgr.push(s, {
        kind: 'tool',
        toolCallId: u.toolCallId,
        title: u.title ?? u.kind ?? 'tool call',
        status: u.status ?? 'pending',
        ...(u.kind ? { toolKind: u.kind } : {}),
        ...(detail ? { detail } : {}),
        ...(isTerminalToolStatus(u.status) ? { endAt: Date.now() } : {})
      })
      break
    }
    case 'tool_call_update': {
      const u = parseOrDrop(TOOL_CALL, raw, 'tool_call_update')
      if (!u) return
      const entry = s.entries.find((e) => e.kind === 'tool' && e.toolCallId === u.toolCallId)
      if (entry && entry.kind === 'tool') {
        const detail = mgr.toolDetail(u.content)
        mgr.append(s, {
          type: 'patch',
          id: entry.id,
          patch: {
            ...(u.status ? { status: u.status } : {}),
            ...(u.title ? { title: u.title } : {}),
            ...(detail ? { detail } : {}),
            ...(isTerminalToolStatus(u.status) && entry.endAt == null ? { endAt: Date.now() } : {})
          }
        })
      }
      break
    }
    case 'plan': {
      const u = parseOrDrop(PLAN_UPDATE, raw, 'plan')
      if (!u) return
      s.plan = u.entries.map((e) => ({
        content: e.content,
        ...(e.priority ? { priority: e.priority } : {}),
        status: e.status
      }))
      mgr.bus.emit('session.changed', { sessionId: s.info.id })
      break
    }
    case 'available_commands_update': {
      const u = parseOrDrop(COMMANDS_UPDATE, raw, 'available_commands_update')
      if (!u) return
      s.commands = u.availableCommands.map((c) => ({
        name: c.name,
        ...(c.description ? { description: c.description } : {})
      }))
      mgr.cacheAgentConfig(s)
      mgr.bus.emit('session.changed', { sessionId: s.info.id })
      break
    }
    case 'current_mode_update': {
      const u = parseOrDrop(MODE_UPDATE, raw, 'current_mode_update')
      if (!u) return
      if (s.modes) s.modes.currentModeId = u.currentModeId
      else s.modes = { currentModeId: u.currentModeId, availableModes: [] }
      mgr.cacheAgentConfig(s)
      mgr.bus.emit('session.changed', { sessionId: s.info.id })
      break
    }
    case 'config_option_update': {
      const u = parseOrDrop(CONFIG_OPTION_UPDATE, raw, 'config_option_update')
      if (!u) return
      s.configOptions =
        normalizeConfigOptions(u.configOptions, mgr.agentKinds.get(s.info.agent ?? '')) ??
        s.configOptions
      mgr.cacheAgentConfig(s)
      mgr.bus.emit('session.changed', { sessionId: s.info.id })
      break
    }
    case 'usage_update': {
      const u = parseOrDrop(USAGE_UPDATE, raw, 'usage_update')
      if (!u) return
      const agent = s.info.agent
      const usageMeta = agent ? agentMain(mgr.agentKinds.get(agent))?.usageMeta : undefined
      if (agent && usageMeta) {
        // Plan state some adapters attach to their usage reports.
        const state = usageMeta(u._meta ?? undefined)
        if (state.rejected && s.busy) s.turnRejected = true
        if (state.windows.length || state.overage !== undefined || state.rejected !== undefined)
          mgr.bus.emit('agent.planUsage', { agent, ...state })
      }
      s.usage = { used: u.used, size: u.size, ...(u.cost ? { cost: u.cost } : {}) }
      mgr.bus.emit('session.changed', { sessionId: s.info.id })
      break
    }
    default:
      break // user_message_chunk — we add our own copy of the prompt
  }
}

/** Permission requests are always interactive — use session modes (e.g. a
 *  bypass/accept-edits mode) to reduce how often the agent asks. */
export function onPermission(mgr: AgentEventsCtx, params: unknown): unknown {
  const p = parseOrDrop(PERMISSION_REQUEST, params, 'session/request_permission')
  // A request we cannot read is one the user can never answer: refuse it
  // rather than leave the agent waiting on a prompt that was never shown.
  if (!p) return { outcome: { outcome: 'cancelled' } }
  const s = mgr.bySessionId(p.sessionId)
  const options: PermissionOption[] = p.options.map((o) => ({
    optionId: o.optionId,
    name: o.name ?? o.optionId,
    ...(o.kind ? { kind: o.kind } : {})
  }))
  const title = p.toolCall?.title ?? 'permission request'
  if (!s) return { outcome: { outcome: 'cancelled' } }

  // The gurt tools are our own plumbing: every turn must end with `complete`,
  // and `create_session` only ever produces an inert draft the user still has
  // to launch — that launch *is* the approval step, so a permission prompt
  // here is pure friction (and a walked-away session would hang on it).
  // Always allow, no timeline entry. Recognized by the session's agent's own
  // MCP tool-title format (its plugin's `toolTitles`).
  if (mcpToolOf(title, mgr.vocabulary(s).toolTitles)?.server === 'gurt') {
    const allow =
      options.find((o) => o.kind === 'allow_once') ??
      options.find((o) => o.kind?.startsWith('allow'))
    if (allow) return { outcome: { outcome: 'selected', optionId: allow.optionId } }
  }

  const entry = mgr.push(s, { kind: 'permission', title, options })
  return new Promise((resolve) => {
    s.pendingPermissions.set(entry.id, resolve)
    if (s.pendingPermissions.size === 1)
      mgr.bus.emit('session.awaiting', { sessionId: s.info.id, ref: s.ref, awaiting: true })
  })
}

/**
 * A `complete` call landed for this session (via the per-session `gurt` MCP
 * server). Records the turn as complete, stores a proposal when there is work to
 * ship, adds a system timeline line, and — for outcome=changes — emits
 * `session.proposal`, the seam the committer stage consumes. Fires even outside a
 * busy turn (a benign late POST): the proposal/events still update.
 */
export function onComplete(mgr: AgentEventsCtx, sessionId: string, p: ChangeProposal): void {
  const s = mgr.sessions.get(sessionId)
  if (!s) return
  // Before anything is recorded: a refused call is the agent's to correct
  // (an `isError` tool result), not a turn that completed.
  assertProposalFits(writeRepos(s.info), p)
  s.turnComplete = true
  const stored: StoredProposal = { ...p, at: new Date().toISOString() }
  let text: string
  if (p.outcome === 'changes') {
    s.proposal = stored
    const subjects = [
      ...(p.commit ? [p.commit.subject] : []),
      ...(p.repos ?? []).map((r) => `${r.repo}: ${r.commit.subject}`)
    ]
    text = `complete: changes — ${subjects.join('; ')}`
  } else if (p.outcome === 'blocked') {
    text = `complete: blocked — ${p.reason ?? ''}`
  } else {
    text = 'complete: no_changes'
  }
  // push emits session.log + session.changed + schedulePersist.
  mgr.push(s, { kind: 'system', text })
  if (p.outcome === 'changes' && s.proposal)
    mgr.bus.emit('session.proposal', { sessionId, ref: s.ref, proposal: s.proposal })
}

/** What the session's `gurt` server may do on its behalf: the role (which
 *  decides its tool set and instructions) plus the callbacks that route into
 *  this manager. Rebuilt on every start/attach, so a re-ensured server always
 *  talks to the live session record. */
export function gurtHooks(mgr: AgentEventsCtx, s: Session): {
  role: SessionRole
  mounts: { repo: string; mode: RepoMode }[]
  onComplete: (p: ChangeProposal) => void
  onCreateSession: (req: AgentSessionRequest) => Promise<{ sessionId: string; title: string }>
  admin?: AdminHooks
  proactive?: ProactiveHooks
  watcher?: WatcherToolHooks
  cacheSeconds?: number
} {
  const role = sessionRole(s.info)
  return {
    role,
    mounts: s.info.repos.map((repo) => ({ repo, mode: repoMode(s.info, repo) })),
    onComplete: (p) => mgr.onComplete(s.info.id, p),
    onCreateSession: (req) => mgr.createAgentDraft(s.info.id, req),
    // The workspace is bound here, from the session's own record — the one
    // parameter the agent can never express (§3.2 of
    // docs/requirements-session-operator.md).
    // Which half of the surface it gets is the server's to apply, from the
    // role (`roleWritesAdmin`).
    ...(roleReadsAdmin(role) ? { admin: mgr.events.adminFor(s.ref.workspace, s.info.id) } : {}),
    // Same binding for a proactive run: the agent is the scope the run lives
    // in, never a name the run supplies.
    ...(role === 'proactive' ? { proactive: mgr.proactiveHooks(s) } : {}),
    // The watcher's tools, bound the same way (docs/requirements-watchers.md §4).
    ...(role === 'watcher' ? { watcher: mgr.events.watcherFor(s.ref.workspace, s.ref.task, s.info.id) } : {}),
    // §13: the agent kind's cache lifetime, for the watcher's instructions.
    ...(role === 'watcher' ? mgr.cacheHint(s) : {})
  }
}

/** A proactive run's tools, bound to its own workspace, agent and session.
 *  `finish_run` is its turn contract: it satisfies the nudge the way
 *  `complete` does an executor's. */
export function proactiveHooks(mgr: AgentEventsCtx, s: Session): ProactiveHooks {
  const id = s.info.id
  const inner = mgr.events.proactiveFor(s.ref.workspace, s.ref.task, id)
  return {
    ...inner,
    finishRun: async (input) => {
      const result = await inner.finishRun(input)
      const live = mgr.sessions.get(id)
      if (live) {
        live.turnComplete = true
        mgr.push(live, { kind: 'system', text: `finish_run — ${input.summary}` })
      }
      return result
    }
  }
}
