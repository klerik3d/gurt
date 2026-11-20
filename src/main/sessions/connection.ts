import type { AgentManifest } from '../../shared/agentPlugin'
import type {
  AcpHttpMcpServer,
  ChatEntry,
  ChatEntryBase,
  SessionInfo
} from '../../shared/types'
import { INITIALIZE_RESULT, SESSION_LOAD_RESULT } from '../acp'
import { createAcpClient } from '../acpClient'
import type { Bus } from '../bus'
import type { LaunchContext } from '../containers'
import { JsonRpcPeer } from '../jsonrpc'
import { createLogger } from '../log'
import { scopeKeeper } from '../oauth/keeper'
import type { PiiMask } from '../pii'
import { lineBuffer, spawnAcpAdapter, spawnInContainer } from '../provision'
import { normalizeConfigOptions, normalizeModes } from './modes'
import { ACP_REQUEST_TIMEOUT_MS, adapterExitCode } from './pure'
import type { Connection, Session, SessionEvents } from './types'

const log = createLogger('sessions')

// One ACP adapter per session: spawning it, attaching to (or loading) the agent's
// session, and letting it go. Callers share one in-flight spawn / attach per
// session (`connection`, `attach`).

/** What connection.ts needs of the session manager: its state and the manager's own
 *  operations it calls back into. */
export interface ConnectionCtx {
  applyAutoAllow(s: Session, conn: Connection): Promise<void>
  applyStartConfig(s: Session, conn: Connection): Promise<void>
  readonly attachesInFlight: Map<string, Promise<Connection>>
  attachMcp(s: Session, ctx: LaunchContext): Promise<AcpHttpMcpServer[]>
  attachUncoalesced(s: Session): Promise<Connection>
  readonly bus: Bus
  cacheAgentConfig(s: Session): void
  connection(s: Session, ctx: LaunchContext): Promise<Connection>
  readonly connections: Map<string, Connection>
  connectionUncoalesced(s: Session, ctx: LaunchContext): Promise<Connection>
  readonly connectsInFlight: Map<string, Promise<Connection>>
  readonly detachEpoch: Map<string, number>
  readonly events: SessionEvents
  readonly mask: PiiMask
  maskEnabled(): boolean
  onPermission(params: unknown): unknown
  onSessionUpdate(params: unknown): void
  push(s: Session, entry: ChatEntryBase): ChatEntry
  repoConflict(s: Session): { holder: { info: Pick<SessionInfo, 'id' | 'title'> }; repo: string } | undefined
  readonly sessions: Map<string, Session>
  startMeta(agent: AgentManifest, configValues: Record<string, string | boolean> | undefined): Record<string, unknown> | undefined
}

/**
 * The session's ACP adapter, spawned on first use. A cached connection is
 * reused only while it still belongs to the session's *current* container: a
 * container that was replaced took its adapter process with it, and the id
 * comparison is what makes that impossible to miss. Concurrent callers share
 * one in-flight spawn — `resolveLaunch` coalesces the container ensure, so
 * they hold the same launch context.
 */
export function connection(mgr: ConnectionCtx, s: Session, ctx: LaunchContext): Promise<Connection> {
  const key = s.info.id
  const cached = mgr.connections.get(key)
  if (cached && cached.containerId === ctx.containerId) return Promise.resolve(cached)
  const inflight = mgr.connectsInFlight.get(key)
  if (inflight) return inflight
  const p = mgr.connectionUncoalesced(s, ctx)
  mgr.connectsInFlight.set(key, p)
  p.finally(() => mgr.connectsInFlight.delete(key)).catch(() => {})
  return p
}

