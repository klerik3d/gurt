// Container lifecycle. One container per session, strictly: created at the
// session's first start, stopped when it goes idle, destroyed with it. Nothing
// here is keyed by env — an env is a *definition* (which devcontainer.json to
// build), and several sessions of a task may run the same one while owning
// separate containers.
//
// The state this manager derives — installed git shims, and, over in the
// session manager, the ACP adapter — is keyed by container id, never by session
// or env name. A container id is minted by `docker` and never reused, so a
// record keyed by it cannot survive the thing it describes. That is what makes
// stale-cache reuse unrepresentable rather than merely avoided.
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import type { EnvRef, RepoConfig, SessionContainer, SessionInfo } from '../shared/types'
import { roleIsReadOnly, sessionRole } from '../shared/types'
import type { ContainerStatusReason } from '../shared/events'
import type { AgentDef } from '../shared/agents'
import { agentDef } from '../shared/agents'
import { canonicalRepoId } from '../shared/repoId'
import { resolveCredential, resolveAgentSecret, credentialIdentity } from '../shared/credentials'
import { listCredentials } from './credentials'
import { resolveGitBroker, stopGitBroker } from './git/broker'
import { containerGitEnv } from './git/config'
import * as store from './store'
import { cloneDir } from './store'
import {
  adapterPresent,
  devcontainerUp,
  dockerRemove,
  dockerRunning,
  dockerSessionContainerIds,
  dockerSessionContainers,
  dockerStop,
  ensureClone,
  installAcpAdapter,
  installGitShims,
  materializeEnvConfig,
  overrideConfigArgs,
  mountedConfigPath
} from './provision'
import type { Bus } from './bus'
import { createLogger, errCtx } from './log'

const log = createLogger('containers')

/** Order-sensitive: a reorder changes which repo is the build anchor, so it
 *  counts as a real change (forces a rebuild) same as adding/removing one. */
function sameRepos(a: string[] | undefined, b: string[]): boolean {
  return !!a && a.length === b.length && a.every((r, i) => r === b[i])
}

/**
 * Does this session mount its repos explicitly, into an empty wrapper directory
 * used as `--workspace-folder`? Two cases need it: more than one repo (there is
 * no single clone the workspace folder could be), and every read-only role — the
 * mount the CLI derives from `--workspace-folder` is always read-write, so a
 * read-only clone has to be an explicit `--mount` alongside it.
 *
 * A plain read-write single-repo session (an executor) is unchanged: the clone
 * dir *is* the workspace folder, no extra mounts at all.
 */
function usesRepoMounts(info: SessionInfo): boolean {
  return info.repos.length > 1 || roleIsReadOnly(sessionRole(info))
}

/** Everything needed to (re)spawn the agent process for a session. */
export interface LaunchContext {
  agent: AgentDef
  /** Owning session — also the container's identity (`gurt.session` id-label). */
  session: string
  /** The container the adapter runs in; the key of every container-bound cache. */
  containerId: string
  remoteWorkspaceFolder: string
  hostWorkspaceFolder: string
  configArgs: string[]
  secret: string
  secretEnv: string
  /** Extra env vars for the adapter (e.g. a local model's base URL). */
  env?: Record<string, string>
  /** Git-access injection (§6): broker URL + GIT_CONFIG_*; present only when the
   *  session enabled git access. Never secrets. */
  gitBrokerEnv?: Record<string, string>
}

export interface ContainerManagerDeps {
  bus: Bus
  /** Live session record, or undefined once it is deleted. */
  session(id: string): SessionInfo | undefined
  /** Every live session — the boot reconcile and task teardown walk these. */
  sessions(): SessionInfo[]
  /** Write the session's container state (persist + announce). */
  patchContainer(id: string, patch: SessionContainer | undefined): void
  /** True when the session is neither busy nor mid-start. */
  isSessionIdle(id: string): boolean
  /**
   * Drop everything the session's container backed — its ACP adapter, its host
   * MCP servers. Always called *before* the container is stopped or removed, so
   * nothing derived from it can outlive it.
   */
  detach(id: string): void
}

