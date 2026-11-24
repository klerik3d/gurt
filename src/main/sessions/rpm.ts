import { MCP_DEFS } from '../../shared/mcp'
import {
  sanitizeSessionNetwork,
  sessionRole,
  writeRepos,
  type ChatEntry,
  type ChatEntryBase,
  type EnvRef,
  type McpSelection,
  type SessionInfo,
  type SessionNetwork,
  type SessionRole,
  type SkillSelection
} from '../../shared/types'
import type { PlanHold } from '../../shared/planUsage'
import { chatLineSummary, type RpmChatLine } from '../../rpm/core'
import type { SessionFacts } from '../../rpm/main'
import type { Bus } from '../bus'
import { createLogger } from '../log'
import { turnSeqOf } from './pure'
import type { CreateAction, DraftInheritance, Session } from './types'

const log = createLogger('sessions')

// What RPM asks of the session manager (t3v2 §4.1, `SessionsPort`): host
// messages to an executor, its reviewers, RPM's chat lines, and the facts it
// reads back. The adapter is src/main/rpmPorts/sessions.ts.

/** What rpm.ts needs of the session manager. */
export interface RpmCtx {
  readonly bus: Bus
  createSession(ref: EnvRef, repos: string[], agentId: string, startPrompt: string, action: CreateAction, mcp?: McpSelection[], autoAllow?: boolean, configValues?: Record<string, string | boolean>, role?: SessionRole, skills?: SkillSelection[], network?: SessionNetwork, repoModes?: Partial<Record<string, unknown>>): SessionInfo
  drainPending(s: Session): Promise<void>
  inheritanceOf(info: SessionInfo): DraftInheritance
  limitHold(s: Session): PlanHold | undefined
  pendingSeq: number
  persistNow(s: Session): Promise<void>
  push(s: Session, entry: ChatEntryBase): ChatEntry
  readonly sessions: Map<string, Session>
  startNowOrQueue(sessionId: string): void
}

/** Where RPM's message with this key is (t3v2 §4.1 `sent`). */
export function sent(mgr: RpmCtx, sessionId: string, key: string): 'queued' | 'taken' | 'unknown' {
  const s = mgr.sessions.get(sessionId)
  if (!s) return 'unknown'
  if (s.pending.some((p) => p.origin && 'rpm' in p.origin && p.origin.rpm === key)) return 'queued'
  if (s.rpmTaken?.includes(key) || s.turn?.key === key || s.carry?.key === key || s.lastSettled?.key === key) return 'taken'
  return 'unknown'
}

/**
 * A host message to an executor (t3v2 §4.1 `send`): queued like a typed one
 * but not the user's act — `auto`, kept when the user types, it does not
 * resume an interrupted session. The chat shows it as `line`. Idempotent by
 * key: a message already queued or taken is not queued again.
 */
export async function send(mgr: RpmCtx, sessionId: string, m: { key: string; text: string; line: RpmChatLine }): Promise<void> {
  const s = mgr.sessions.get(sessionId)
  if (!s) throw new Error('unknown session')
  if (sent(mgr, sessionId, m.key) !== 'unknown') return
  if (s.info.state !== 'started') throw new Error('session is not started')
  const id = `p${++mgr.pendingSeq}`
  s.pending.push({ id, queuedAt: new Date().toISOString(), text: m.text, auto: true, origin: { rpm: m.key, line: m.line } })
  await mgr.persistNow(s)
  void mgr.drainPending(s)
  // Same as a typed prompt: a message still waiting is announced now, and the
  // queue handoff hears that the clone is wanted.
  if (s.pending.some((p) => p.id === id)) {
    mgr.bus.emit('session.changed', { sessionId })
    mgr.bus.emit('session.promptQueued', { sessionId })
  }
}

/** RPM's service line in the session's chat (t3v2 §10.2); its entry id. */
export function chatLine(mgr: RpmCtx, sessionId: string, line: RpmChatLine): number | undefined {
  const s = mgr.sessions.get(sessionId)
  if (!s) return undefined
  return mgr.push(s, { kind: 'system', text: chatLineSummary(line), rpm: line }).id
}

