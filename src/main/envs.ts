import type { EnvRef, EnvState, EnvStatus, RepoConfig } from '../shared/types'
import { agentDef } from '../shared/agents'
import { canonicalRepoId } from '../shared/repoId'
import { envKey } from '../shared/keys'
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
  dockerStop,
  ensureClone,
  installAcpAdapter,
  installGitShims,
  overrideConfigArgs,
  removeClone
} from './provision'
import type { Bus } from './bus'
import type { EnvContext, SessionManager } from './sessions'

export interface EnvManagerDeps {
  /** SessionManager, resolved lazily — mutual dependency, wired in kernel.ts. */
  sessions(): SessionManager
  bus: Bus
}

/** Everything env-lifecycle: a clone + devcontainer per session, idle auto-stop. */
export class EnvManager {
  /** In-flight `up` per session, so its concurrent start/attach share one. */
  private ensureInFlight = new Map<string, Promise<EnvState>>()
  /** Instances whose git shims are installed this app run — cleared on stop/delete. */
  private gitShimsInstalled = new Set<string>()
  /** Container is stopped after a session sits idle this long with no new activity. */
  private readonly ENV_IDLE_STOP_MS = 30_000
  private idleTimers = new Map<string, NodeJS.Timeout>()

  constructor(private deps: EnvManagerDeps) {}

  private logFor(ref: EnvRef): (line: string) => void {
    return (line) => this.deps.bus.emit('provision.log', { key: envKey(ref), line })
  }

  /** Persist the env status and announce it (`env.status` + the tree re-render). */
  private async setStatus(ref: EnvRef, patch: Partial<EnvState> & { status: EnvStatus }): Promise<void> {
    await store.updateTaskEnv(ref.workspace, ref.task, ref.session, patch)
    this.deps.bus.emit('env.status', { ref, status: patch.status })
    this.deps.bus.emit('tree.changed', undefined)
  }

  async find(ref: EnvRef): Promise<EnvState | undefined> {
    const task = await store.getTask(ref.workspace, ref.task)
    return task.envs.find((e) => e.session === ref.session)
  }

  async status(ref: EnvRef): Promise<EnvStatus> {
    return (await this.find(ref))?.status ?? 'stopped'
  }

  /**
   * Ensure the session's container is up: clone (if needed) and `devcontainer
   * up` under the session's id-label — creating its container, or restarting
   * its own stopped one. The instance record is keyed by the session, so two
   * sessions on one env definition never touch each other's containers. Who
   * may start here at all is the scheduler's start gate, not this method's
   * concern.
   */
  ensureRunning(ref: EnvRef, repo: string): Promise<EnvState> {
    const inflight = this.ensureInFlight.get(ref.session)
    if (inflight) return inflight
    const p = (async () => {
      await store.ensureTaskEnv(ref.workspace, ref.task, ref.env, ref.session)
      let env = await this.find(ref)
      // The session's own container, still up → just attach. (Probe it — the
      // persisted status can be stale after a Docker daemon restart.)
      if (
        env?.status === 'running' &&
        env.remoteWorkspaceFolder &&
        env.containerId &&
        (await dockerRunning(env.containerId))
      )
        return env

      const ws = await store.getWorkspace(ref.workspace)
      const repoCfg = ws.repos.find((r) => r.name === repo)
      if (!repoCfg) throw new Error(`repo "${repo}" is not registered in "${ref.workspace}"`)
      const envCfg = ws.envs.find((e) => e.name === ref.env)
      const log = this.logFor(ref)

      // A container provisioned for another repo cannot be reused — its clone
      // mount is wrong (the draft was re-pointed after a failed start). Recreate.
      const leftover = env?.containerId && env.repo !== repo ? env.containerId : undefined
      await this.setStatus(ref, {
        status: 'starting',
        error: undefined,
        ...(leftover ? { containerId: undefined, remoteWorkspaceFolder: undefined } : {})
      })
      try {
        if (leftover) await dockerRemove(leftover, log)
        const dir = await ensureClone(ref, repoCfg, log)
        const configArgs = await overrideConfigArgs(ref, envCfg)
        const up = await devcontainerUp(
          ref.session,
          configArgs,
          dir,
          log,
          repoCfg.name,
          canonicalRepoId(repoCfg.url)?.host
        )
        await this.setStatus(ref, {
          status: 'running',
          repo,
          containerId: up.containerId,
          remoteWorkspaceFolder: up.remoteWorkspaceFolder
        })
        log('environment is running')
        env = await this.find(ref)
        return env!
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        await this.setStatus(ref, { status: 'error', error: message })
        log(`error: ${message}`)
        throw e
      }
    })()
    this.ensureInFlight.set(ref.session, p)
    p.finally(() => this.ensureInFlight.delete(ref.session)).catch(() => {})
    return p
  }