export class ContainerManager {
  /** In-flight `up` per session, so concurrent start/attach share one. */
  private ensureInFlight = new Map<string, Promise<SessionContainer>>()
  // Both caches below are keyed by container id, and both describe things
  // living in that container's filesystem. A container id is minted by Docker
  // and never reused, so these cannot address a container that has been
  // replaced — and `forget` drops them when one is destroyed, so they do not
  // grow without bound either.
  /** Container ids whose git shims are installed. */
  private shimmed = new Set<string>()
  /** Container ids the agent's adapter packages are installed in. */
  private adapterInstalled = new Set<string>()
  /** In-flight adapter install per container id. npm rewrites a global package
   *  non-atomically (delete, then re-extract), so two overlapping `npm install
   *  -g` into one filesystem leave a window where an adapter spawned after the
   *  first install imports the second one's half-written files. Concurrent
   *  callers must share one install, the way `ensureInFlight` shares one up. */
  private installsInFlight = new Map<string, Promise<void>>()
  /** Container is stopped after its session sits idle this long. */
  private readonly IDLE_STOP_MS = 10 * 60_000
  private idleTimers = new Map<string, NodeJS.Timeout>()

  constructor(private deps: ContainerManagerDeps) {}

  private logFor(sessionId: string): (line: string) => void {
    return (line) => this.deps.bus.emit('provision.log', { key: sessionId, line })
  }

  private refOf(info: SessionInfo): EnvRef {
    return { workspace: info.workspace, task: info.task, env: info.env }
  }

  /** Patch the session's container record and announce the new status. */
  private setStatus(id: string, patch: SessionContainer, reason: ContainerStatusReason): void {
    this.deps.patchContainer(id, patch)
    const info = this.deps.session(id)
    if (info)
      this.deps.bus.emit('container.status', {
        sessionId: id,
        ref: this.refOf(info),
        status: patch.status,
        reason
      })
    this.deps.bus.emit('tree.changed', undefined)
  }

  container(id: string): SessionContainer | undefined {
    return this.deps.session(id)?.container
  }

  status(id: string): SessionContainer['status'] {
    return this.container(id)?.status ?? 'stopped'
  }

  /**
   * Launch VS Code attached to this session's running container, in its own
   * window. Goes through the `code` CLI with `--new-window` rather than the
   * `vscode://` URI handler (`shell.openExternal`), which reuses whatever
   * window is already focused instead of opening one per session. Throws if
   * the container isn't up — the header button gates on `running`.
   *
   * `--disable-workspace-trust`: the folder URI is keyed on the container id,
   * which changes on every recreate, so VS Code would otherwise treat each
   * attach as a brand-new untrusted workspace and prompt every time. The
   * container is already gurt's own sandbox, so there's nothing to gate here.
   */
  openVscode(sessionId: string): Promise<void> {
    const c = this.container(sessionId)
    if (c?.status !== 'running' || !c.id || !c.remoteWorkspaceFolder)
      throw new Error('container is not running')
    const hex = Buffer.from(c.id).toString('hex')
    const folderUri = `vscode-remote://attached-container+${hex}${c.remoteWorkspaceFolder}`
    return new Promise((resolve, reject) => {
      const child = spawn(
        'code',
        ['--new-window', '--disable-workspace-trust', '--folder-uri', folderUri],
        { stdio: 'ignore', detached: true }
      )
      child.on('error', () =>
        reject(new Error('could not launch "code" — install the VS Code shell command'))
      )
      child.on('spawn', () => {
        child.unref()
        resolve()
      })
    })
  }

