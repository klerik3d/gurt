import type { AgentManifest } from '../../shared/agentPlugin'
import type { Vocabulary } from '../../shared/agentVocabulary'
import type { SessionStateReason } from '../../shared/events'
import {
  anchorRepo,
  missingRepoReason,
  type AcpHttpMcpServer,
  type AgentSessionRequest,
  type ChangeProposal,
  type ChatEntry,
  type ChatEntryBase,
  type EnvRef,
  type McpSelection,
  type PromptContext,
  type PromptImage,
  type RepoMode,
  type ReviewVerdict,
  type SessionInfo,
  type SessionRole
} from '../../shared/types'
import { SESSION_NEW_RESULT, SET_CONFIG_OPTION_RESULT } from '../acp'
import { agentMain } from '../agentPlugins'
import type { Bus } from '../bus'
import type { LaunchContext } from '../containers'
import type { AdminHooks, ProactiveHooks, WatcherToolHooks } from '../mcp/gurtServer'
import { oauthStoredAccess } from '../oauth'
import { scopeKeeper } from '../oauth/keeper'
import type { PiiMask } from '../pii'
import { servePiiRewrite, stopPiiRewrite } from '../piiRewrite'
import { resolveProxyPlan, type ResolvedProxyPlan } from '../proxy/config'
import { timedPhase } from '../provision'
import { nextModeId, normalizeConfigOptions, normalizeModes } from './modes'
import { ACP_REQUEST_TIMEOUT_MS, assertNotTemplate } from './pure'
import type { Connection, Session, SessionEvents } from './types'

// Starting a session: the MCP servers and skills it gets, the config the agent is
// given once its ACP session exists, and the start sequence itself.

/** What start.ts needs of the session manager: its state and the manager's own
 *  operations it calls back into. */
export interface StartCtx {
  readonly agentKinds: Map<string, string>
  applyAutoAllow(s: Session, conn: Connection): Promise<void>
  applyStartConfig(s: Session, conn: Connection): Promise<void>
  assertSessionWritable(id: string): void
  attach(s: Session): Promise<Connection>
  attachMcp(s: Session, ctx: LaunchContext): Promise<AcpHttpMcpServer[]>
  readonly bus: Bus
  cacheAgentConfig(s: Session): void
  connection(s: Session, ctx: LaunchContext): Promise<Connection>
  readonly detachEpoch: Map<string, number>
  emitState(s: Session, reason?: SessionStateReason, err?: unknown): void
  readonly events: SessionEvents
  gurtHooks(s: Session): {
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
  }
  keepOAuthScopeFresh(s: Session, ctx: LaunchContext, selection: McpSelection[] | undefined, planOpts: Parameters<typeof resolveProxyPlan>[4], pushedPlan: ResolvedProxyPlan): void
  readonly mask: PiiMask
  maskEnabled(): boolean
  materializeSkills(s: Session): Promise<void>
  noteUnattachedMcp(s: Session, attached: AcpHttpMcpServer[]): void
  push(s: Session, entry: ChatEntryBase): ChatEntry
  pushConfigOption(s: Session, conn: Connection, configId: string, value: string | boolean): Promise<void>
  repoConflict(s: Session): { holder: { info: Pick<SessionInfo, 'id' | 'title'> }; repo: string } | undefined
  runPrompt(s: Session, text: string, context?: PromptContext[], images?: PromptImage[], loop?: string): Promise<void>
  schedule(): void
  schedulePersist(ref: EnvRef): void
  readonly sessions: Map<string, Session>
  startMeta(agent: AgentManifest, configValues: Record<string, string | boolean> | undefined): Record<string, unknown> | undefined
  vocabulary(s: Session): Vocabulary
}

/**
 * Say so when a selected MCP server did not make it into the descriptors the
 * agent is about to receive — the scope the session got is not the scope the
 * user picked, and the difference is otherwise invisible from the outside.
 *
 * Both sources are routed now (built-ins through gurt's host listeners,
 * registry entries straight from the proxy), so landing here means the id did
 * not resolve at all: the workspace no longer offers it, or its credential
 * refused to resolve — an unresolvable credential blocks, it never falls back
 * to an unauthenticated call. `attachMcp` logs the reason immediately above.
 *
 * Rides the session's provisioning log, where the rest of "what happened on
 * the way up" is written.
 */