/**
 * Create a reviewer and start it at once (t3v2 §6.4): in the executor's scope
 * with its env and inheritance (auto-allow, skills, network, MCP with the
 * built-ins cut to read-only), every repo `read`, the requested agent, options,
 * title and prompt. Idempotent by key (`reviewerOf.key`). Persisted before it
 * starts, so a crash in between leaves the record the next call finds. Exempt
 * from the scope's cap; a plan hold on its account queues it.
 */
export async function createReviewer(mgr: RpmCtx, r: {
  key: string
  executor: string
  agent: string
  options: Record<string, string | boolean>
  title: string
  prompt: string
  line: RpmChatLine
}): Promise<string> {
  for (const s of mgr.sessions.values()) if (s.info.reviewerOf?.key === r.key) return s.info.id
  const ex = mgr.sessions.get(r.executor)
  if (!ex) throw new Error('unknown session')
  const inherit = mgr.inheritanceOf(ex.info)
  const info = mgr.createSession(
    ex.ref,
    [...ex.info.repos],
    r.agent,
    r.prompt,
    'draft',
    (inherit.mcp ?? []).map((m) => (MCP_DEFS.some((d) => d.id === m.id) ? { ...m, mode: 'read-only' as const } : { ...m })),
    inherit.autoAllow ?? true,
    { ...r.options },
    'reviewer',
    inherit.skills?.map((k) => ({ ...k })),
    sanitizeSessionNetwork(inherit.network),
    Object.fromEntries(ex.info.repos.map((repo) => [repo, 'read' as const]))
  )
  const s = mgr.sessions.get(info.id)!
  s.info.reviewerOf = { executor: r.executor, key: r.key }
  s.info.title = r.title
  s.startLine = r.line
  await mgr.persistNow(s)
  mgr.bus.emit('tree.changed', undefined)
  log.info('session.reviewer', { s: info.id, executor: r.executor, key: r.key })
  mgr.startNowOrQueue(info.id)
  return info.id
}

/** What the user typed to this session after turn `afterTurnId` (or from the
 *  start): the user messages that opened its logical turns. */
export function userPrompts(mgr: RpmCtx, sessionId: string, afterTurnId?: string): string[] {
  const s = mgr.sessions.get(sessionId)
  if (!s) return []
  const after = afterTurnId === undefined ? 0 : turnSeqOf(afterTurnId)
  // TODO(rpm): the texts are as the agent saw them — masked tokens stay tokens.
  return s.entries.flatMap((e) => (e.kind === 'user' && e.turn && turnSeqOf(e.turn) > after ? [e.text] : []))
}

/** The write clones' snapshot before the user message that opened this turn. */
export function checkpointBefore(mgr: RpmCtx, sessionId: string, turnId: string): { repo: string; commit: string }[] | undefined {
  const e = mgr.sessions.get(sessionId)?.entries.find((x) => x.kind === 'user' && x.turn === turnId)
  return e?.kind === 'user' && e.checkpoint?.length ? e.checkpoint.map((c) => ({ ...c })) : undefined
}

/** `SessionFacts` (t3v2 §4.1 `info`). */
export function facts(mgr: RpmCtx, sessionId: string): SessionFacts | undefined {
  const s = mgr.sessions.get(sessionId)
  if (!s) return undefined
  const until = mgr.limitHold(s)?.until
  return {
    id: s.info.id,
    ws: s.ref.workspace,
    task: s.ref.task,
    title: s.info.title,
    role: sessionRole(s.info),
    agent: s.info.agent ?? '',
    writeRepos: writeRepos(s.info),
    state: s.info.state,
    ...(until ? { planHoldUntil: until } : {}),
    ...(s.info.reviewerOf ? { reviewerOf: { ...s.info.reviewerOf } } : {})
  }
}