  /**
   * Ensure this session's container is up: clone (if needed) and `devcontainer
   * up` under the session's id-label — creating its container, or restarting the
   * one it already owns. Who may start at all is the scheduler's gate, not this.
   */
  ensure(sessionId: string): Promise<SessionContainer> {
    const inflight = this.ensureInFlight.get(sessionId)
    if (inflight) return inflight
    const p = this.ensureUncoalesced(sessionId)
    this.ensureInFlight.set(sessionId, p)
    p.finally(() => this.ensureInFlight.delete(sessionId)).catch(() => {})
    return p
  }

  private async ensureUncoalesced(sessionId: string): Promise<SessionContainer> {
    const info = this.deps.session(sessionId)
    if (!info) throw new Error('session no longer exists')
    if (!info.repos.length) throw new Error('session has no repository')
    const provisionLog = this.logFor(sessionId)

    // Its own container, still up → just reuse it. (Probe the daemon: a Docker
    // restart leaves a persisted `running` record describing an exited container.)
    const owned = info.container
    if (
      owned?.status === 'running' &&
      owned.id &&
      owned.remoteWorkspaceFolder &&
      sameRepos(owned.repos, info.repos) &&
      (await dockerRunning(owned.id))
    )
      return owned

    const ws = await store.getWorkspace(info.workspace)
    const repoCfgs = info.repos.map((name) => {
      const cfg = ws.repos.find((r) => r.name === name)
      if (!cfg) throw new Error(`repo "${name}" is not registered in "${info.workspace}"`)
      return cfg
    })
    const envCfg = ws.envs.find((e) => e.name === info.env)
    if (!envCfg) throw new Error(`env "${info.env}" is not registered in "${info.workspace}"`)

    // A container this session owns but can no longer use — it was built for a
    // different repo set, or it is stopped/errored. `devcontainer up` would
    // restart a stopped one in place, so only a repo change forces a rebuild.
    if (owned?.id && owned.repos.length && !sameRepos(owned.repos, info.repos)) {
      this.deps.detach(sessionId)
      this.forget(owned.id)
      await dockerRemove(owned.id, provisionLog)
    }

    // `building` covers the clone and the image (ours or the CLI's); `up` flips
    // it to `post` as soon as the container exists and its hooks start running.
    this.setStatus(
      sessionId,
      { repos: info.repos, ...(owned ?? {}), status: 'building', error: undefined },
      'user'
    )
    // Each provisioning step is timed on its own — "which phase is slow" is the
    // first question a slow start raises, and the phases have wildly different
    // costs (a cold image build vs. a restart of an existing container).
    let phase: 'clone' | 'image' | 'up' = 'clone'
    let since = Date.now()
    /** Close the running phase, logging its duration; opens `next` if given. */
    const enter = (next?: typeof phase): void => {
      log.info('provision.phase', { s: sessionId, phase, ms: Date.now() - since })
      if (!next) return
      phase = next
      since = Date.now()
    }
    try {
      const dirs = await Promise.all(
        repoCfgs.map((r) => ensureClone(this.refOf(info), r, provisionLog))
      )
      enter('image')
      // repos[0] is the build anchor, same role a normal session's only repo
      // plays today — every other repo (if any) is a sibling mount only.
      const configArgs = await materializeEnvConfig(
        this.refOf(info),
        envCfg,
        repoCfgs[0],
        dirs[0],
        provisionLog
      )
      enter('up')
      const mounted = usesRepoMounts(info)
      const readonly = roleIsReadOnly(sessionRole(info))
      // Read-write single repo (an executor): unchanged — `--workspace-folder`
      // IS the clone, exactly as before. Otherwise `--workspace-folder` is an
      // empty wrapper dir and every repo (anchor included) is mounted into it
      // explicitly, so none of them sits at the container's top-level workspace
      // folder and each carries its own read-only flag.
      let workspaceFolder = dirs[0]
      let extraMounts: { hostDir: string; name: string; readonly?: boolean }[] = []
      if (mounted) {
        workspaceFolder = store.mountedWorkspaceDir(info.workspace, info.task, sessionId)
        await fs.mkdir(workspaceFolder, { recursive: true })
        extraMounts = repoCfgs.map((r, i) => ({ hostDir: dirs[i], name: r.name, readonly }))
      }
      const up = await devcontainerUp(
        sessionId,
        configArgs,
        workspaceFolder,
        provisionLog,
        mounted ? 'repos' : repoCfgs[0].name,
        canonicalRepoId(repoCfgs[0].url)?.host,
        () =>
          this.setStatus(
            sessionId,
            { repos: info.repos, ...(this.container(sessionId) ?? {}), status: 'post' },
            'user'
          ),
        extraMounts
      )
      // Deleted mid-start: this container was born after its session's delete
      // had already looked for one to take down, so nothing owns it and nothing
      // records it (`patchContainer` on a gone session is a no-op). Remove it
      // here rather than leaving an orphan for the next boot reconcile.
      if (!this.deps.session(sessionId)) {
        this.forget(up.containerId)
        await dockerRemove(up.containerId, provisionLog)
        throw new Error('session no longer exists')
      }
      const next: SessionContainer = {
        status: 'running',
        id: up.containerId,
        remoteWorkspaceFolder: up.remoteWorkspaceFolder,
        repos: info.repos
      }
      this.setStatus(sessionId, next, 'user')
      enter()
      provisionLog('container is running')
      return next
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.setStatus(
        sessionId,
        { repos: info.repos, ...(owned ?? {}), status: 'error', error: message },
        'error'
      )
      log.error('provision.fail', { s: sessionId, phase, code: errCtx(e).code, err: e })
      provisionLog(`error: ${message}`)
      throw e
    }
  }