export function noteUnattachedMcp(mgr: StartCtx, s: Session, attached: AcpHttpMcpServer[]): void {
  for (const sel of s.info.mcp ?? []) {
    if (attached.some((m) => m.name === sel.id)) continue
    mgr.bus.emit('provision.log', {
      key: s.info.id,
      line: `[mcp] "${sel.id}" is selected but is not in this session's scope — the agent will not see it`
    })
  }
}

/**
 * Everything the agent needs to reach an MCP server, in the order it has to
 * happen (docs/requirements-mcp-proxy.md §4.3, §5.3):
 *
 *   1. gurt's own host listeners come up (`github`, `gurt`), each on its own
 *      port with its own token — the `host` upstreams of the scope below;
 *   2. the scope is built from the session's selection resolved against the
 *      workspace registry and the credential store, and *pushed to the proxy*;
 *   3. the descriptors the agent receives are returned — every one of them a
 *      `http://gurt-proxy:8100/mcp/<token>/<id>` URL.
 *
 * So the session container holds a URL and an opaque token, and never an MCP
 * credential, never a host token, and never an upstream address (§2). It runs
 * before the adapter is spawned, on both the start and the resume path, which
 * is also what makes a scope edit mid-session take effect on the next attach.
 */
export async function attachMcp(mgr: StartCtx, s: Session, ctx: LaunchContext): Promise<AcpHttpMcpServer[]> {
  // `detach` may run while this is awaiting (a token refresh inside the plan,
  // a host listener coming up): a watch armed after it would outlive the
  // teardown it was supposed to be undone by.
  const epoch = mgr.detachEpoch.get(s.info.id) ?? 0
  const hosted = [
    ...(await mgr.events.resolveMcpServers(s.ref, s.info.id, anchorRepo(s.info), s.info.mcp)),
    await mgr.events.resolveGurtServer(s.ref, s.info.id, mgr.gurtHooks(s))
  ]
  // A masking session's MCP traffic is rewritten at the proxy (§9.2) through
  // the host's endpoint; any other session's is forwarded as it always was.
  let piiUrl: string | undefined
  if (mgr.maskEnabled()) piiUrl = await servePiiRewrite(s.info.id, mgr.mask)
  else stopPiiRewrite(s.info.id)
  // Captured once: the live-scope refresh below rebuilds exactly this scope,
  // with only the tokens renewed — it is not a second way to apply an edit.
  const selection = s.info.mcp
  const planOpts = {
    piiUrl,
    // One URL per built-in, because gurt still runs one listener per (session,
    // mcp id); §10.4 collapses these into a single `hostMcpUrl`.
    hostMcpUrls: Object.fromEntries(hosted.map((m) => [m.name, m.url])),
    network: s.info.network,
    proxyBase: ctx.proxy.base
  }
  const plan = await resolveProxyPlan(s.ref, s.info.id, ctx.proxy.token, selection, planOpts)
  for (const line of plan.errors)
    mgr.bus.emit('provision.log', { key: s.info.id, line: `[mcp] ${line}` })
  await mgr.events.pushProxyScope(s.info.id, plan.config)
  if ((mgr.detachEpoch.get(s.info.id) ?? 0) === epoch && mgr.sessions.get(s.info.id) === s)
    mgr.keepOAuthScopeFresh(s, ctx, selection, planOpts, plan)
  const attached = [...plan.mcpServers, ...plan.recoverable]
  mgr.noteUnattachedMcp(s, attached)
  return attached
}

/**
 * An MCP access token rides in the scope the proxy reads and has a short
 * life, so a session that outlives it would start answering 401
 * (docs/requirements-oauth-credentials.md §5.2). The keeper refreshes the
 * linked `oauth` entries ahead of expiry and calls back here to rewrite the
 * scope — the proxy watches the file, and the agent's URL and token do not
 * change. No-op for a session whose servers link no `oauth` entry.
 *
 * A rebuild that lost a route to a failed refresh pushes nothing: the old
 * scope still holds a token for a few more minutes, which beats removing the
 * server from a running session.
 */