export async function connectionUncoalesced(mgr: ConnectionCtx, s: Session, ctx: LaunchContext): Promise<Connection> {
  const key = s.info.id
  const existing = mgr.connections.get(key)
  if (existing && existing.containerId === ctx.containerId) return existing
  if (existing) mgr.connections.delete(key)

  const child = spawnAcpAdapter(
    ctx.exec,
    ctx.agent,
    ctx.secret,
    ctx.secretEnv,
    // The proxy variables go last, so a session's sandbox is not something an
    // agent's own env config can talk its way out of (§4.5).
    { ...ctx.env, ...ctx.proxy.env },
    ctx.gitIdentityEnv
  )
  const spawnedAt = Date.now()
  log.info('agent.spawn', {
    s: key,
    cmd: ctx.agent.bin,
    pid: child.pid,
    c: ctx.containerId,
    // Names only — the adapter's argv and env carry the agent's secret, and
    // "which variables were injected" is the whole diagnostic value anyway.
    env: [
      ...(ctx.secret ? [ctx.secretEnv] : []),
      ...Object.keys(ctx.env ?? {}),
      ...Object.keys(ctx.proxy.env),
      ...Object.keys(ctx.gitIdentityEnv ?? {})
    ]
  })
  // The adapter's own diagnostics: the reason a start fails is almost always
  // here, so it goes to the session's provisioning log — which the bus tap
  // routes to `logs/session-<id>.log`, line-buffered and redacted per line.
  // Same `lineBuffer` provision.ts's own child processes use, so a secret
  // split across two `data` chunks is never forwarded in halves here either.
  const stderrBuf = lineBuffer((line) =>
    mgr.bus.emit('provision.log', { key, line: `[agent] ${line}` })
  )
  child.stderr.on('data', (d: Buffer) => stderrBuf.push(d))
  const peer = new JsonRpcPeer(
    child,
    (err) => log.error('internal.fail', { site: 'agent-process', s: key, pid: child.pid, err }),
    key
  )
  // Built now (not after `initialize` resolves) so the close handler below —
  // which can fire before `initialize` ever comes back — closes over the
  // same object `detach()` marks, rather than reading a variable that may
  // not be assigned yet.
  const conn: Connection = {
    peer,
    sessionId: key,
    containerId: ctx.containerId,
    agent: ctx.agent.id,
    kill: () => child.kill()
  }
  child.on('close', (code, signal) => {
    // The last line is often the one that explains the exit — an unterminated
    // remainder must not be dropped just because no further '\n' is coming.
    stderrBuf.flush()
    const ms = Date.now() - spawnedAt
    log.info('agent.exit', {
      s: key,
      pid: child.pid,
      code: adapterExitCode(code, signal),
      signal: signal ?? undefined,
      ms
    })
    // Only clear the slot if it still holds *this* process — a replaced
    // container's adapter must not evict its successor on its way out.
    if (mgr.connections.get(key)?.peer === peer) mgr.connections.delete(key)
    conn.client?.dispose()
    const expected = conn.expectedExit === true
    const dead = mgr.sessions.get(key)
    // Captured before anything below resets it — "was this session doing
    // something" at the moment the adapter actually died, for §2's "while
    // running/waiting" rule (an idle session's container going down
    // out-of-band is not a crash mid-work).
    const wasLive = !!dead && (dead.busy || dead.pendingPermissions.size > 0)
    if (dead) {
      dead.attached = false
      const wasAwaiting = dead.pendingPermissions.size > 0
      for (const resolve of dead.pendingPermissions.values())
        resolve({ outcome: { outcome: 'cancelled' } })
      dead.pendingPermissions.clear()
      if (wasAwaiting)
        mgr.bus.emit('session.awaiting', {
          sessionId: dead.info.id,
          ref: dead.ref,
          awaiting: false
        })
      if (dead.busy) {
        dead.busy = false
        mgr.push(dead, { kind: 'system', text: 'agent process exited' })
      }
      // The in-flight `session/prompt` of a busy session rejects with the peer,
      // so its runPrompt still emits the `session.turn` ended the idle policy needs.
      // The adapter is what makes a session live: its exit ends this run, and
      // the record carries the run's shape (turns, wall time, how it died).
      log.info('session.end', {
        s: key,
        turns: dead.turns,
        ms: dead.startedAt ? Date.now() - dead.startedAt : ms,
        stopReason: dead.lastStopReason,
        exitCode: adapterExitCode(code, signal)
      })
    }
    // Covers a session that was NOT busy: the auto-stop policy re-evaluates it
    // on adapter death even when no turn end will ever fire.
    mgr.bus.emit('session.adapterExited', { sessionId: key, expected, wasLive })
  })

  peer.onNotification('session/update', (params) => mgr.onSessionUpdate(params))
  peer.onRequest('session/request_permission', (params) => mgr.onPermission(params))

  // The client methods — only for a session that masks. Advertising them is
  // what makes an agent route its file access and commands through gurt, where
  // the PII barrier can reach them (docs/requirements-pii-mask.md §9); a
  // session that does not mask keeps its agent doing both for itself, exactly
  // as before.
  const barrier = mgr.maskEnabled()
  if (barrier) {
    conn.client = createAcpClient({
      session: key,
      agent: ctx.agent.id,
      cwd: s.remoteCwd ?? ctx.remoteWorkspaceFolder,
      exec: (argv, env) => spawnInContainer(ctx.exec, argv, env),
      encode: (text) => mgr.mask.encode(key, text),
      reveal: (text) => mgr.mask.decode(key, text)
    })
    for (const [method, handler] of Object.entries(conn.client.handlers))
      peer.onRequest(method, handler)
  }

  let init
  try {
    init = await peer.request(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: barrier, writeTextFile: barrier },
          terminal: barrier,
          // Opt in to boolean config options so agents may expose native toggles
          // (e.g. Claude's "Fast mode") instead of degrading them to a select.
          session: { configOptions: { boolean: {} } }
        }
      },
      INITIALIZE_RESULT,
      { timeoutMs: ACP_REQUEST_TIMEOUT_MS }
    )
  } catch (e) {
    // The process is up but never became an ACP peer (hung, or spoke garbage)
    // — it would outlive this failed connect as an orphan inside the
    // container. Its exit is expected: this kill *is* the cleanup.
    conn.expectedExit = true
    conn.kill()
    throw e
  }

  conn.promptCapabilities = init.agentCapabilities?.promptCapabilities
  conn.canFork = init.agentCapabilities?.sessionCapabilities?.fork != null
  // The session may have been deleted while the adapter was coming up. Its
  // `detach` found no connection to kill (this one did not exist yet), so
  // this process is the one thing that would outlive it — and caching it
  // would leak a connection nobody can reach.
  if (mgr.sessions.get(key) !== s) {
    conn.expectedExit = true
    conn.kill()
    throw new Error('session no longer exists')
  }
  mgr.connections.set(key, conn)
  mgr.cacheAgentConfig(s)
  return conn
}