  /**
   * Provision the git-access injection for a starting session: ensure the broker
   * is up and the shims are installed in *this* container, and return the
   * injection env (§6). Secrets never appear here — only the broker URL + token.
   */
  private async resolveGitAccess(
    info: SessionInfo,
    repo: RepoConfig,
    containerId: string
  ): Promise<Record<string, string>> {
    const host = canonicalRepoId(repo.url)?.host ?? null
    const broker = await resolveGitBroker(info.id, repo)
    const resolved = host ? resolveCredential(await listCredentials(), repo, host) : undefined
    if (!this.shimmed.has(containerId)) {
      await installGitShims(containerId, host, this.logFor(info.id))
      this.shimmed.add(containerId)
    }
    // Identity only from a clean resolution — an errored one (e.g. unverified
    // entry, §3.2) injects nothing, and the broker refuses it per request too.
    const identity = resolved?.entry && !resolved.error ? credentialIdentity(resolved.entry) : null
    return containerGitEnv(broker.url, host, resolved?.kind ?? 'git-host', identity)
  }

  /** Ensure the session's container is up, then build its validated launch context. */
  async resolveLaunch(sessionId: string): Promise<LaunchContext> {
    const info = this.deps.session(sessionId)
    if (!info) throw new Error('session no longer exists')
    const agentId = info.agent
    if (!agentId) throw new Error('session has no agent')
    const agents = await store.getAgents()
    const cfg = agents[agentId]
    if (!cfg) throw new Error(`unknown agent "${agentId}"`)
    const def = agentDef(cfg.kind)
    if (!def) throw new Error(`agent "${cfg.label}" has unknown kind "${cfg.kind}"`)
    // The secret lives in credentials.json; the agent only links it (§6).
    const { secret, error: credError } = resolveAgentSecret(
      await listCredentials(),
      cfg.credentialId
    )
    if (credError) throw new Error(`agent "${cfg.label}": ${credError}`)
    if (!info.repos.length) throw new Error('session has no repository')
    const ws = await store.getWorkspace(info.workspace)
    const repoCfg = ws.repos.find((r) => r.name === info.repos[0])
    if (!repoCfg)
      throw new Error(`repo "${info.repos[0]}" is not registered in "${info.workspace}"`)

    const c = await this.ensure(sessionId)
    if (c.status !== 'running' || !c.id || !c.remoteWorkspaceFolder)
      throw new Error('container is not running')

    const mounted = usesRepoMounts(info)
    // Must match whatever `ensureUncoalesced` passed as `--workspace-folder`
    // for this same session — the wrapper dir whenever the repos are mounted
    // explicitly, the plain clone dir otherwise.
    const hostWorkspaceFolder = mounted
      ? store.mountedWorkspaceDir(info.workspace, info.task, sessionId)
      : cloneDir(info.workspace, info.task, info.repos[0])
    return {
      agent: def,
      session: sessionId,
      containerId: c.id,
      remoteWorkspaceFolder: c.remoteWorkspaceFolder,
      hostWorkspaceFolder,
      // The file behind these args was written by ensure's up (and persists
      // across app restarts) — up and every exec resolve the same config: the
      // env's materialized file, or the session's merged copy when the repos
      // are mounted explicitly (extra mounts + wrapper workspaceFolder).
      configArgs: mounted
        ? ['--override-config', mountedConfigPath(hostWorkspaceFolder)]
        : overrideConfigArgs(this.refOf(info)),
      secret,
      secretEnv: cfg.secretEnv || def.secretEnv,
      env: cfg.env,
      // The git broker is scoped to one repo for its whole container lifetime —
      // unavailable across several repos regardless of `gitAccess`. A read-only
      // role gets none either: its clone refuses writes at the mount, so native
      // git would only fail later and more confusingly.
      gitBrokerEnv:
        info.gitAccess && info.repos.length === 1 && !roleIsReadOnly(sessionRole(info))
          ? await this.resolveGitAccess(info, repoCfg, c.id)
          : undefined
    }
  }

