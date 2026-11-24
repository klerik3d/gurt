import { randomUUID } from 'node:crypto'
import type { AgentManifest } from '../../shared/agentPlugin'
import type { SessionDraftPatch } from '../../shared/api'
import type { SessionStateReason } from '../../shared/events'
import { sanitizeSkillSelection } from '../../shared/skills'
import { branchPrompt, rewindPreface } from '../../shared/transcript'
import {
  anchorRepo,
  missingRepoReason,
  normalizeRepoModes,
  repoMode,
  roleDraftsCrossTask,
  sanitizeSessionNetwork,
  sessionRole,
  spawnableRoles,
  writeRepos,
  type AcpHttpMcpServer,
  type AgentSessionRequest,
  type ChatEntry,
  type ChatEntryBase,
  type EnvRef,
  type McpSelection,
  type SessionInfo,
  type SessionNetwork,
  type SessionRole,
  type SkillSelection
} from '../../shared/types'
import { SESSION_FORK_RESULT, SESSION_NEW_RESULT } from '../acp'
import type { Bus } from '../bus'
import type { LaunchContext } from '../containers'
import { createLogger } from '../log'
import type { PiiMask } from '../pii'
import { normalizeConfigOptions, normalizeModes } from './modes'
import { ACP_REQUEST_TIMEOUT_MS, assertNotManagerOwned, isDefaultSessionTitle } from './pure'
import type {
  Connection,
  CreateAction,
  DraftInheritance,
  NewLogRecord,
  PreparedDraft,
  Session,
  SessionEvents
} from './types'

const log = createLogger('sessions')

// Drafts and sessions derived from other sessions: creating one, editing it,
// copying, rewinding and branching it, and the drafts the agents themselves ask
// for (`create_session`, a review loop's reviewer, a proactive run).

/** What drafts.ts needs of the session manager: its state and the manager's own
 *  operations it calls back into. */
export interface DraftsCtx {
  append(s: Session, record: NewLogRecord): void
  applyAutoAllow(s: Session, conn: Connection): Promise<void>
  applyStartConfig(s: Session, conn: Connection): Promise<void>
  assertSessionWritable(id: string): void
  assertTaskWritable(ws: string, task: string): void
  attach(s: Session): Promise<Connection>
  attachMcp(s: Session, ctx: LaunchContext): Promise<AcpHttpMcpServer[]>
  readonly bus: Bus
  cacheAgentConfig(s: Session): void
  createPreparedDraft(ws: string, task: string, prepared: PreparedDraft, inherit: DraftInheritance): SessionInfo
  createSession(ref: EnvRef, repos: string[], agentId: string, startPrompt: string, action: CreateAction, mcp?: McpSelection[], autoAllow?: boolean, configValues?: Record<string, string | boolean>, role?: SessionRole, skills?: SkillSelection[]  , network?: SessionNetwork, repoModes?: Partial<Record<string, unknown>>): SessionInfo
  defaultTitleForRole(ref: EnvRef, role: SessionRole, excludeId?: string): string
  deleteSession(sessionId: string): void
  draftFrom(source: SessionInfo): SessionInfo
  emitState(s: Session, reason?: SessionStateReason, err?: unknown): void
  enqueue(sessionId: string): void
  readonly events: SessionEvents
  inheritanceOf(info: SessionInfo): DraftInheritance
  isActive(s: Session): boolean
  readonly mask: PiiMask
  maskEnabled(): boolean
  persistNow(s: Session): Promise<void>
  prepareDraft(ws: string, req: AgentSessionRequest, inherit: DraftInheritance): Promise<PreparedDraft>
  push(s: Session, entry: ChatEntryBase): ChatEntry
  renameSession(sessionId: string, title: string): void
  repoHolder(s: Session): { info: Pick<SessionInfo, 'id' | 'title'> } | undefined
  resolveDraftEnv(ws: string, req: AgentSessionRequest): Promise<string>
  schedulePersist(ref: EnvRef): void
  sessions: Map<string, Session>
  startMeta(agent: AgentManifest, configValues: Record<string, string | boolean> | undefined): Record<string, unknown> | undefined
  startNowOrQueue(sessionId: string): void
}

