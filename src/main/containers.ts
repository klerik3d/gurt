// Container lifecycle. One container per session, strictly: created at the
// session's first start, stopped when it goes idle, destroyed with it. Nothing
// here is keyed by env — an env is a *definition* (which devcontainer.json to
// build), and several sessions of a task may run the same one while owning
// separate containers.
//
// The state this manager derives — the installed ACP adapter, and whatever else
// lives in a container's filesystem — is keyed by container id, never by session
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
  materializeEnvConfig,
  overrideConfigArgs,
  sessionConfigPath,
  linkContainerSkills,
  SKILLS_MOUNT
} from './provision'
import type { Bus } from './bus'
import { createLogger, errCtx } from './log'
import { proxies, type ProxyRuntime } from './proxy/manager'
import {
  DEFAULT_BRIDGE,
  assertContainerNetworks,
  convergeContainerNetworks,
  sessionNetworkName
} from './proxy/network'
import { proxyEnv, type ProxyConfig } from '../shared/proxy'

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

/** Whether this session's container carries the skills bind — i.e. whether it
 *  picked any skill at all (docs/requirements-skills.md §5). */
function usesSkillMounts(info: SessionInfo): boolean {
  return !!info.skills?.length
}

/**
 * The `--override-config` pair every `up` and every `exec` of this session must
 * resolve — they have to agree, since the config decides the exec cwd and the
 * reported `remoteWorkspaceFolder`. It is the session's own merged copy
 * whenever gurt added mounts of its own (sibling repos, the skills bind, or
 * both), and the env's shared materialized file otherwise. The file behind it
 * was written by `ensure`'s `up` and persists across app restarts, so the
 * reattach path needs nothing.
 */
function sessionConfigArgs(info: SessionInfo, sessionId: string): string[] {
  return usesRepoMounts(info) || usesSkillMounts(info)
    ? [
        '--override-config',
        sessionConfigPath(store.sessionScratchDir(info.workspace, info.task, sessionId))
      ]
    : overrideConfigArgs({ workspace: info.workspace, task: info.task, env: info.env })
}

/**
 * What the adapter install needs to address one container — the half of
 * {@link LaunchContext} that exists *before* the session's network is switched,
 * because the install itself needs the open network (§7.1 step 3).
 */
export interface AdapterTarget {
  agent: AgentDef
  /** Owning session — also the container's identity (`gurt.session` id-label). */
  session: string
  /** The container the adapter runs in; the key of every container-bound cache. */
  containerId: string
  hostWorkspaceFolder: string
  configArgs: string[]
}

/** Everything needed to (re)spawn the agent process for a session. */
export interface LaunchContext extends AdapterTarget {
  remoteWorkspaceFolder: string
  secret: string
  secretEnv: string
  /** Extra env vars for the adapter (e.g. a local model's base URL). */
  env?: Record<string, string>
  /** The container's git injection: GIT_CONFIG_* commit identity only (§10.3).
   *  No credentials — the container authenticates to nothing. */
  gitIdentityEnv?: Record<string, string>
  /**
   * The session's proxy — its token (a handle to the scope, never a secret in
   * itself), the URL the container reaches it on, and the `HTTP_PROXY` family
   * to launch the agent with (docs/requirements-mcp-proxy.md §4.5).
   *
   * The scope behind the token is pushed by the session manager, from the same
   * pass that builds the agent's MCP descriptors, *before* the adapter spawns.
   */
  proxy: ProxyRuntime & { env: Record<string, string> }
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
  // Keyed by container id, describing something living in that container's
  // filesystem. A container id is minted by Docker and never reused, so this
  // cannot address a container that has been replaced — and `forget` drops the
  // entry when one is destroyed, so it does not grow without bound either.
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