  /** Install the agent's adapter packages in the session's container, once per
   *  container. Idempotent: a stop/start keeps the same container (and its
   *  filesystem), a replacement gets a new id and so reinstalls. The in-memory
   *  set only fast-paths that answer within one app process — a fresh process
   *  probes the container itself before reinstalling into it. */
  installAdapter(ctx: LaunchContext): Promise<void> {
    if (this.adapterInstalled.has(ctx.containerId)) return Promise.resolve()
    const inflight = this.installsInFlight.get(ctx.containerId)
    if (inflight) return inflight
    const p = (async () => {
      const log = this.logFor(ctx.session)
      if (await adapterPresent(ctx.session, ctx.agent, ctx.configArgs, ctx.hostWorkspaceFolder))
        log(`${ctx.agent.bin} already installed in container`)
      else
        await installAcpAdapter(ctx.session, ctx.agent, ctx.configArgs, ctx.hostWorkspaceFolder, log)
      this.adapterInstalled.add(ctx.containerId)
    })()
    this.installsInFlight.set(ctx.containerId, p)
    p.finally(() => this.installsInFlight.delete(ctx.containerId)).catch(() => {})
    return p
  }

  // --- teardown -----------------------------------------------------------

  /** Drop every host-side record derived from a container that is going away. */
  private forget(containerId: string): void {
    this.shimmed.delete(containerId)
    this.adapterInstalled.delete(containerId)
  }