// --- lifecycle: create / run / enqueue / cancel / edit / delete ---------
export function createSession(mgr: DraftsCtx, ref: EnvRef,
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
  mgr.assertTaskWritable(ref.workspace, ref.task)
  const clean = sanitizeSessionNetwork(network)
  const modes = normalizeRepoModes(repos, repoModes)
  // Gate 1 of four (docs/requirements-repo-mounts.md §4): a session cannot
  // run or enqueue without the repo its role needs — a `write` one for an
  // executor (the UI disables those, but the IPC boundary enforces it too).
  // A draft is allowed whatever it holds.
  const missing = missingRepoReason({ role, repos, repoModes: modes })
  if ((action === 'run' || action === 'queue') && missing) throw new Error(missing)
  // Named after the role, not a flat "session N" — the role is the one thing
  // every session now declares. First of its role in the task carries no
  // index; each further one counts up from there.
  const title = mgr.defaultTitleForRole(ref, role)
  const info: SessionInfo = {
    id: randomUUID(),
    lastActivityAt: new Date().toISOString(),
    env: ref.env,
    role,
    repos,
    repoModes: modes,
    task: ref.task,
    workspace: ref.workspace,
    title,
    agent: agentId,
    autoAllow,
    state: 'draft',
    mcp,
    ...(skills ? { skills } : {}),
    // Sanitized here rather than at each caller: this value decides how a
    // container is wired, and it arrives from a renderer form, from an
    // agent's `create_session` (through the spawner's record) and from a
    // duplicate. The sanitizer is also the deep copy, so no two sessions
    // share a policy's domain array.
    //
    // Absent means the defaults (an open bridge, everything logged) — the
    // record only carries the setting once someone has chosen one, so a
    // session created before this existed and one created with the default
    // read the same way everywhere downstream.
    ...(clean ? { network: clean } : {}),
    startPrompt,
    ...(Object.keys(configValues).length ? { configValues } : {})
  }
  mgr.sessions.set(info.id, {
    info,
    ref,
    records: [],
    lastSeq: 0,
    flushedSeq: 0,
    flushInFlight: false,
    entries: [],
    nextEntryId: 1,
    busy: false,
    pending: [],
    draining: false,
    turnComplete: false,
    turns: 0,
    attached: false,
    loading: false,
    pendingPermissions: new Map(),
    turnRejected: false,
    limitStrikes: 0
  })
  mgr.bus.emit('tree.changed', undefined)
  mgr.emitState(mgr.sessions.get(info.id)!, 'created')
  mgr.schedulePersist(ref)
  if (action === 'queue') mgr.enqueue(info.id)
  else if (action === 'run') mgr.startNowOrQueue(info.id)
  return info
}

/**
 * Edit a draft's settings before it starts. A draft has no env or connection
 * yet, so re-pointing its repo/agent/role is safe — the (env, agent) adapter
 * is resolved only at start, and so are the repos' mounts and locks. Only
 * supplied keys change; unknown ids and non-draft sessions are ignored (which
 * is what makes the role immutable for everything that has run).
 */
