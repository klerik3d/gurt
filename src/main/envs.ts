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

/** Everything env-lifecycle: clone + devcontainer per (task, repo), idle auto-stop. */
export class EnvManager {
  /** In-flight `up` per env, so concurrent starts (Run now + confirm) share one. */
  private ensureInFlight = new Map<string, Promise<EnvState>>()
  /** Envs whose git shims are installed this app run — cleared on stop/delete. */
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
    await store.updateEnv(ref.workspace, ref.task, ref.repo, patch)
    this.deps.bus.emit('env.status', { ref, status: patch.status })
    this.deps.bus.emit('tree.changed', undefined)
  }

  async find(ref: EnvRef): Promise<EnvState | undefined> {
    const task = await store.getTask(ref.workspace, ref.task)
    return task.envs.find((e) => e.repo === ref.repo)
  }

  async status(ref: EnvRef): Promise<EnvStatus> {
    return (await this.find(ref))?.status ?? 'stopped'
  }

  /**
   * Ensure the container is up: create the env record if missing, clone, and
   * `devcontainer up` (reusing a stopped container). Idempotent; agent-agnostic.
   */
  ensureRunning(ref: EnvRef): Promise<EnvState> {
    const key = envKey(ref)
    const running = this.ensureInFlight.get(key)
    if (running) return running
    const p = (async () => {
      await store.ensureEnv(ref.workspace, ref.task, ref.repo)
      let env = await this.find(ref)
      // The persisted `running` status can be stale — e.g. a Docker daemon
      // restart stops the container without gurt noticing. Only trust it if the
      // container is actually up; otherwise fall through to `up`, which restarts
      // the stopped container.
      if (
        env?.status === 'running' &&
        env.remoteWorkspaceFolder &&
        env.containerId &&
        (await dockerRunning(env.containerId))
      )
        return env

      const ws = await store.getWorkspace(ref.workspace)
      const repo = ws.repos.find((r) => r.name === ref.repo)
      if (!repo) throw new Error(`repo "${ref.repo}" is not registered in "${ref.workspace}"`)
      const log = this.logFor(ref)

      await this.setStatus(ref, { status: 'starting', error: undefined })
      try {
        const dir = await ensureClone(ref, repo, log)
        const configArgs = await overrideConfigArgs(ref, repo)
        const up = await devcontainerUp(ref, configArgs, dir, log, canonicalRepoId(repo.url)?.host)
        await this.setStatus(ref, {
          status: 'running',
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
    this.ensureInFlight.set(key, p)
    p.finally(() => this.ensureInFlight.delete(key)).catch(() => {})
    return p
  }

  /**
   * Provision (if needed) the git-access injection for a starting session: ensure
   * the per-env broker is up, the shims are installed, and return the container
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

  /** Ensure env is up, then build the validated launch context for an agent. */
  async resolveEnv(ref: EnvRef, agentId: string, gitAccess: boolean): Promise<EnvContext> {
    const agents = await store.getAgents()
    const cfg = agents[agentId]
    if (!cfg) throw new Error(`unknown agent "${agentId}"`)
    const def = agentDef(cfg.kind)
    if (!def) throw new Error(`agent "${cfg.label}" has unknown kind "${cfg.kind}"`)
    // The secret lives in credentials.json now; the agent only links it (§6).
    const { secret, error: credError } = resolveAgentSecret(await listCredentials(), cfg.credentialId)
    if (credError) throw new Error(`agent "${cfg.label}": ${credError}`)
    const repo = (await store.getWorkspace(ref.workspace)).repos.find((r) => r.name === ref.repo)
    if (!repo) throw new Error(`repo "${ref.repo}" is not registered in "${ref.workspace}"`)

    const env = await this.ensureRunning(ref)
    if (env.status !== 'running' || !env.remoteWorkspaceFolder)
      throw new Error('environment is not running')

    const configArgs = await overrideConfigArgs(ref, repo)
    const hostWorkspaceFolder = cloneDir(ref.workspace, ref.task, ref.repo)
    const gitBrokerEnv = gitAccess
      ? await this.resolveGitAccess(ref, repo, env.containerId)
      : undefined

    return {
      agent: def,
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
    await installAcpAdapter(ref, ctx.agent, ctx.configArgs, ctx.hostWorkspaceFolder, this.logFor(ref))
  }

  async start(ref: EnvRef): Promise<void> {
    await this.ensureRunning(ref)
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

  /** Delete the env infrastructure. Sessions are kept (they re-provision on run). */
  async remove(ref: EnvRef): Promise<void> {
    this.noteActive(ref)
    const env = await this.find(ref)
    const log = this.logFor(ref)
    this.deps.sessions().closeEnv(ref)
    stopGitBroker(ref)
    this.gitShimsInstalled.delete(envKey(ref))
    if (env?.containerId) await dockerRemove(env.containerId, log)
    // Drop the env record even if the clone can't be fully removed, so a filesystem
    // hiccup never leaves a ghost env in the tree pointing at a half-deleted clone.
    try {
      await removeClone(ref)
    } catch (e) {
      log(`clone removal failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    await store.removeEnv(ref.workspace, ref.task, ref.repo)
    this.deps.bus.emit('tree.changed', undefined)
    this.deps.sessions().schedule()
  }

  /** Env half of task deletion: containers, brokers and adapters of every env. */
  async teardownTask(ws: string, task: string): Promise<void> {
    const data = await store.getTask(ws, task)
    for (const env of data.envs) {
      const ref = { workspace: ws, task, repo: env.repo }
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

  /** No session on this env is busy or starting — schedule the idle auto-stop. */
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