/** Reconnect a session: spawn the adapter if needed and session/load.
 *  Concurrent callers share one in-flight attach — a prompt and a config
 *  change on a detached session would otherwise both `session/load`. */
export function attach(mgr: ConnectionCtx, s: Session): Promise<Connection> {
  const cached = mgr.connections.get(s.info.id)
  if (cached && s.attached) return Promise.resolve(cached)
  const inflight = mgr.attachesInFlight.get(s.info.id)
  if (inflight) return inflight
  const p = mgr.attachUncoalesced(s)
  mgr.attachesInFlight.set(s.info.id, p)
  p.finally(() => mgr.attachesInFlight.delete(s.info.id)).catch(() => {})
  return p
}

export async function attachUncoalesced(mgr: ConnectionCtx, s: Session): Promise<Connection> {
  const existing = mgr.connections.get(s.info.id)
  if (existing && s.attached) return existing
  // We're going to re-open the session (resolveLaunch wakes the container, then
  // session/load). Raise the "resuming" indicator NOW — before the slow
  // container wake — so the UI reads "resuming…" for the whole reattach rather
  // than "thinking…" until the container is up and only then flipping. Resuming
  // is a live indicator (snapshot.resuming), never chat history.
  const resuming = !s.attached
  if (resuming) {
    s.loading = true
    mgr.bus.emit('session.changed', { sessionId: s.info.id })
  }
  try {
    // Waking a session brings its container back up on the shared clone, so it
    // is gated exactly like a start — otherwise a resume could put two live
    // containers on one working tree.
    const conflict = mgr.repoConflict(s)
    if (conflict)
      throw new Error(
        `repository "${conflict.repo}" is in use by session "${conflict.holder.info.title}" — wait for it to go idle`
      )
    const ctx = await mgr.events.resolveLaunch(s.info.id)
    s.remoteCwd = ctx.remoteWorkspaceFolder
    // Same ordering as a start: the resumed session's proxy is a *new*
    // container with no scope, so the scope is pushed before the adapter that
    // will use it. A session that is still attached kept both, and re-pushing
    // is what a scope edit does — not what a reconnect does.
    const mcpServers = s.attached ? [] : await mgr.attachMcp(s, ctx)
    const conn = await mgr.connection(s, ctx)
    if (!s.attached) {
      if (!s.acpSessionId) throw new Error('session was never started')
      try {
        // Same `_meta` a start sends to `session/new`: an adapter may only
        // offer a pinned pick (a model, say) when launched with it pinned.
        // Without this, a reload brings up an adapter whose picker forgot
        // the pin, and the next `session/set_config_option` for it is
        // rejected as an invalid value.
        const meta = mgr.startMeta(ctx.agent, s.info.configValues)
        const result = await conn.peer.request(
          'session/load',
          {
            sessionId: s.acpSessionId,
            cwd: ctx.remoteWorkspaceFolder,
            mcpServers,
            ...(meta ? { _meta: meta } : {})
          },
          SESSION_LOAD_RESULT,
          { timeoutMs: ACP_REQUEST_TIMEOUT_MS }
        )
        s.modes = normalizeModes(result.modes) ?? s.modes
        s.configOptions =
          normalizeConfigOptions(result.configOptions, ctx.agent.id) ?? s.configOptions
        s.attached = true
        // Same reconciliation a start does, for picks `_meta` above can't
        // carry (e.g. fast mode): a resumed adapter otherwise comes back on
        // its own defaults and the session silently changes them the first
        // time its container has been asleep — the pick is still shown, but
        // a different value answers the next turn.
        await mgr.applyStartConfig(s, conn)
        mgr.cacheAgentConfig(s)
        await mgr.applyAutoAllow(s, conn)
      } catch (e) {
        mgr.push(s, {
          kind: 'system',
          text: `could not resume (${e instanceof Error ? e.message : String(e)}) — create a new session`
        })
        throw e
      }
    }
    return conn
  } finally {
    if (resuming) {
      s.loading = false
      mgr.bus.emit('session.changed', { sessionId: s.info.id })
    }
  }
}