export function editDraft(mgr: DraftsCtx, sessionId: string, patch: SessionDraftPatch): void {
  mgr.assertSessionWritable(sessionId)
  const s = mgr.sessions.get(sessionId)
  if (!s || s.info.state !== 'draft') return
  if (patch.agent !== undefined) {
    // The agent pick is structural, full stop: the mount list depends on the
    // kind even with no skill selected, now that every kind carries its own
    // (possibly empty) `historyPaths` (`AgentManifest`, containers.ts) — switching
    // to or from a kind with a non-empty one changes what gets mounted. A
    // failed start can have left a container provisioned against the old
    // kind's mount list, so any agent change releases it
    // (docs/requirements-agent-history.md §4.2). A draft's history directory
    // is empty and unstarted, so nothing live is ever orphaned by this — a
    // started session cannot reach here, since it cannot change agent.
    if (patch.agent !== s.info.agent) void mgr.events.releaseContainer(s.info.id, 'user')
    s.info.agent = patch.agent
  }
  if (patch.autoAllow !== undefined) {
    s.info.autoAllow = patch.autoAllow
    // Setting the coarse chip again *is* the user re-choosing, so an earlier
    // fine-grained pick stops outranking it — a draft that has one (a start
    // that failed after its first mode change) would otherwise ignore the
    // chip it was just given and come back up in the old mode.
    s.info.modeId = undefined
  }
  if (patch.mcp !== undefined) s.info.mcp = patch.mcp
  // Takes effect at the next start: the network flag decides how the session's
  // own network is created, and a live one cannot be edited in place (§7.2).
  // Sanitized like the create path — same value, same untrusted sources.
  if (patch.network !== undefined)
    s.info.network = sanitizeSessionNetwork(patch.network) ?? { internal: false }
  if (patch.startPrompt !== undefined) s.info.startPrompt = patch.startPrompt
  if (patch.configValues !== undefined)
    s.info.configValues = Object.keys(patch.configValues).length ? patch.configValues : undefined
  // absent leaves repos unchanged; never touches the env. Re-pointing repos,
  // their modes, env or role releases the draft's container if a failed
  // start left one — it was provisioned for the old target (a mode decides
  // whether its bind is read-only, so it is as structural as the repo set
  // itself, docs/requirements-repo-mounts.md §2). A repo the patch keeps
  // keeps its mode unless the patch names a new one; a new repo without one
  // takes the default.
  if (patch.repos !== undefined || patch.repoModes !== undefined) {
    const repos = patch.repos ?? s.info.repos
    const modes = normalizeRepoModes(repos, {
      ...Object.fromEntries(s.info.repos.map((r) => [r, repoMode(s.info, r)])),
      ...patch.repoModes
    })
    const changed =
      repos.length !== s.info.repos.length ||
      repos.some((r, i) => r !== s.info.repos[i] || modes[r] !== repoMode(s.info, r))
    if (changed) void mgr.events.releaseContainer(s.info.id, 'user')
    s.info.repos = repos
    s.info.repoModes = modes
  }
  if (patch.role !== undefined) {
    // The role governs the tool set alone — never the repos, their modes or
    // the env (§4) — but the proactive role reads every repo as `read`, so
    // a change can still re-mount: release whatever a failed start left.
    const prevRole = sessionRole(s.info)
    if (patch.role !== prevRole) void mgr.events.releaseContainer(s.info.id, 'user')
    // The title still reads as the auto-generated default (e.g. "executor",
    // untouched by the user) — carry it along to the new role instead of
    // leaving it stuck reading like the old one.
    if (isDefaultSessionTitle(s.info.title, prevRole))
      s.info.title = mgr.defaultTitleForRole(s.ref, patch.role, s.info.id)
    s.info.role = patch.role
  }
  // Structural like repos/env/role, not a runtime knob: the skills bind is
  // part of the container's mount list, decided when it is created. A failed
  // start can have left one provisioned against the previous selection, so a
  // change here has to release it (docs/requirements-skills.md §5.2).
  if (patch.skills !== undefined) {
    const before = (s.info.skills ?? []).map((k) => k.name).join('\u0000')
    const after = patch.skills.map((k) => k.name).join('\u0000')
    if (before !== after) void mgr.events.releaseContainer(s.info.id, 'user')
    // `[]` is written as `[]`, not cleared: it is the user saying "none", and
    // clearing it back to absent would have the draft re-seed the workspace's
    // defaults over the choice they just made.
    s.info.skills = patch.skills
  }
  if (patch.env !== undefined && patch.env !== s.info.env) {
    void mgr.events.releaseContainer(s.info.id, 'user')
    s.info.env = patch.env
    s.ref = { ...s.ref, env: patch.env }
  }
  mgr.bus.emit('tree.changed', undefined)
  mgr.bus.emit('session.changed', { sessionId })
  mgr.schedulePersist(s.ref)
}