    // Containers carrying this session's id-label that its record cannot name.
    // `up` stamps the label at `docker run` but the id only reaches the record
    // once `up` returns, so a start that died in between — the app quit, the
    // machine slept, Docker restarted — leaves one behind, possibly stopped
    // part-way through its create-time hooks. The next `up` would find it by
    // that label and adopt it, skipping every hook as already run (see
    // CREATE_HOOK_RE in provision.ts); the session would then come up against a
    // workspace those hooks never finished preparing. Nothing may adopt them.
    const recorded = owned?.id
    const labeled = (await dockerSessionContainerIds(sessionId)) ?? []
    for (const id of labeled) {
      // Prefix, not equality — `docker ps` and the CLI disagree on short vs.
      // full ids, the same way `teardown` has to allow for.
      if (recorded && (id.startsWith(recorded) || recorded.startsWith(id))) continue
      provisionLog(`removing container ${id.slice(0, 12)} left by an unfinished start`)
      this.forget(id)
      await dockerRemove(id, provisionLog)
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
      // Config and clone dir stay paired, so the anchor below is one lookup,
      // not two parallel arrays indexed in step.
      const clones = await Promise.all(
        repoCfgs.map(async (cfg) => ({
          cfg,
          dir: await ensureClone(this.refOf(info), cfg, provisionLog)
        }))
      )
      // repos[0] is the build anchor, same role a normal session's only repo
      // plays today — every other repo (if any) is a sibling mount only. A
      // session with no repo never reaches provisioning (the start gate rejects
      // it), so this is a guard on that invariant, not a path.
      const [anchor] = clones
      if (!anchor) throw new Error('session has no repository')
      enter('image')
      const configArgs = await materializeEnvConfig(
        this.refOf(info),
        envCfg,
        anchor.cfg,
        anchor.dir,
        provisionLog
      )
      enter('up')
      // Step 1 of the provisioning sequence (§7.1): whatever this container is
      // attached to, `up` runs on the open network. The image build, the
      // devcontainer features and every create-time hook need unrestricted
      // egress, and in internal mode the session's own network has none — so a
      // reused container is moved back to the default bridge *before* the CLI
      // starts it, and moved onto the session network again once it is done
      // (`convergeNetworks` below). A fresh container is born on the bridge
      // anyway, which is why this only has work to do on a reused one.
      if (owned?.id) await this.convergeNetworks(sessionId, owned.id, [DEFAULT_BRIDGE])
      const mounted = usesRepoMounts(info)
      // Stopgap (2026-08-24, see requirements-session-roles.md §2/§4): a
      // reviewer needs a writable clone to install dependencies and run
      // typecheck/tests against the diff it is judging, so only researcher
      // keeps the filesystem-level read-only bind. Everything else about a
      // read-only role (no `complete`, mount still routed through the wrapper
      // below) is unchanged — `roleIsReadOnly` still governs those, just not
      // this flag.
      const readonly = sessionRole(info) === 'researcher'
      // Read-write single repo (an executor): unchanged — `--workspace-folder`
      // IS the clone, exactly as before. Otherwise `--workspace-folder` is an
      // empty wrapper dir and every repo (anchor included) is mounted into it
      // explicitly, so none of them sits at the container's top-level workspace
      // folder and each carries its own read-only flag.
      let workspaceFolder = anchor.dir
      let extraMounts: { hostDir: string; name: string; readonly?: boolean }[] = []
      if (mounted) {
        workspaceFolder = store.mountedWorkspaceDir(info.workspace, info.task, sessionId)
        await fs.mkdir(workspaceFolder, { recursive: true })
        extraMounts = clones.map(({ cfg, dir }) => ({ hostDir: dir, name: cfg.name, readonly }))
      }
      // The skills the session picked, staged into its scratch dir by
      // `materializeSkills` just before this call, bound read-only at a fixed
      // path (docs/requirements-skills.md §5). Added only when the session
      // selected something, so a session with no skills provisions exactly as
      // it did before this feature existed — and a draft that changes its
      // selection releases its container, since the mount list is fixed at
      // create time (§5.2).
      const hostMounts = usesSkillMounts(info)
        ? [
            {
              hostDir: store.sessionSkillsDir(info.workspace, info.task, sessionId),
              target: SKILLS_MOUNT,
              readonly: true
            }
          ]
        : []
      const up = await devcontainerUp(
        sessionId,
        configArgs,
        workspaceFolder,
        provisionLog,
        mounted ? 'repos' : anchor.cfg.name,
        () =>
          this.setStatus(
            sessionId,
            { repos: info.repos, ...(this.container(sessionId) ?? {}), status: 'post' },
            'user'
          ),
        extraMounts,
        hostMounts,
        store.sessionScratchDir(info.workspace, info.task, sessionId)
      )
      // After `up`, before anything reports the container usable: the agent
      // resolves its skills at startup, and the adapter is spawned from
      // `launchContext` below.
      if (hostMounts.length)
        await linkContainerSkills(sessionId, sessionConfigArgs(info, sessionId), workspaceFolder, provisionLog)
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
   * Move one container's endpoints to `desired`, logging what actually changed.
   *
   * The log line is an obligation, not decoration (§7.3): everything before the
   * switch ran with unrestricted egress, and a reader of the provisioning log
   * has to be able to see exactly where that window closed.
   */
  private async convergeNetworks(
    sessionId: string,
    containerId: string,
    desired: string[]
  ): Promise<void> {
    const provisionLog = this.logFor(sessionId)
    // Throws on a docker call that failed — including the inspect this plans
    // against, which must never read as "nothing to do" (§7.2). Only "the
    // daemon says there is no such container" is a null, and that is a no-op
    // here for the same reason `reconcile` merely drops the record: a container
    // that is gone is not one this can move.
    const plan = await convergeContainerNetworks(containerId, desired, provisionLog)
    if (!plan) {
      provisionLog(
        `network: container ${containerId.slice(0, 12)} no longer exists, nothing to switch`
      )
      return
    }
    if (!plan.connect.length && !plan.disconnect.length) return
    provisionLog(
      `network: ${containerId.slice(0, 12)} switched to ${desired.join(', ')}` +
        (plan.disconnect.length ? ` (left ${plan.disconnect.join(', ')})` : '')
    )
    log.info('network.converge', {
      s: sessionId,
      c: containerId.slice(0, 12),
      connect: plan.connect,
      disconnect: plan.disconnect
    })
  }

  /**
   * Steps 4 and 5 of the provisioning sequence (§7.1), run after `up` and the
   * adapter install and before the agent exists: the session's network and its
   * proxy are ensured, then the container is switched onto that network.
   *
   * Both halves are converges, so this is also the *resume* path: a container
   * that is already where it belongs costs two `docker inspect`s, and one left
   * half-attached by a crash is corrected rather than compounded.
   *
   * No restart is involved. The daemon rewires a live container's interfaces,
   * rewrites its `/etc/hosts` and points it at the embedded resolver; sockets
   * open across the switch die, and nothing of the agent's exists yet — which is
   * the whole reason this happens here and not later.
   *
   * In internal mode the switch is re-checked against the daemon before this
   * returns. Every caller of this is one step away from launching an agent, and
   * an agent launched into a container still on the default bridge has the
   * unrestricted egress the session was created to deny — so the last thing
   * that happens here is asking whether the switch actually took.
   */
  private async ensureProxy(info: SessionInfo, containerId: string): Promise<ProxyRuntime> {
    const provisionLog = this.logFor(info.id)
    const settings = info.network ?? {}
    const network = sessionNetworkName(info.id)
    const runtime = await proxies.ensure(info.id, settings, provisionLog)
    await this.convergeNetworks(info.id, containerId, [network])
    if (settings.internal) {
      await this.assertIsolated(info.id, containerId, network)
      provisionLog(
        'network: this session is internal — from here the proxy is its only ' +
          'route out; everything above ran with unrestricted egress (setup needs it)'
      )
    }
    return runtime
  }

  /**
   * The post-condition of step 5 for an internal session: the container is on
   * the session network and on nothing else.
   *
   * Cheap (one inspect) and worth it out of all proportion to that cost. This
   * failure mode is silent by nature — a container left on the default bridge
   * looks exactly like a working one, right up until the agent exfiltrates
   * something — so it is turned into the loudest thing provisioning has: the
   * start fails, before the agent exists.
   */
  private async assertIsolated(
    sessionId: string,
    containerId: string,
    network: string
  ): Promise<void> {
    const provisionLog = this.logFor(sessionId)
    try {
      await assertContainerNetworks(containerId, [network])
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      log.error('network.isolation.fail', { s: sessionId, c: containerId.slice(0, 12), err: e })
      provisionLog(`network: refusing to start — isolation not confirmed (${message})`)
      throw new Error(
        `this session is internal but its network isolation could not be confirmed: ${message}`,
        { cause: e }
      )
    }
  }

  /**
   * The container's whole git injection: commit identity, and nothing else
   * (§10.3). The container authenticates to nothing — authenticated git is
   * exclusively the host-side github MCP — so there is no broker to start, no
   * shim to install and no secret in here.
   *
   * Identity comes only from a clean resolution: an errored one (e.g. an
   * unverified entry, §3.2) injects nothing, and a commit made without it is
   * authored by whatever the image contains, which is the honest outcome when
   * gurt cannot say whose credential this repo uses.
   */
  private async resolveGitIdentity(repo: RepoConfig): Promise<Record<string, string>> {
    const host = canonicalRepoId(repo.url)?.host ?? null
    const resolved = host ? resolveCredential(await listCredentials(), repo, host) : undefined
    const identity = resolved?.entry && !resolved.error ? credentialIdentity(resolved.entry) : null
    return containerGitEnv(identity)
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
    const [anchorRepo] = info.repos
    if (!anchorRepo) throw new Error('session has no repository')
    const ws = await store.getWorkspace(info.workspace)
    const repoCfg = ws.repos.find((r) => r.name === anchorRepo)
    if (!repoCfg) throw new Error(`repo "${anchorRepo}" is not registered in "${info.workspace}"`)

    const c = await this.ensure(sessionId)
    if (c.status !== 'running' || !c.id || !c.remoteWorkspaceFolder)
      throw new Error('container is not running')

    const mounted = usesRepoMounts(info)
    // Must match whatever `ensureUncoalesced` passed as `--workspace-folder`
    // for this same session — the wrapper dir whenever the repos are mounted
    // explicitly, the plain clone dir otherwise.
    const hostWorkspaceFolder = mounted
      ? store.mountedWorkspaceDir(info.workspace, info.task, sessionId)
      : cloneDir(info.workspace, info.task, anchorRepo)
    const target: AdapterTarget = {
      agent: def,
      session: sessionId,
      containerId: c.id,
      hostWorkspaceFolder,
      configArgs: sessionConfigArgs(info, sessionId)
    }
    // Step 3 of the provisioning sequence (§7.1), and the reason it is here
    // rather than in the connection path: `npm install -g` needs the open
    // network, and step 5 below is what takes it away in internal mode. The
    // connection path calls this again and hits the per-container cache.
    await this.installAdapter(target)
    const proxy = await this.ensureProxy(info, c.id)
    return {
      ...target,
      remoteWorkspaceFolder: c.remoteWorkspaceFolder,
      secret,
      secretEnv: cfg.secretEnv || def.secretEnv,
      ...(cfg.env ? { env: cfg.env } : {}),
      proxy: { ...proxy, env: proxyEnv(proxy.base) },
      // Identity is injected unconditionally — it carries no authority, and a
      // local commit an agent does make should still be attributed. Anchored on
      // the session's first repo: with several, that is the one the identity is
      // resolved from, and they normally share a forge account anyway.
      gitIdentityEnv: await this.resolveGitIdentity(repoCfg)
    }
  }

  /** Install the agent's adapter packages in the session's container, once per
   *  container. Idempotent: a stop/start keeps the same container (and its
   *  filesystem), a replacement gets a new id and so reinstalls. The in-memory
   *  set only fast-paths that answer within one app process — a fresh process
   *  probes the container itself before reinstalling into it. */
  installAdapter(ctx: AdapterTarget): Promise<void> {
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

  /**
   * Hand the session's proxy the scope its token names — the MCP routes, the
   * resolved credentials, the egress policy.
   *
   * Called by the session manager, which is where the selection and the host
   * listeners are known, and always before the agent is spawned: until this
   * lands the proxy has no scope at all and answers every MCP call with 503.
   * Every later change (an MCP toggled, the policy edited) is another call.
   */
  pushProxyScope(sessionId: string, config: ProxyConfig): Promise<void> {
    return proxies.pushScope(sessionId, config)
  }

  // --- teardown -----------------------------------------------------------

  /** Drop every host-side record derived from a container that is going away. */
  private forget(containerId: string): void {
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
    // A start already in flight is creating a container that neither the record
    // nor the daemon can name yet. Let it settle first — it either records its
    // container (which the sweep below then finds) or fails having left one
    // behind (which the sweep finds too). Stop does not wait: it is the idle
    // path, and a session that is starting is by definition not idle.
    // The record is read before the first await: `deleteSession` starts this
    // teardown and drops the session record synchronously right after, so a
    // later read finds nothing and the recorded-id fallback below goes blind.
    let c = this.container(sessionId)
    if (mode === 'remove') {
      await this.ensureInFlight.get(sessionId)?.catch(() => {})
      // A start that settled while we waited may have recorded a fresher id.
      c = this.container(sessionId) ?? c
    }
    if (mode === 'stop') {
      const provisionLog = this.logFor(sessionId)
      // The scope is revoked and the proxy stopped whether or not the record
      // names a container: a start that died after `docker run` and before `up`
      // returned leaves a proxy findable only by its label. The session network
      // is kept — endpoints survive a stop, so the resume converges onto the
      // same one instead of rebuilding it (§9).
      await proxies.stop(sessionId, provisionLog)
      if (!c?.id) return
      this.forget(c.id)
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
    // After the containers, so the network's last endpoints are already gone —
    // a network with live ones refuses to be removed (§9). Record-independent
    // like the sweep above: both the proxy and the network are found by label.
    await proxies.remove(sessionId, provisionLog)
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
      this.autoStopIfIdle(sessionId).catch((e: unknown) =>
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
    // The mirror of the "docker unavailable" guard above. An empty session set
    // is evidence of "no sessions" only when the store actually managed to read
    // them: a file that failed to parse — or a 0-byte one left by a crash
    // mid-write — deserializes to nothing just the same, and reaping on that
    // deletes containers whose sessions still exist, agent history included.
    const mayReap = !store.storeDegraded() && !(known.size === 0 && live.size > 0)
    if (!mayReap)
      log.warn('reconcile: orphan sweep skipped — session index empty or degraded', {
        known: known.size,
        live: live.size
      })
    let sweepResult: Awaited<ReturnType<typeof proxies.sweepOrphans>> = { proxies: 0, networks: 0 }
    if (mayReap) {
      for (const [session, containerId] of live) {
        if (known.has(session)) continue
        orphans++
        // (the proxy and network of the same session are swept below, by label)
        // Not `this.logFor(session)`: that would create a `session-<id>.log` for
        // a session that no longer exists — a file nothing would ever delete. The
        // removal is traced by `proc.spawn`/`proc.exit` anyway; the docker output
        // itself goes to the app log at DBG.
        await dockerRemove(containerId, (line) => log.debug('reconcile.orphan', { c: containerId, line }))
      }
      // Proxies and session networks are their own namespaces, swept the same
      // way and for the same reason: a session that was deleted while the app was
      // down leaves both behind, and only the daemon knows they exist.
      sweepResult = await proxies.sweepOrphans(known, (line) => log.debug('reconcile.orphan', { line }))
    }
    log.info('reconcile.done', { fixed, orphans, swept: mayReap, ...sweepResult })
    this.deps.bus.emit('tree.changed', undefined)
  }
}
