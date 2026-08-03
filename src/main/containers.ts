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
import type { EnvRef, RepoConfig, SessionContainer, SessionInfo } from '../shared/types'
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
  devcontainerUp,
  dockerRemove,
  dockerRunning,
  dockerSessionContainers,
  dockerStop,
  ensureClone,
  installAcpAdapter,
  installGitShims,
  materializeEnvConfig,
  overrideConfigArgs
} from './provision'
import type { Bus } from './bus'

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
  private setStatus(id: string, patch: SessionContainer): void {
    this.deps.patchContainer(id, patch)
    const info = this.deps.session(id)
    if (info) this.deps.bus.emit('container.status', { sessionId: id, ref: this.refOf(info), status: patch.status })
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
   */
  openVscode(sessionId: string): Promise<void> {
    const c = this.container(sessionId)
    if (c?.status !== 'running' || !c.id || !c.remoteWorkspaceFolder)
      throw new Error('container is not running')
    const hex = Buffer.from(c.id).toString('hex')
    const folderUri = `vscode-remote://attached-container+${hex}${c.remoteWorkspaceFolder}`
    return new Promise((resolve, reject) => {
      const child = spawn('code', ['--new-window', '--folder-uri', folderUri], {
        stdio: 'ignore',
        detached: true
      })
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
    if (!info.repo) throw new Error('session has no repository')
    const log = this.logFor(sessionId)

    // Its own container, still up → just reuse it. (Probe the daemon: a Docker
    // restart leaves a persisted `running` record describing an exited container.)
    const owned = info.container
    if (
      owned?.status === 'running' &&
      owned.id &&
      owned.remoteWorkspaceFolder &&
      owned.repo === info.repo &&
      (await dockerRunning(owned.id))
    )
      return owned

    const ws = await store.getWorkspace(info.workspace)
    const repoCfg = ws.repos.find((r) => r.name === info.repo)
    if (!repoCfg) throw new Error(`repo "${info.repo}" is not registered in "${info.workspace}"`)
    const envCfg = ws.envs.find((e) => e.name === info.env)
    if (!envCfg) throw new Error(`env "${info.env}" is not registered in "${info.workspace}"`)

    // A container this session owns but can no longer use — it was built for a
    // different repo, or it is stopped/errored. `devcontainer up` would restart
    // a stopped one in place, so only a repo change forces a rebuild.
    if (owned?.id && owned.repo && owned.repo !== info.repo) {
      this.deps.detach(sessionId)
      this.forget(owned.id)
      await dockerRemove(owned.id, log)
    }

    // `building` covers the clone and the image (ours or the CLI's); `up` flips
    // it to `post` as soon as the container exists and its hooks start running.
    this.setStatus(sessionId, { ...(owned ?? {}), status: 'building', error: undefined })
    try {
      const dir = await ensureClone(this.refOf(info), repoCfg, log)
      const configArgs = await materializeEnvConfig(this.refOf(info), envCfg, repoCfg, dir, log)
      const up = await devcontainerUp(
        sessionId,
        configArgs,
        dir,
        log,
        repoCfg.name,
        canonicalRepoId(repoCfg.url)?.host,
        () => this.setStatus(sessionId, { ...(this.container(sessionId) ?? {}), status: 'post' })
      )
      const next: SessionContainer = {
        status: 'running',
        id: up.containerId,
        remoteWorkspaceFolder: up.remoteWorkspaceFolder,
        repo: info.repo
      }
      this.setStatus(sessionId, next)
      log('container is running')
      return next
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.setStatus(sessionId, { ...(owned ?? {}), status: 'error', error: message })
      log(`error: ${message}`)
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
    if (!info.repo) throw new Error('session has no repository')
    const ws = await store.getWorkspace(info.workspace)
    const repoCfg = ws.repos.find((r) => r.name === info.repo)
    if (!repoCfg) throw new Error(`repo "${info.repo}" is not registered in "${info.workspace}"`)

    const c = await this.ensure(sessionId)
    if (c.status !== 'running' || !c.id || !c.remoteWorkspaceFolder)
      throw new Error('container is not running')

    return {
      agent: def,
      session: sessionId,
      containerId: c.id,
      remoteWorkspaceFolder: c.remoteWorkspaceFolder,
      hostWorkspaceFolder: cloneDir(info.workspace, info.task, info.repo),
      // The file behind these args was materialized by ensure's up (and persists
      // across app restarts) — up and every exec resolve the same config.
      configArgs: overrideConfigArgs(this.refOf(info)),
      secret,
      secretEnv: cfg.secretEnv || def.secretEnv,
      env: cfg.env,
      gitBrokerEnv: info.gitAccess
        ? await this.resolveGitAccess(info, repoCfg, c.id)
        : undefined
    }
  }

  /** Install the agent's adapter packages in the session's container, once per
   *  container. Idempotent: a stop/start keeps the same container (and its
   *  filesystem), a replacement gets a new id and so reinstalls. */
  async installAdapter(ctx: LaunchContext): Promise<void> {
    if (this.adapterInstalled.has(ctx.containerId)) return
    await installAcpAdapter(
      ctx.session,
      ctx.agent,
      ctx.configArgs,
      ctx.hostWorkspaceFolder,
      this.logFor(ctx.session)
    )
    this.adapterInstalled.add(ctx.containerId)
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
   */
  private async teardown(sessionId: string, mode: 'stop' | 'remove'): Promise<void> {
    this.noteActive(sessionId)
    this.deps.detach(sessionId)
    stopGitBroker(sessionId)
    const c = this.container(sessionId)
    if (!c?.id) {
      if (mode === 'remove') this.deps.patchContainer(sessionId, undefined)
      return
    }
    this.forget(c.id)
    const log = this.logFor(sessionId)
    if (mode === 'stop') {
      await dockerStop(c.id, log)
      this.setStatus(sessionId, { ...c, status: 'stopped', error: undefined })
      log('container stopped')
    } else {
      await dockerRemove(c.id, log)
      this.deps.patchContainer(sessionId, undefined)
      this.deps.bus.emit('tree.changed', undefined)
      log('container removed')
    }
  }

  /** Stop the session's container; it keeps its filesystem and can resume. */
  async stop(sessionId: string): Promise<void> {
    await this.teardown(sessionId, 'stop')
  }

  /**
   * Destroy the session's container — the session was deleted, or its draft was
   * re-pointed at another repo/env. The clone stays: uncommitted work in the
   * working tree outlives the session that produced it.
   */
  async release(sessionId: string): Promise<void> {
    await this.teardown(sessionId, 'remove')
  }

  /** Stop every container of a task — a rename is about to move its directory,
   *  and a running container's bind mount is pinned to the old path. */
  async stopTask(ws: string, task: string): Promise<void> {
    for (const info of this.sessionsOf(ws, task))
      if (info.container && info.container.status !== 'stopped') await this.stop(info.id)
  }

  /** Destroy every container of a task — the task is going away. The clones go
   *  with the task directory the caller removes next, so they are not touched
   *  here: outside of deleting the task, a clone always outlives its sessions. */
  async teardownTask(ws: string, task: string): Promise<void> {
    for (const info of this.sessionsOf(ws, task)) await this.release(info.id)
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
      this.autoStopIfIdle(sessionId).catch((e) => console.error('auto-stop failed:', e))
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
    await this.stop(sessionId)
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
      console.warn('[reconcile] docker unavailable — container records left as-is')
      return
    }
    const known = new Set<string>()
    for (const info of this.deps.sessions()) {
      known.add(info.id)
      const c = info.container
      if (!c) continue
      const actual = live.get(info.id)
      if (!actual) {
        // Container gone: keep the session, drop the record it can't use.
        this.deps.patchContainer(info.id, undefined)
        continue
      }
      const running = await dockerRunning(actual)
      if (c.id !== actual || (c.status === 'running') !== running)
        this.deps.patchContainer(info.id, {
          ...c,
          id: actual,
          status: running ? 'running' : 'stopped',
          error: undefined
        })
    }
    for (const [session, containerId] of live) {
      if (known.has(session)) continue
      await dockerRemove(containerId, (line) => console.log('[reconcile]', line))
    }
    this.deps.bus.emit('tree.changed', undefined)
  }
}