// --- connections --------------------------------------------------------

/**
 * Drop everything this session's container backs: the ACP adapter running
 * inside it and the host MCP servers pointed at its clone. Called by the
 * container manager immediately *before* the container is stopped or removed,
 * which is the whole reason nothing container-derived can go stale — there is
 * one such path, and it runs first.
 */
export function detach(mgr: ConnectionCtx, sessionId: string): void {
  const conn = mgr.connections.get(sessionId)
  const s = mgr.sessions.get(sessionId)
  // Only a live adapter's death is "expected" here — with no connection,
  // there is nothing about to close, so this call is not the cause of one.
  if (conn) {
    conn.expectedExit = true
    conn.kill()
  }
  mgr.events.stopMcpServers(sessionId)
  // Before the scope is revoked: a renewal landing after it would rewrite the
  // file the revocation removed. The epoch also voids an `attachMcp` that is
  // still in flight and would arm a watch after this.
  mgr.detachEpoch.set(sessionId, (mgr.detachEpoch.get(sessionId) ?? 0) + 1)
  scopeKeeper.unwatch(sessionId)
  if (s) s.attached = false
}

/**
 * Wake a loop executor's container without attaching its agent — the review
 * loop's check needs the clone's toolchain, not the agent (§5.3). Gated like a
 * resume (`repoConflict`; the held executor is its own clone's holder, so only
 * a foreign claim refuses it), then `resolveLaunch`: the container up, its
 * adapter volume checked, the proxy scope converged, credentials in place — and no
 * `session/load`. Rejecting means the check cannot run.
 */
export async function ensureContainerUp(mgr: ConnectionCtx, sessionId: string): Promise<void> {
  const s = mgr.sessions.get(sessionId)
  if (!s) throw new Error('unknown session')
  const conflict = mgr.repoConflict(s)
  if (conflict)
    throw new Error(
      `repository "${conflict.repo}" is in use by session "${conflict.holder.info.title}" — wait for it to go idle`
    )
  await mgr.events.resolveLaunch(sessionId)
}