/**
 * Copy a session into a fresh **draft** of the same task. Everything the user
 * configured comes along — role, env, repos, agent, MCP/git/auto-allow, the
 * config picks and the first prompt — and nothing runtime-derived does: a
 * draft has no container, no chat, no ACP session and no queue slot, whatever
 * state the source is in. That is what makes this the fix for a session
 * configured wrong: correct the copy, then delete the original (or leave it,
 * they share nothing but the clone every session of the task shares anyway).
 */
export function duplicateSession(mgr: DraftsCtx, sessionId: string): SessionInfo {
  const source = mgr.sessions.get(sessionId)?.info
  if (!source) throw new Error('unknown session')
  assertNotManagerOwned(source)
  const info = mgr.draftFrom(source)
  // The copy is recognisable as one instead of taking the next free
  // role-index name — the source is usually still in the tree right above it.
  mgr.renameSession(info.id, `${source.title} (copy)`)
  log.info('session.duplicated', { s: info.id, from: sessionId })
  return info
}

/**
 * Turn a session that has left draft back into one — "I launched it, then
 * saw it was set up wrong". The run is discarded whole (container, adapter,
 * host servers, queued prompts, chat log, mount scratch, agent history): this
 * is {@link duplicateSession} followed by {@link deleteSession}, with the
 * draft keeping the original's title and its place in the task.
 *
 * A new id rather than a reset of the old record, on purpose: everything the
 * run owned is keyed by the session id, and much of it is torn down
 * asynchronously — the container release (and the scratch/history directory
 * removed only once it is down), an in-flight log append, a start still
 * awaiting its container. Reusing the id would let any of those land on the
 * fresh draft (old chat records appended to its new log, its first start
 * mounting a scratch dir about to be deleted). A new id makes the result
 * exactly a freshly created draft with that configuration, and lets the
 * delete path — the one already trusted with a session in any state,
 * busy or starting included — do all of the teardown.
 *
 * Refused for a draft: there is no run to discard, and the "fresh" draft
 * would only lose the draft's in-memory start images.
 */
export function recreateSession(mgr: DraftsCtx, sessionId: string): SessionInfo {
  mgr.assertSessionWritable(sessionId)
  const s = mgr.sessions.get(sessionId)
  if (!s) throw new Error('unknown session')
  if (s.info.state === 'draft') throw new Error('session is already a draft')
  assertNotManagerOwned(s.info)
  const source = s.info
  const at = [...mgr.sessions.keys()].indexOf(sessionId)
  const info = mgr.draftFrom(source)
  mgr.renameSession(info.id, source.title)
  mgr.deleteSession(sessionId)
  // Back into the original's slot (the tree lists a task's sessions in this
  // map's order), so the row does not jump to the bottom of its task. Before
  // the debounced persist fires, so sessions.json keeps that order too.
  const fresh = mgr.sessions.get(info.id)
  if (fresh) {
    const rest = [...mgr.sessions].filter(([id]) => id !== info.id)
    rest.splice(at, 0, [info.id, fresh])
    mgr.sessions = new Map(rest)
    mgr.bus.emit('tree.changed', undefined)
  }
  log.info('session.recreated', { s: info.id, from: sessionId })
  return info
}

/**
 * Rewind a started session to just before one of the user's messages: that
 * message and everything after it leave the timeline (a `truncate` record —
 * the log itself stays append-only), and the message's text is handed back so
 * the composer can offer it for editing.
 *
 * The agent has to forget too, or the chat would show a conversation the
 * agent is not having. An adapter that can `session/fork` does it natively:
 * it forks its own session at the last agent message that is kept, and this
 * session carries on in the fork. Anything else — an adapter without fork, or
 * a fork point it does not know — gets a fresh `session/new` and the kept
 * conversation as text ahead of the next prompt (`preface`).
 *
 * Writable clones are restored from pre-prompt snapshots when available.
 */