  /**
   * The single teardown path. `stop` keeps the container (and everything in its
   * filesystem) so the session can resume into it; `remove` destroys it. Both
   * detach first — nothing derived from a container may outlive it.
   *
   * `remove` is deliberately record-independent. `up` stamps the `gurt.session`
   * id-label at `docker run`, but the container id only reaches the session
   * record once `up` *returns*: a start that fails in between (a post-command
   * that exits non-zero is the common one) leaves a live container the record
   * knows nothing about. Removing what the record names would leak exactly
   * those, until a boot reconcile hours later swept them as orphans. So this
   * asks the daemon — the actual registry — which containers carry the
   * session's label, and removes those together with any recorded id.
   */
  private async teardown(
    sessionId: string,
    mode: 'stop' | 'remove',
    reason: ContainerStatusReason
  ): Promise<void> {
    this.noteActive(sessionId)
    this.deps.detach(sessionId)
    stopGitBroker(sessionId)
    // A start already in flight is creating a container that neither the record
    // nor the daemon can name yet. Let it settle first — it either records its
    // container (which the sweep below then finds) or fails having left one
    // behind (which the sweep finds too). Stop does not wait: it is the idle
    // path, and a session that is starting is by definition not idle.
    if (mode === 'remove') await this.ensureInFlight.get(sessionId)?.catch(() => {})
    const c = this.container(sessionId)
    if (mode === 'stop') {
      if (!c?.id) return
      this.forget(c.id)
      const provisionLog = this.logFor(sessionId)
      const started = Date.now()
      await dockerStop(c.id, provisionLog)
      this.setStatus(sessionId, { ...c, status: 'stopped', error: undefined }, reason)
      log.info('container.stop', { s: sessionId, c: c.id, reason, ms: Date.now() - started })
      provisionLog('container stopped')
      return
    }
    const provisionLog = this.logFor(sessionId)
    const started = Date.now()
    // `null` (docker unreachable) is not `[]`: fall back to the recorded id
    // rather than read the daemon's silence as "this session owns nothing".
    const swept = (await dockerSessionContainerIds(sessionId)) ?? []
    const recorded = c?.id
    // Prefix, not equality: `docker ps` and the devcontainer CLI disagree on
    // whether a container id is the short or the full form, and the same
    // container named both ways must not be removed (or counted) twice.
    const isRecorded = (id: string): boolean =>
      !!recorded && (id.startsWith(recorded) || recorded.startsWith(id))
    const ids = recorded && !swept.some(isRecorded) ? [...swept, recorded] : swept
    for (const id of ids) {
      this.forget(id)
      await dockerRemove(id, provisionLog)
    }
    this.deps.patchContainer(sessionId, undefined)
    this.deps.bus.emit('tree.changed', undefined)
    if (!ids.length) return
    log.info('container.remove', {
      s: sessionId,
      c: ids.join(','),
      // Containers the record never named: this teardown is the only thing that
      // would ever have removed them. Worth seeing in the log when it happens.
      unrecorded: swept.filter((id) => !isRecorded(id)).length,
      reason,
      ms: Date.now() - started
    })
    provisionLog(ids.length > 1 ? `${ids.length} containers removed` : 'container removed')
  }

  /** Stop the session's container; it keeps its filesystem and can resume. */
  async stop(sessionId: string, reason: ContainerStatusReason = 'user'): Promise<void> {
    await this.teardown(sessionId, 'stop', reason)
  }

  /**
   * Destroy the session's container — the session was deleted, or its draft was
   * re-pointed at another repo/env. The clone stays: uncommitted work in the
   * working tree outlives the session that produced it.
   */
  async release(sessionId: string, reason: ContainerStatusReason = 'user'): Promise<void> {
    await this.teardown(sessionId, 'remove', reason)
  }

  /** Stop every container of a task — a rename is about to move its directory,
   *  and a running container's bind mount is pinned to the old path. */
  async stopTask(ws: string, task: string): Promise<void> {
    for (const info of this.sessionsOf(ws, task))
      if (info.container && info.container.status !== 'stopped') await this.stop(info.id, 'user')
  }

  /** Destroy every container of a task — the task is going away. The clones go
   *  with the task directory the caller removes next, so they are not touched
   *  here: outside of deleting the task, a clone always outlives its sessions. */
  async teardownTask(ws: string, task: string): Promise<void> {
    for (const info of this.sessionsOf(ws, task)) await this.release(info.id, 'task-deleted')
  }