  /**
   * Provision (if needed) the git-access injection for a starting session: ensure
   * the session's broker is up, the shims are installed, and return the container
   * injection env (§6). Secrets never appear here — only the broker URL+token.
   */
  private async resolveGitAccess(
    ref: EnvRef,
    repo: RepoConfig,
    containerId: string | undefined
  ): Promise<Record<string, string>> {
    const host = canonicalRepoId(repo.url)?.host ?? null
    const broker = await resolveGitBroker(ref)
    const resolved = host
      ? resolveCredential(await listCredentials(), repo, host)
      : undefined
    if (!this.gitShimsInstalled.has(envKey(ref))) {
      if (!containerId) throw new Error('environment has no container id — cannot install git shims')
      await installGitShims(containerId, host, this.logFor(ref))
      this.gitShimsInstalled.add(envKey(ref))
    }
    // Identity only from a clean resolution — an errored one (e.g. unverified
    // entry, §3.2) injects nothing, and the broker refuses it per request too.
    const identity =
      resolved?.entry && !resolved.error ? credentialIdentity(resolved.entry) : null
    return containerGitEnv(broker.url, host, resolved?.kind ?? 'git-host', identity)
  }

  /** Ensure the session's container is up, then build the validated launch
   *  context for an agent. Throws if the session has no repo or one that is
   *  not registered. */
  async resolveEnv(
    ref: EnvRef,
    repo: string | undefined,
    agentId: string,
    gitAccess: boolean
  ): Promise<EnvContext> {
    const agents = await store.getAgents()
    const cfg = agents[agentId]
    if (!cfg) throw new Error(`unknown agent "${agentId}"`)
    const def = agentDef(cfg.kind)
    if (!def) throw new Error(`agent "${cfg.label}" has unknown kind "${cfg.kind}"`)
    // The secret lives in credentials.json now; the agent only links it (§6).
    const { secret, error: credError } = resolveAgentSecret(await listCredentials(), cfg.credentialId)
    if (credError) throw new Error(`agent "${cfg.label}": ${credError}`)
    if (!repo) throw new Error('session has no repository')
    const workspace = await store.getWorkspace(ref.workspace)
    const repoCfg = workspace.repos.find((r) => r.name === repo)
    if (!repoCfg) throw new Error(`repo "${repo}" is not registered in "${ref.workspace}"`)
    const envCfg = workspace.envs.find((e) => e.name === ref.env)

    const env = await this.ensureRunning(ref, repo)
    if (env.status !== 'running' || !env.remoteWorkspaceFolder)
      throw new Error('environment is not running')

    const configArgs = await overrideConfigArgs(ref, envCfg)
    const hostWorkspaceFolder = cloneDir(ref.workspace, ref.task, repo)
    const gitBrokerEnv = gitAccess
      ? await this.resolveGitAccess(ref, repoCfg, env.containerId)
      : undefined

    return {
      agent: def,
      session: ref.session,
      remoteWorkspaceFolder: env.remoteWorkspaceFolder,
      hostWorkspaceFolder,
      configArgs,
      secret,
      secretEnv: cfg.secretEnv || def.secretEnv,
      env: cfg.env,
      gitBrokerEnv
    }
  }

  /** Install the agent's adapter packages in the container (idempotent). */
  async installAdapter(ref: EnvRef, ctx: EnvContext): Promise<void> {
    await installAcpAdapter(ctx.session, ctx.agent, ctx.configArgs, ctx.hostWorkspaceFolder, this.logFor(ref))
  }