export function keepOAuthScopeFresh(mgr: StartCtx, s: Session,
  ctx: LaunchContext,
  selection: McpSelection[] | undefined,
  planOpts: Parameters<typeof resolveProxyPlan>[4],
  pushedPlan: ResolvedProxyPlan): void {
  const oauthIds = pushedPlan.oauthCredentialIds
  // The scope the proxy holds. A rebuild keeps the routes whose credential
  // failed *this time* exactly as they are here: dropping a server from a
  // running session over a transient failure of another entry's refresh is
  // worse than leaving its old token to run out.
  let last = pushedPlan.config
  // One rebuild at a time per session: two entries' timers can fire together,
  // and each rebuild composes from the store as it is when its turn comes, so
  // the last push is always the newest — never an older plan landing late.
  let queue: Promise<unknown> = Promise.resolve()
  const serially = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.catch(() => {}).then(fn)
    queue = run
    return run
  }
  scopeKeeper.watch(
    s.info.id,
    oauthIds,
    {
      rebuild: (isCurrent, credentialId, token) =>
        serially(async () => {
          if (!isCurrent()) return
          // No second refresh: the renewed entry's token is the one the keeper
          // just resolved, and the others are used as stored while still
          // valid — a refresh here would persist, and short-lived tokens would
          // chase their own writes.
          const reuse: Record<string, string> = {}
          for (const id of oauthIds) {
            const stored = id === credentialId ? token : await oauthStoredAccess(id)
            if (stored) reuse[id] = stored
          }
          const plan = await resolveProxyPlan(
            s.ref,
            s.info.id,
            ctx.proxy.token,
            selection,
            planOpts,
            reuse
          )
          // Only the entry being renewed can fail this renewal.
          const failed = plan.oauthErrors[credentialId]
          if (failed) throw new Error(failed)
          // A route whose own credential failed *this time* keeps its previous
          // upstream. Only those: a route that is simply gone (the entry was
          // deleted or edited out of the registry meanwhile) stays gone.
          for (const [route, upstream] of Object.entries(last.mcp)) {
            if (upstream.kind !== 'registry' || route in plan.config.mcp) continue
            const atRisk = plan.oauthRoutes[route]?.some((cid) => plan.oauthErrors[cid])
            if (atRisk) plan.config.mcp[route] = upstream
          }
          if (!isCurrent()) return
          await mgr.events.pushProxyScope(s.info.id, plan.config)
          last = plan.config
        }),
      onProblem: (message) =>
        mgr.bus.emit('provision.log', {
          key: s.info.id,
          line: `[mcp] could not renew an MCP sign-in for this running session — ${message}`
        })
    },
    pushedPlan.oauthTokens
  )
}

/**
 * Stage this session's skills on the host, and say on its provision log which
 * selected names resolved to nothing.
 *
 * Reported rather than thrown, the way `resolveProxyPlan`'s errors are: a
 * skill deleted behind a draft is the user's to notice and fix, and refusing
 * to start over it would strand the session on a problem the picker already
 * shows as an error row (docs/requirements-skills.md §4.4).
 */
export async function materializeSkills(mgr: StartCtx, s: Session): Promise<void> {
  if (!s.info.skills?.length) return
  const { missing } = await mgr.events.materializeSkills(
    s.ref.workspace,
    s.ref.task,
    s.info.id,
    s.info.skills
  )
  for (const name of missing)
    mgr.bus.emit('provision.log', {
      key: s.info.id,
      line: `[skills] "${name}" is not in this workspace's registry — not mounted`
    })
}