export async function rewindSession(mgr: DraftsCtx, sessionId: string, entryId: number): Promise<{ text: string }> {
  mgr.assertSessionWritable(sessionId)
  const s = mgr.sessions.get(sessionId)
  if (!s) throw new Error('unknown session')
  if (s.info.state !== 'started') throw new Error('only a started session can be rewound')
  if (s.busy || s.promptRunning || s.draining || s.pending.length || s.pendingPermissions.size)
    throw new Error('stop the current turn and clear the queued messages first')
  if (writeRepos(s.info).length && (!mgr.isActive(s) || mgr.repoHolder(s)))
    throw new Error('Rewind requires this session to hold its writable clones; resume it after the current holder releases them')
  const target = s.entries.find((e) => e.id === entryId)
  if (!target || target.kind !== 'user') throw new Error('a session can only be rewound to a message of yours')
  const kept = s.entries.filter((e) => e.id < entryId)
  const lastAgent = [...kept].reverse().find((e) => e.kind === 'agent')
  const hasSpeech = kept.some((e) => e.kind === 'user' || e.kind === 'agent')

  mgr.bus.emit('session.activity', { sessionId })
  s.draining = true // nothing may start a turn while the agent side is swapped
  try {
    const conn = await mgr.attach(s)
    const ctx = await mgr.events.resolveLaunch(s.info.id)
    const mcpServers = await mgr.attachMcp(s, ctx)
    const meta = mgr.startMeta(ctx.agent, s.info.configValues)
    const open = { timeoutMs: ACP_REQUEST_TIMEOUT_MS }
    let result: { sessionId: string; modes?: unknown; configOptions?: unknown } | undefined
    let preface: string | undefined
    const messageId = lastAgent?.kind === 'agent' ? lastAgent.acpMessageId : undefined
    if (conn.canFork && messageId && s.acpSessionId) {
      try {
        result = await conn.peer.request(
          'session/fork',
          {
            sessionId: s.acpSessionId,
            cwd: ctx.remoteWorkspaceFolder,
            mcpServers,
            _meta: { ...(meta ?? {}), jetbrains: { air: { fork: { version: 1, messageId } } } }
          },
          SESSION_FORK_RESULT,
          open
        )
      } catch (e) {
        log.warn('session.rewind.fork-failed', { s: sessionId, err: e })
      }
    }
    if (!result) {
      result = await conn.peer.request(
        'session/new',
        { cwd: ctx.remoteWorkspaceFolder, mcpServers, ...(meta ? { _meta: meta } : {}) },
        SESSION_NEW_RESULT,
        open
      )
      if (hasSpeech) preface = rewindPreface(kept)
    }
    s.acpSessionId = result.sessionId
    s.preface = preface
    s.modes = normalizeModes(result.modes) ?? s.modes
    s.configOptions = normalizeConfigOptions(result.configOptions, ctx.agent.id) ?? s.configOptions
    s.attached = true
    await mgr.applyStartConfig(s, conn)
    await mgr.applyAutoAllow(s, conn)
    const { restored: filesRestored, notice: fileNotice } = mgr.events.restoreCheckpoint
      ? await mgr.events.restoreCheckpoint(s.info, entryId)
      : {
          restored: false,
          notice: writeRepos(s.info).length
            ? 'Files in the working tree were NOT reverted completely; inspect each clone. No checkpoints are available.'
            : 'No writable repositories.'
        }
    if (preface) s.preface = rewindPreface(kept, filesRestored)
    mgr.append(s, { type: 'truncate', afterId: entryId - 1 })
    mgr.push(s, { kind: 'system', text: fileNotice })
  } finally {
    s.draining = false
  }

  s.plan = undefined
  s.proposal = undefined
  s.info.incomplete = undefined
  mgr.cacheAgentConfig(s)
  mgr.bus.emit('session.changed', { sessionId })
  mgr.schedulePersist(s.ref)
  log.info('session.rewound', { s: sessionId, to: entryId, native: !s.preface })
  return { text: mgr.maskEnabled() ? mgr.mask.decode(sessionId, target.text) : target.text }
}

/**
 * Branch a session at one of the user's messages: a new **draft** of the same
 * task whose first prompt carries the conversation up to that message (the
 * message itself is the tail, ready to edit). The original is untouched.
 *
 * A transcript rather than a native fork on purpose: an adapter's own history
 * lives in a per-session directory no other session may read
 * (docs/requirements-agent-history.md §2), so a fork cannot cross sessions.
 */