  async stop(ref: EnvRef): Promise<void> {
    this.noteActive(ref)
    const env = await this.find(ref)
    const log = this.logFor(ref)
    this.deps.sessions().closeEnv(ref)
    stopGitBroker(ref)
    this.gitShimsInstalled.delete(envKey(ref))
    if (env?.containerId) await dockerStop(env.containerId, log)
    await this.setStatus(ref, { status: 'stopped' })
    log('environment stopped')
    // A freed repo may release queued sessions.
    this.deps.sessions().schedule()
  }

  /**
   * The owning session was deleted (or its draft re-pointed) — the container
   * and the instance record go with it (they are session-bound; no other
   * session may inherit them). The clone stays: uncommitted work in the
   * working tree outlives the session.
   */
  async release(ref: EnvRef): Promise<void> {
    const env = await this.find(ref)
    if (!env) return
    this.noteActive(ref)
    const log = this.logFor(ref)
    this.deps.sessions().closeEnv(ref)
    stopGitBroker(ref)
    this.gitShimsInstalled.delete(envKey(ref))
    if (env.containerId) await dockerRemove(env.containerId, log)
    await store.removeTaskEnv(ref.workspace, ref.task, ref.session)
    this.deps.bus.emit('tree.changed', undefined)
    log('container removed (owning session released it)')
    this.deps.sessions().schedule()
  }

  /** Delete the env infrastructure. Sessions are kept (they re-provision on run). */
  async remove(ref: EnvRef): Promise<void> {
    this.noteActive(ref)
    const env = await this.find(ref)
    const log = this.logFor(ref)
    this.deps.sessions().closeEnv(ref)
    stopGitBroker(ref)
    this.gitShimsInstalled.delete(envKey(ref))
    if (env?.containerId) await dockerRemove(env.containerId, log)
    // The clone is keyed by repo name and shared across the task's sessions;
    // only remove it when no other instance record and no other session still
    // uses that repo. Drop the instance record regardless, so a filesystem
    // hiccup never leaves a ghost env.
    if (env?.repo) {
      const task = await store.getTask(ref.workspace, ref.task)
      const shared =
        task.envs.some((e) => e.session !== ref.session && e.repo === env.repo) ||
        this.deps
          .sessions()
          .listForTask(ref.workspace, ref.task)
          .some((s) => s.id !== ref.session && s.repo === env.repo)
      if (!shared) {
        try {
          await removeClone(ref.workspace, ref.task, env.repo)
        } catch (e) {
          log(`clone removal failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
    await store.removeTaskEnv(ref.workspace, ref.task, ref.session)
    this.deps.bus.emit('tree.changed', undefined)
    this.deps.sessions().schedule()
  }

  /** Env half of task deletion: containers, brokers and adapters of every instance. */
  async teardownTask(ws: string, task: string): Promise<void> {
    const data = await store.getTask(ws, task)
    for (const env of data.envs) {
      const ref = { workspace: ws, task, env: env.env, session: env.session }
      this.noteActive(ref)
      this.deps.sessions().closeEnv(ref)
      stopGitBroker(ref)
      this.gitShimsInstalled.delete(envKey(ref))
      if (env.containerId) await dockerRemove(env.containerId, () => {})
    }
  }

  /** A session started work (or the user is typing) — cancel any pending auto-stop. */
  noteActive(ref: EnvRef): void {
    const key = envKey(ref)
    const timer = this.idleTimers.get(key)
    if (!timer) return
    clearTimeout(timer)
    this.idleTimers.delete(key)
  }

  /** The owning session is not busy or starting — schedule the idle auto-stop. */
  noteIdle(ref: EnvRef): void {
    const key = envKey(ref)
    this.noteActive(ref)
    this.idleTimers.set(
      key,
      setTimeout(() => {
        this.idleTimers.delete(key)
        this.autoStopIfIdle(ref).catch((e) => console.error('auto-stop failed:', e))
      }, this.ENV_IDLE_STOP_MS)
    )
  }

  /**
   * Re-verify the env is still idle *and* running before stopping. Guards against a
   * session resuming in the window after the timer fired, and against clobbering a
   * non-running status (e.g. `error` from a failed start) with `stopped`.
   */
  private async autoStopIfIdle(ref: EnvRef): Promise<void> {
    if (!this.deps.sessions().isEnvIdle(ref)) return
    if ((await this.status(ref)) !== 'running') return
    if (!this.deps.sessions().isEnvIdle(ref)) return
    await this.stop(ref)
  }
}