  /** Destroy every container of every task in a workspace — the workspace is
   *  going away in full, clones included. */
  async teardownWorkspace(ws: string): Promise<void> {
    for (const info of this.deps.sessions().filter((s) => s.workspace === ws))
      await this.release(info.id, 'workspace-deleted')
  }

  private sessionsOf(ws: string, task: string): SessionInfo[] {
    return this.deps.sessions().filter((s) => s.workspace === ws && s.task === task)
  }

  // --- idle auto-stop ------------------------------------------------------

  /** The session started work (or the user is typing) — cancel a pending stop. */
  noteActive(sessionId: string): void {
    const timer = this.idleTimers.get(sessionId)
    if (!timer) return
    clearTimeout(timer)
    this.idleTimers.delete(sessionId)
  }

  /** The session is neither busy nor starting — schedule its container's stop. */
  noteIdle(sessionId: string): void {
    this.noteActive(sessionId)
    const timer = setTimeout(() => {
      this.idleTimers.delete(sessionId)
      this.autoStopIfIdle(sessionId).catch((e) =>
        log.error('internal.fail', { site: 'container-auto-stop', s: sessionId, err: e })
      )
    }, this.IDLE_STOP_MS)
    // Background housekeeping must not be a reason for the process to stay
    // alive: Electron's loop keeps running regardless, while a headless embedder
    // (scripts, tests, the orchestrator) should be free to exit.
    timer.unref?.()
    this.idleTimers.set(sessionId, timer)
  }

  /** Re-verify idle *and* running before stopping — the session may have resumed
   *  in the window after the timer fired, and a non-running status (e.g. `error`
   *  from a failed start) must not be clobbered with `stopped`. */
  private async autoStopIfIdle(sessionId: string): Promise<void> {
    if (!this.deps.isSessionIdle(sessionId)) return
    if (this.status(sessionId) !== 'running') return
    await this.stop(sessionId, 'idle')
  }

  // --- boot reconcile ------------------------------------------------------

  /**
   * Make the persisted records agree with the daemon, which is the real registry
   * (`gurt.session` id-labels). Two directions:
   *   - a record describing a container Docker no longer has, or that is not
   *     actually running, is corrected — otherwise a start would try to exec
   *     into a container that is gone;
   *   - a container whose session no longer exists is an orphan (its session was
   *     deleted while the app was down, or a crash lost the record) and is removed.
   */
  async reconcile(): Promise<void> {
    const live = await dockerSessionContainers()
    // Could not reach the daemon — leave every record alone rather than read its
    // silence as "no containers exist" and delete all of them.
    if (!live) {
      log.warn('reconcile skipped — docker unavailable, container records left as-is')
      return
    }
    let fixed = 0
    let orphans = 0
    const known = new Set<string>()
    for (const info of this.deps.sessions()) {
      known.add(info.id)
      const c = info.container
      if (!c) continue
      const actual = live.get(info.id)
      if (!actual) {
        // Container gone: keep the session, drop the record it can't use.
        this.deps.patchContainer(info.id, undefined)
        fixed++
        continue
      }
      const running = await dockerRunning(actual)
      if (c.id !== actual || (c.status === 'running') !== running) {
        this.setStatus(
          info.id,
          { ...c, id: actual, status: running ? 'running' : 'stopped', error: undefined },
          'reconcile'
        )
        fixed++
      }
    }
    for (const [session, containerId] of live) {
      if (known.has(session)) continue
      orphans++
      // Not `this.logFor(session)`: that would create a `session-<id>.log` for
      // a session that no longer exists — a file nothing would ever delete. The
      // removal is traced by `proc.spawn`/`proc.exit` anyway; the docker output
      // itself goes to the app log at DBG.
      await dockerRemove(containerId, (line) => log.debug('reconcile.orphan', { c: containerId, line }))
    }
    log.info('reconcile.done', { fixed, orphans })
    this.deps.bus.emit('tree.changed', undefined)
  }
}