export function branchSession(mgr: DraftsCtx, sessionId: string, entryId: number): SessionInfo {
  const source = mgr.sessions.get(sessionId)
  if (!source) throw new Error('unknown session')
  // A watcher is its scope's one session (docs/requirements-watchers.md §4).
  assertNotManagerOwned(source.info)
  const target = source.entries.find((e) => e.id === entryId)
  if (!target || target.kind !== 'user') throw new Error('a session can only be branched at a message of yours')
  const info = mgr.draftFrom(source.info)
  mgr.renameSession(info.id, `${source.info.title} (branch)`)
  const draft = mgr.sessions.get(info.id)!
  const text = mgr.maskEnabled() ? mgr.mask.decode(sessionId, target.text) : target.text
  const history = source.entries
    .filter((e) => e.id < entryId)
    .map((e) => (mgr.maskEnabled() && 'text' in e ? { ...e, text: mgr.mask.decode(sessionId, e.text) } : e))
  draft.info.startPrompt = branchPrompt(history) + text
  mgr.bus.emit('session.changed', { sessionId: info.id })
  mgr.schedulePersist(draft.ref)
  log.info('session.branched', { s: info.id, from: sessionId, at: entryId })
  return draft.info
}

/** A fresh draft of the same task carrying everything the user configured on
 *  `source`, and nothing runtime-derived (see {@link duplicateSession}). */
export function draftFrom(mgr: DraftsCtx, source: SessionInfo): SessionInfo {
  const copy = mgr.createSession(
    { workspace: source.workspace, task: source.task, env: source.env },
    [...source.repos],
    source.agent ?? '',
    source.startPrompt,
    'draft',
    source.mcp ? [...source.mcp] : [],
    source.autoAllow ?? true,
    { ...(source.configValues ?? {}) },
    sessionRole(source),
    // Copied element by element, and `undefined` kept as `undefined`: the
    // records are the copy's own, and a source that deliberately chose no
    // skills must not have the workspace's defaults seeded back into its copy.
    source.skills?.map((k) => ({ ...k })),
    // Through the sanitizer, which is also the deep copy: the two sessions
    // must not share a policy's domain array.
    sanitizeSessionNetwork(source.network),
    Object.fromEntries(source.repos.map((r) => [r, repoMode(source, r)]))
  )
  return copy
}

/** Mark a draft as a proactive agent's template (docs/design-proactive-
 *  agents.md §2): it never runs itself. */
export function markTemplate(mgr: DraftsCtx, sessionId: string): void {
  const s = mgr.sessions.get(sessionId)
  if (!s) throw new Error('unknown session')
  s.info.template = true
  mgr.bus.emit('session.changed', { sessionId })
  mgr.schedulePersist(s.ref)
}

/** Start one run of a proactive agent: a copy of its template, in the
 *  template's own scope, titled `title`, straight into the queue — enabling
 *  the agent was the approval for its runs (§1). */
export function spawnRun(mgr: DraftsCtx, templateId: string, title: string): SessionInfo {
  const t = mgr.sessions.get(templateId)
  if (!t?.info.template) throw new Error('the proactive agent has no template')
  const info = mgr.draftFrom(t.info)
  mgr.renameSession(info.id, title)
  mgr.enqueue(info.id)
  return info
}

/**
 * `create_session` (§3): one session's agent drafts another. The new session
 * lands in the spawner's own task, inherits everything the request leaves out
 * (the env excepted — see `resolveDraftEnv`), and stays a **draft** — the user
 * reviewing, editing or launching it *is* the approval step, which is why
 * there is no spawn-graph limit, depth control or flow management to enforce
 * here. Nothing flows back to the spawner beyond the id of the draft it just
 * created.
 */