/** Provision (if needed), open the ACP session, and send the start prompt. */
export async function startSession(mgr: StartCtx, sessionId: string, by: 'user' | 'scheduler'): Promise<void> {
  const s = mgr.sessions.get(sessionId)
  if (!s || s.info.state === 'starting' || s.info.state === 'started') return
  // A watcher stopped while it waited in the queue never starts (§3).
  if (s.info.role === 'watcher' && s.info.watcher?.end) {
    s.info.state = 'draft'
    s.info.queuedAt = undefined
    mgr.bus.emit('tree.changed', undefined)
    mgr.emitState(s, by)
    return
  }
  mgr.bus.emit('session.activity', { sessionId: s.info.id })
  s.info.state = 'starting'
  s.info.queuedAt = undefined
  s.startError = undefined
  s.startedAt = Date.now()
  s.startTiming = { since: s.startedAt, promptSent: false }
  s.turns = 0
  mgr.bus.emit('tree.changed', undefined)
  mgr.emitState(s, by)
  mgr.bus.emit('session.changed', { sessionId })
  try {
    // Gate 4: every start path funnels here, so the gate is checked once,
    // here — the scheduler pre-checks it to pick queue items, "Run now"
    // doesn't need to. Only the roles that need a repo are refused one-less.
    const missing = missingRepoReason(s.info)
    if (missing) throw new Error(missing)
    assertNotTemplate(s.info)
    const conflict = mgr.repoConflict(s)
    if (conflict)
      throw new Error(
        `repository "${conflict.repo}" is in use by session "${conflict.holder.info.title}" — queue this one instead`
      )
    // Before the container is resolved: `resolveLaunch` provisions it, and
    // the read-only bind it adds points at the directory this call fills
    // (docs/requirements-skills.md §5). Re-run on every start, so a skill
    // edited in Settings between two starts of the same draft is delivered as
    // it is now.
    await mgr.materializeSkills(s)
    const ctx = await mgr.events.resolveLaunch(s.info.id)
    s.remoteCwd = ctx.remoteWorkspaceFolder
    // Before the adapter, not after: the agent must never observe a proxy
    // that has no scope, and its environment names that proxy from its first
    // instruction.
    const mcpServers = await mgr.attachMcp(s, ctx)
    const conn = await mgr.connection(s, ctx)
    // Picks the adapter reads from `_meta` (model/effort, for one that does)
    // ride it so the very first turn already runs on them; any other picks
    // (e.g. fast mode) are reconciled below, before the prompt.
    const meta = mgr.startMeta(ctx.agent, s.info.configValues)
    const result = await timedPhase(s.info.id, 'acp-session-new', () =>
      conn.peer.request(
        'session/new',
        {
          cwd: ctx.remoteWorkspaceFolder,
          mcpServers,
          ...(meta ? { _meta: meta } : {})
        },
        SESSION_NEW_RESULT,
        { timeoutMs: ACP_REQUEST_TIMEOUT_MS }
      )
    )
    s.acpSessionId = result.sessionId
    s.modes = normalizeModes(result.modes) ?? s.modes
    s.configOptions = normalizeConfigOptions(result.configOptions, ctx.agent.id)
    s.attached = true
    s.info.state = 'started'
    await mgr.applyStartConfig(s, conn)
    mgr.cacheAgentConfig(s)
    await mgr.applyAutoAllow(s, conn)
    mgr.bus.emit('tree.changed', undefined)
    mgr.emitState(s, by)
    mgr.schedulePersist(s.ref)
    const startImages = s.startImages
    s.startImages = undefined
    if (s.info.role === 'watcher') {
      // Stopped while it was starting: the start prompt is never sent (§3).
      if (s.info.watcher?.end) return
      s.ranOrigin = 'user'
      s.guardStart = true
    }
    await mgr.runPrompt(s, s.info.startPrompt, undefined, startImages)
  } catch (e) {
    // Deleted while the start was in flight (the user saw the misconfigured
    // session go up and pulled it). The delete already took down everything
    // that existed by then, and the container manager removes one that came
    // up after it — so there is no state left to fail into, and nothing to
    // announce about a session the tree no longer has.
    if (mgr.sessions.get(sessionId) !== s) return
    const message = e instanceof Error ? e.message : String(e)
    s.info.state = 'draft'
    s.info.queuedAt = undefined
    s.startError = message
    mgr.push(s, { kind: 'system', text: `start failed: ${message}` })
    mgr.bus.emit('tree.changed', undefined)
    mgr.emitState(s, 'start-failed', e)
    mgr.schedulePersist(s.ref)
    // A failed start must not block the queue — let the next item try.
    mgr.schedule()
  } finally {
    s.startTiming = undefined
  }
}

/** Build the `_meta` passed to `session/new` and `session/load` from a
 *  draft's chosen config — the kind's plugin says what its adapter reads
 *  (`sessionMeta`). Returns undefined when there is nothing to forward. */
export function startMeta(agent: AgentManifest,
  configValues: Record<string, string | boolean> | undefined): Record<string, unknown> | undefined {
  if (!configValues) return undefined
  return agentMain(agent.id)?.sessionMeta?.(configValues)
}

/** Reconcile a freshly-opened session against the draft's chosen config values:
 *  for every pick whose live current value differs, push it via
 *  `session/set_config_option`. Runs before the first prompt so the turn uses
 *  the intended settings even for options `_meta` can't carry (e.g. fast mode).
 *  Best-effort — a rejected option is logged, not fatal. */
export async function applyStartConfig(mgr: StartCtx, s: Session, conn: Connection): Promise<void> {
  const values = s.info.configValues
  if (!values) return
  for (const [configId, value] of Object.entries(values)) {
    const opt = s.configOptions?.find((o) => o.id === configId)
    // Skip when the option isn't offered here or already holds the value.
    if (!opt || opt.currentValue === value) continue
    try {
      await mgr.pushConfigOption(s, conn, configId, value)
    } catch (e) {
      mgr.push(s, {
        kind: 'system',
        text: `could not set ${configId}: ${e instanceof Error ? e.message : String(e)}`
      })
    }
  }
}