export async function createAgentDraft(mgr: DraftsCtx, spawnerId: string,
  req: AgentSessionRequest): Promise<{ sessionId: string; title: string }> {
  const spawner = mgr.sessions.get(spawnerId)
  if (!spawner) throw new Error('unknown session')
  const from = sessionRole(spawner.info)
  const allowed = spawnableRoles(from)
  if (!allowed.includes(req.role))
    throw new Error(
      allowed.length
        ? `a ${from} session may only draft: ${allowed.join(', ')}`
        : `a ${from} session may not draft sessions`
    )
  const task = req.task?.trim() || spawner.ref.task
  // Belt and braces with the tool schema, which offers `task` only to the
  // roles allowed to use it.
  if (task !== spawner.ref.task && !roleDraftsCrossTask(from))
    throw new Error(`a ${from} session may only draft into its own task`)
  const inherit = mgr.inheritanceOf(spawner.info)
  const prepared = await mgr.prepareDraft(spawner.ref.workspace, req, inherit)
  // The task name is agent-input too: `ensureTask` validates it and creates
  // the `task.json` marker if missing — the session's first persist would
  // otherwise mkdir its way into a directory that is not a task (invisible
  // in the tree; see the same invariant at the IPC create boundary).
  if (task !== spawner.ref.task) await mgr.events.ensureTask(spawner.ref.workspace, task)
  const info = mgr.createPreparedDraft(spawner.ref.workspace, task, prepared, inherit)
  log.info('session.drafted', { s: info.id, by: spawnerId, role: req.role, task })
  // A draft is a to-do for the user, and the spawner's own feed is where they
  // are looking right now — the tree row alone is easy to miss. A cross-task
  // draft names its task, since the row is not even in this task's subtree.
  const where = task !== spawner.ref.task ? ` in task "${task}"` : ''
  mgr.push(spawner, { kind: 'system', text: `create_session: drafted ${req.role} "${info.title}"${where}` })
  return { sessionId: info.id, title: info.title }
}

/** What a draft requested by this session inherits (see {@link DraftInheritance}). */
export function inheritanceOf(info: SessionInfo): DraftInheritance {
  return {
    agent: info.agent,
    mcp: info.mcp,
    autoAllow: info.autoAllow,
    configValues: info.configValues,
    skills: info.skills,
    network: info.network
  }
}

/**
 * Check a draft request against the workspace and resolve its agent and env,
 * creating nothing — so a caller with several requests can refuse all of them
 * before the first one lands (a proactive agent's `propose_scope`).
 */
export async function prepareDraft(mgr: DraftsCtx, ws: string, req: AgentSessionRequest, inherit: DraftInheritance): Promise<PreparedDraft> {
  // Normalized before anything reads it: the env follows the anchor, and the
  // anchor follows the modes.
  req = { ...req, repoModes: normalizeRepoModes(req.repos, req.repoModes) }
  // Explicit request wins; absent that, the workspace's own default (if any)
  // beats inheriting the spawner's — a workspace that configured a default
  // has made a choice for everything drafted into it, not just for sessions
  // that name no agent of their own. Only with neither does the spawner's
  // agent stand, as before.
  const agent = req.agent ?? (await mgr.events.defaultAgentForWorkspace(ws)) ?? inherit.agent
  if (!agent) throw new Error('no agent to draft with — this session has none either')
  // Repo/env/agent names come from an agent, so they are untrusted the same
  // way the renderer's are; a draft naming a repo that does not exist, or an
  // agent the workspace denies, would only fail much later, at the user's
  // launch. Checked *before* the env is resolved, since resolving reads the
  // repo back out of the registry — an invented repo has to read as "not
  // registered", not as "has no default env".
  await mgr.events.checkDraftTarget(ws, req.repos, req.env, agent)
  const env = await mgr.resolveDraftEnv(ws, req)
  return { req, agent, env }
}

/** Create a draft {@link prepareDraft} has already checked. The task must
 *  exist. */
export function createPreparedDraft(mgr: DraftsCtx, ws: string, task: string, prepared: PreparedDraft, inherit: DraftInheritance): SessionInfo {
  const { req, agent, env } = prepared
  const info = mgr.createSession(
    { workspace: ws, task, env },
    req.repos,
    agent,
    req.prompt,
    'draft',
    inherit.mcp ? [...inherit.mcp] : [],
    req.autoAllow ?? inherit.autoAllow ?? true,
    req.configValues ?? inherit.configValues ?? {},
    req.role,
    // Inherited when the request says nothing, replaced outright when it does
    // — including with `[]`, which is how an agent asks for none
    // (docs/requirements-skills.md §6). The names were validated at the tool
    // boundary; one that does not resolve stays in the draft as an error row,
    // which is where a user can act on it.
    req.skills ? sanitizeSkillSelection(req.skills) : inherit.skills?.map((k) => ({ ...k })),
    // Inherited, never chosen: a session running internal cannot draft one
    // with open egress (§6.2), and `AgentSessionRequest` has no field to ask
    // with — a rule the agent cannot express is one it cannot argue about.
    sanitizeSessionNetwork(inherit.network),
    req.repoModes
  )
  // `renameSession` mutates the same info object createSession stored.
  if (req.title?.trim()) mgr.renameSession(info.id, req.title)
  return info
}

/**
 * Which environment a `create_session` draft runs in. The answer follows the
 * **repo being drafted for**, never the spawner: a researcher parked in some
 * ad-hoc container drafts sessions for repos all day, and inheriting its own
 * env handed every one of them the wrong container silently — nothing in the
 * request said "env", so nothing in the result looked wrong either.
 *
 * So: the env is the one claiming this repo as its default (`EnvConfig.repo`,
 * read backwards). Naming a different one is allowed but never implicit —
 * `confirmNonDefaultEnv` has to say so, which is what makes the wrong
 * container a decision rather than an oversight. The interactive New Session
 * flow (`createSession`) keeps its own defaulting: a human picking an env in
 * the modal sees what they picked.
 *
 * Two shapes have no default to speak of, and both end at the same place —
 * the caller names the env:
 *  - **no env claims the repo**: there is nothing to default to, so `env` is
 *    required. Once given it stands on its own; there is no default for it to
 *    contradict, so no confirmation to ask for.
 *  - **several envs claim it**: the registry is ambiguous, so an omitted
 *    `env` cannot be resolved for the caller. Any env *from that set* is then
 *    taken as-is — none of them is more "the" default than the others, and
 *    demanding a non-default confirmation for a genuine default would teach
 *    the agent to set the flag by reflex, which is the one habit this guard
 *    cannot survive. Anything outside the set still needs the flag.
 */
export async function resolveDraftEnv(mgr: DraftsCtx, ws: string, req: AgentSessionRequest): Promise<string> {
  // The repo the env follows is the draft's anchor — its first `write` repo,
  // else its first (docs/requirements-repo-mounts.md §2.2). A draft with no
  // repo has nothing to follow: it takes what it names, else the workspace's
  // default env, the way a fresh draft in the UI does.
  const repo = anchorRepo({ role: req.role, repos: req.repos, ...(req.repoModes ? { repoModes: req.repoModes } : {}) })
  if (!repo) return req.env ?? (await mgr.events.defaultEnvForWorkspace(ws))
  const defaults = await mgr.events.defaultEnvsForRepo(ws, repo)
  if (!req.env) {
    const [only, ...rest] = defaults
    if (only && !rest.length) return only
    throw new Error(
      defaults.length
        ? `repo "${repo}" is the default repo of several environments (${defaults.join(', ')}) — ` +
          'pass `env` naming the one this session should run in'
        : `repo "${repo}" is not the default repo of any environment, so there is nothing to ` +
          'default to — pass `env` naming the one this session should run in'
    )
  }
  if (defaults.includes(req.env) || !defaults.length || req.confirmNonDefaultEnv) return req.env
  const named = defaults.map((e) => `"${e}"`).join(', ')
  throw new Error(
    defaults.length > 1
      ? `env "${req.env}" is not among the default environments of repo "${repo}" (${named}) — ` +
        'name one of those, or pass `confirmNonDefaultEnv: true` if running it elsewhere is deliberate'
      : `env "${req.env}" is not the default environment of repo "${repo}" (that is ${named}) — ` +
        'omit `env` to draft into the repo\'s default, or pass `confirmNonDefaultEnv: true` if ' +
        'running it elsewhere is deliberate'
  )
}