/** Issue one `session/set_config_option` and adopt the echoed option set. The
 *  agent may rewrite sibling options (picking a model swaps its effort levels),
 *  so we replace `s.configOptions` wholesale from the response. */
export async function pushConfigOption(mgr: StartCtx, s: Session,
  conn: Connection,
  configId: string,
  value: string | boolean): Promise<void> {
  const params =
    typeof value === 'boolean'
      ? { sessionId: s.acpSessionId, configId, type: 'boolean', value }
      : { sessionId: s.acpSessionId, configId, value }
  const res = await conn.peer.request('session/set_config_option', params, SET_CONFIG_OPTION_RESULT, {
    timeoutMs: ACP_REQUEST_TIMEOUT_MS
  })
  const next = normalizeConfigOptions(res.configOptions, mgr.agentKinds.get(s.info.agent ?? ''))
  if (next) s.configOptions = next
}

/** Switch the freshly (re)opened ACP session into the mode it belongs in —
 *  the user's own last pick, or the one implied by the session-start
 *  auto/manual choice (see {@link nextModeId}). Best-effort: unknown mode
 *  sets are left alone. */
export async function applyAutoAllow(mgr: StartCtx, s: Session, conn: Connection): Promise<void> {
  if (!s.acpSessionId) return
  const target = nextModeId(s.info, s.modes, mgr.vocabulary(s).modes)
  if (!target) return
  try {
    await conn.peer.request('session/set_mode', { sessionId: s.acpSessionId, modeId: target })
    if (s.modes) s.modes.currentModeId = target
    // The mode chips read `modes.currentModeId`; a start/reattach that lands
    // in a different mode than the last snapshot showed has to say so, or the
    // popup keeps highlighting the mode the session left behind. (claude-code
    // also sends `current_mode_update` for this — an agent that does not is
    // exactly the case this covers.)
    mgr.cacheAgentConfig(s)
    mgr.bus.emit('session.changed', { sessionId: s.info.id })
  } catch (e) {
    mgr.push(s, {
      kind: 'system',
      text: `could not set mode: ${e instanceof Error ? e.message : String(e)}`
    })
  }
}

/** Change a live agent-reported config option (model, effort, fast-mode, …) via
 *  ACP `session/set_config_option`. Also records the choice on the draft-time
 *  `configValues` so it survives a detach and re-applies on the next start, and
 *  refreshes the agent cache with the new option set. */
export async function setConfigOption(mgr: StartCtx, sessionId: string, configId: string, value: string | boolean): Promise<void> {
  mgr.assertSessionWritable(sessionId)
  const s = mgr.sessions.get(sessionId)
  if (!s) throw new Error('unknown session')
  // A sleeping session is woken first — attach brings the container up and
  // session/loads, with the usual "resuming…" indicator and repo-clone gate —
  // so the change applies to the live agent and is validated by it right now,
  // exactly like a change on a running session.
  const conn = await mgr.attach(s)
  try {
    await mgr.pushConfigOption(s, conn, configId, value)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // The agent validates a pick against what its own picker currently
    // offers — and that list may only contain a model the CLI wasn't
    // launched pinned to (claude-code's does, see `startMeta`) once this
    // session's adapter has been restarted with it already set. Recording
    // the choice anyway means the next `session/new`/`session/load` sends
    // it via `_meta` and the agent comes up already offering it, instead of
    // the pick silently reverting.
    if (/invalid value/i.test(message)) {
      s.info.configValues = { ...s.info.configValues, [configId]: value }
      mgr.schedulePersist(s.ref)
      throw new Error(
        `agent does not offer ${configId} ${value} in this session; it will be pinned on the next start`,
        { cause: e }
      )
    }
    throw e
  }
  s.info.configValues = { ...s.info.configValues, [configId]: value }
  // Confirm the change in the timeline. Failures already leave system entries
  // ("could not set …"); a success was only visible as the popup's highlight,
  // which is gone the moment the popup closes — and the switch itself is
  // history: it changes how everything below it in the feed should be read.
  // Read names from the post-push option set — the agent may have rewritten it.
  const opt = s.configOptions?.find((o) => o.id === configId)
  const picked = opt?.options?.find((o) => o.value === value)?.name
  const shown = picked ?? (typeof value === 'boolean' ? (value ? 'on' : 'off') : value)
  mgr.push(s, { kind: 'system', text: `${opt?.name ?? configId} → ${shown}` })
  mgr.cacheAgentConfig(s)
  mgr.bus.emit('session.changed', { sessionId })
  mgr.schedulePersist(s.ref)
}
