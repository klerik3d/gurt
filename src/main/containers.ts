import { clientConfigFile } from '../shared/clientConfig'
// Container lifecycle. One container per session, strictly: created at the
// session's first start, stopped when it goes idle, destroyed with it. Nothing
// here is keyed by env — an env is a *definition* (which image or Dockerfile to
// run), and several sessions of a task may run the same one while owning
// separate containers.
//
// The state this manager derives — the installed ACP adapter, and whatever else
// lives in a container's filesystem — is keyed by container id, never by session
// or env name. A container id is minted by `docker` and never reused, so a
// record keyed by it cannot survive the thing it describes. That is what makes
// stale-cache reuse unrepresentable rather than merely avoided.
import {
  anchorRepo,
  missingRepoReason,
  repoMode,
  repoModeIsReadOnly,
  sessionRole,
  type EnvRef,
  type RepoConfig,
  type SessionContainer,
  type SessionInfo
} from '../shared/types'
import type { ContainerStatusReason } from '../shared/events'
import type { AgentManifest } from '../shared/agentPlugin'
import { agentDef } from '../shared/agents'
import { validateEnvConfig } from '../shared/envConfig'
import { agentMain } from './agentPlugins'
import { canonicalRepoId } from '../shared/repoId'
import { resolveCredential, resolveAgentSecret, credentialIdentity } from '../shared/credentials'
import { listCredentials } from './credentials'
import { resolveOAuthAccess } from './oauth'
import { oauthAuthFile } from './oauth/materialize'
import { containerGitEnv } from './git/config'
import * as store from './store'
import {
  containerTerminalCommand,
  assertDockerCli,
  assertDockerDaemon,
  createContainer,
  dockerContainerExists,
  dockerRemove,
  dockerInspectRunning,
  dockerRunning,
  dockerSessionContainerIds,
  dockerSessionContainersDetailed,
  dockerStop,
  ensureClone,
  prepareEnvImage,
  restartContainer,
  spawnDockerExec,
  prepareContainer,
  AdapterMissingError,
  forgetReadyVolume,
  ensureAdaptersVolume,
  prepareReplacementVolumes,
  adaptersVolumeKey,
  adaptersKeyOfVolume,
  timedPhase,
  linkContainerHistory,
  writeContainerUserFile,
  SKILLS_MOUNT,
  HISTORY_MOUNT,
  type ContainerMount,
  type ExecTarget
} from './provision'
import { bundledEnv } from './baseEnv'
import { openCommandInTerminal } from './terminal'
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
import { ARTIFACTS, CONTAINER_ROOT } from '../shared/files'

const log = createLogger('containers')

/** Order-sensitive: a reorder changes which repo is the build anchor, so it
 *  counts as a real change (forces a rebuild) same as adding/removing one. */
function sameRepos(a: string[] | undefined, b: string[]): boolean {
  return !!a && a.length === b.length && a.every((r, i) => r === b[i])
}

/** Whether this session's container carries the skills bind: it picked a skill
 *  at all, *and* its agent kind reads a skills directory (`AgentManifest.skillsDir`,
 *  resolved by the caller — docs/requirements-skills.md §5). A `null` dir means
 *  the pinned CLI never looks: mounting files it cannot see would let the UI
 *  claim a delivery that does not happen, so such a session provisions exactly
 *  as it would with no selection. Exported for the selection tests. */
export function usesSkillMounts(info: SessionInfo, skillsDir: string | null): boolean {
  return !!info.skills?.length && skillsDir !== null
}

/** Whether this session's container carries the history bind: unconditional
 *  on the agent kind alone — unlike skills, there is no selection to be
 *  empty. A kind with no verified `historyPaths` (every kind but claude-code,
 *  as of phase 1) adds no mount, same as an unresolved agent
 *  (docs/requirements-agent-history.md §4 step 1). Exported for the mount
 *  test. */
export function usesHistoryMounts(historyPaths: readonly string[]): boolean {
  return historyPaths.length > 0
}

/**
 * The `hostMounts` entry the history bind adds, or none. Always **one**
 * entry regardless of how many paths `historyPaths` names — every entry is a
 * link inside the same bind, not a mount of its own
 * (docs/requirements-agent-history.md §3.1) — and always read-write, the
 * opposite of the skills bind. A pure function of the path list so the
 * mount-list contract is testable without a container
 * (`scripts/session-history-mount.test.mjs`).
 */
export function historyHostMounts(
  ws: string,
  task: string,
  sessionId: string,
  historyPaths: readonly string[]
): { hostDir: string; target: string; readonly?: boolean }[] {
  return usesHistoryMounts(historyPaths)
    ? [{ hostDir: store.sessionHistoryDir(ws, task, sessionId), target: HISTORY_MOUNT, readonly: false }]
    : []
}

/**
 * The container-side layout of a session (§3.3) — a pure function of the
 * session shape, so the contract is testable without a container.
 *
 * - every repo → `/workspaces/<name>`, read-only unless its mode is `write`
 *   (docs/requirements-repo-mounts.md §2.3), whether the session has one repo
 *   or several, so file paths never depend on the count; the workdir is that
 *   repo's directory when there is exactly one, else `/workspaces`. A repo-less
 *   session (an operator, say) has no repo mounts and works in `/workspaces`;
 * - `extra` binds (skills, history) land at their own absolute targets.
 */
export function containerLayout(
  info: SessionInfo,
  clones: { name: string; dir: string }[],
  extra: { hostDir: string; target: string; readonly?: boolean }[] = []
): { mounts: ContainerMount[]; workdir: string } {
  const bind = (source: string, target: string, ro?: boolean): ContainerMount => ({
    type: 'bind',
    source,
    target,
    ...(ro ? { readonly: true } : {})
  })
  // Judged on the clones actually handed over, not on the record's list.
  const missing = clones.length ? undefined : missingRepoReason({ ...info, repos: [] })
  if (missing) throw new Error(missing)
  const mounts = clones.map((c) =>
    bind(c.dir, `${CONTAINER_ROOT}/${c.name}`, repoModeIsReadOnly(repoMode(info, c.name)))
  )
  const [only] = clones
  const workdir = clones.length === 1 && only ? `${CONTAINER_ROOT}/${only.name}` : CONTAINER_ROOT
  for (const m of extra) mounts.push(bind(m.hostDir, m.target, m.readonly))
  return { mounts, workdir }
}

/**
 * What the container check needs to address one container — the half of
 * {@link LaunchContext} that exists *before* the session's network is switched
 * (§7.1 step 3).
 */
export interface AdapterTarget {
  agent: AgentManifest
  /** Owning session — also the container's identity (`gurt.session` label). */
  session: string
  /** The container the adapter runs in; the key of every container-bound cache. */
  containerId: string
  /** Where and as whom every exec into that container runs (§3.5). */
  exec: ExecTarget
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
  /** What `ensureUncoalesced` owes a container it just brought up (fresh or
   *  resumed), keyed by container id — consumed by `prepareContainer`, the one
   *  `docker exec` that links the skills (`skillsDir`, null when the session
   *  mounted none) and checks the node runtime and the adapter bin. Cleared by
   *  `forget`, so a container that never reaches `resolveLaunch` (removed
   *  mid-start, teardown) cannot leak an entry here. */
  private pendingPrepare = new Map<string, { skillsDir: string | null }>()
  /** In-flight preparation per container id: concurrent launches share one. */
  private prepInFlight = new Map<string, Promise<void>>()
  /** Container is stopped after its session sits idle this long. */
  private readonly IDLE_STOP_MS = 10 * 60_000
  private idleTimers = new Map<string, NodeJS.Timeout>()

  constructor(private deps: ContainerManagerDeps) {}

  private logFor(sessionId: string): (line: string) => void {
    return (line) => this.deps.bus.emit('provision.log', { key: sessionId, line })
  }

  /** Times a provisioning step and logs its duration in the same structured
   *  style as `ensureUncoalesced`'s clone/image/up phases — "which step is
   *  slow" is the first question a slow warm start raises. */
  private timed<T>(sessionId: string, phase: string, fn: () => Promise<T>): Promise<T> {
    return timedPhase(sessionId, phase, fn)
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
   * Spawn `argv` in the session's container as the container user, in `cwd`
   * (default: the record's), with no tty and no stdin — the check runner
   * (reviewCheck.ts). The target is read from the
   * record per call: the container may have been recreated since the caller was
   * built. Throws when there is no container to exec into (setup never
   * succeeded); the caller maps that to "cannot run".
   *
   * It carries the proxy variables the agent is launched with
   * (`connection.ts`, §4.5): on an internal session network the proxy is
   * the only way out, so a check without them could not reach a registry at
   * all. A command the agent ran fine (`npm ci`, `uv run`, `cargo test`,
   * `go test`, which fetch on their own) would then fail in the check with
   * "dependency not found".
   */
  spawnExec(sessionId: string, argv: string[], cwd?: string): ReturnType<typeof spawnDockerExec> {
    const c = this.container(sessionId)
    const t = c && this.execTarget(c)
    if (!t) throw new Error('the session has no container to run in')
    return spawnDockerExec(cwd ? { ...t, cwd } : t, argv, proxyEnv(), { interactive: false })
  }

  /**
   * Whether the session's container runs *now*, asked of the daemon, not read
   * from the record: the confirmation after a check's container was stopped
   * (§5.3). `false` only after the daemon confirms none running; `null` when the
   * daemon could not answer.
   */
  async isRunning(sessionId: string): Promise<boolean | null> {
    const id = this.container(sessionId)?.id
    if (id) return dockerInspectRunning(id)
    // Review §5.3/§5.6: deletion of the record is not proof of termination.
    const ids = await dockerSessionContainerIds(sessionId)
    if (ids === null) return null
    const running = await Promise.all(ids.map(dockerInspectRunning))
    return running.includes(true) ? true : running.includes(null) ? null : false
  }

  /** Open a human shell in the running container, without starting an agent. */
  openTerminal(sessionId: string): Promise<void> {
    const info = this.deps.session(sessionId)
    const t = info?.container && this.execTarget(info.container)
    if (!t || info?.container?.status !== 'running') throw new Error('container is not running')
    const { cmd, args } = containerTerminalCommand(t)
    return openCommandInTerminal(cmd, args)
  }

  /** Where and as whom an exec into this session's container runs — the
   *  record's own facts, nothing resolved from the host. null until the
   *  container's setup has succeeded (`id`/`remoteWorkspaceFolder` unset). */
  private execTarget(c: SessionContainer): ExecTarget | null {
    if (!c.id || !c.remoteWorkspaceFolder) return null
    return {
      containerId: c.id,
      user: c.user ?? 'root',
      cwd: c.remoteWorkspaceFolder,
      ...(c.path ? { path: c.path } : {})
    }
  }

  /**
   * Ensure this session's container is up: clone (if needed) and create the
   * session's container, or restart the one it already owns. Who may start at all is the scheduler's gate, not this.
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
    // The guard the doc calls "the anchor guard": the roles that need a repo
    // (docs/requirements-repo-mounts.md §4) cannot build without one.
    const missing = missingRepoReason(info)
    if (missing) throw new Error(missing)
    // Before anything else: no docker, no container, and every probe below
    // would report its absence as "the daemon says no" (they swallow spawn
    // errors on purpose) until some later `run` failed with a raw ENOENT.
    // Two halves, two sentences: the binary missing and its daemon not
    // answering are different problems with different fixes, and the second
    // is the one that is true on a machine where Docker Desktop is merely
    // not started (docs/requirements-first-run.md §4.2).
    assertDockerCli()
    await assertDockerDaemon()
    const provisionLog = this.logFor(sessionId)

    // The session's agent kind, resolved now: its adapters volume is part of
    // the container's mount list (fixed at create time), so a container
    // without the *current* volume is not one this start may reuse.
    const agentId = info.agent || (await store.getWorkspace(info.workspace)).defaultAgent
    const kind = agentId ? (await store.getAgents())[agentId]?.kind : undefined
    const agent = kind ? agentDef(kind) : undefined
    const wantAdapters = agent ? adaptersVolumeKey(agent) : undefined
    const adaptersCurrent = (c: SessionContainer): boolean =>
      wantAdapters === undefined || adaptersKeyOfVolume(c.adapters) === wantAdapters

    // Its own container, still up → just reuse it. (Probe the daemon: a Docker
    // restart leaves a persisted `running` record describing an exited container.)
    // `path` is part of the record's usable shape: the exec PATH is probed once
    // per container and every exec carries it.
    const owned = info.container
    if (
      owned?.status === 'running' &&
      owned.id &&
      owned.remoteWorkspaceFolder &&
      owned.path &&
      sameRepos(owned.repos, info.repos) &&
      adaptersCurrent(owned) &&
      (await dockerRunning(owned.id))
    )
      return owned

    const ws = await store.getWorkspace(info.workspace)
    const repoCfgs = info.repos.map((name) => {
      const cfg = ws.repos.find((r) => r.name === name)
      if (!cfg) throw new Error(`repo "${name}" is not registered in "${info.workspace}"`)
      return cfg
    })
    // The base env shares the env name space (its name is reserved against
    // workspace envs), so it resolves by name exactly where a workspace env
    // would — no role check: any role may run on the base image.
    const envCfg = ws.envs.find((e) => e.name === info.env) ?? (await bundledEnv(info.env))
    if (!envCfg) throw new Error(`env "${info.env}" is not registered in "${info.workspace}"`)
    const invalid = validateEnvConfig(envCfg)
    if (invalid) throw new Error(`env "${envCfg.name}": ${invalid}`)

    // A container this session owns but can no longer use — it was built for a
    // different repo set. A stopped one on the same repo set is restarted in
    // place, so only a repo change forces a rebuild.
    // The same goes for one whose adapters volume is not the current one: a
    // container from before the volume existed, or from before a pin bump. A
    // mount cannot be added to or swapped in a live container, so it is
    // re-created — what the old in-container `npm install -g` redid in place.
    const adaptersStale = !!owned?.id && !adaptersCurrent(owned)
    // An outdated container on the same repos is removed only once its
    // replacement's image and volumes are ready (below, `retire`): a pull,
    // build or first-use npm failure must leave the session as it was.
    const retireLater = adaptersStale && !!owned?.id && sameRepos(owned.repos, info.repos) ? owned.id : undefined
    if (owned?.id && !retireLater && ((owned.repos.length && !sameRepos(owned.repos, info.repos)) || adaptersStale)) {
      this.deps.detach(sessionId)
      this.forget(owned.id)
      await dockerRemove(owned.id, provisionLog)
    }

    // Containers carrying this session's label that its record cannot name.
    // `create` stamps the label but the id only reaches the record once `setup`
    // succeeded, so a start that died in between — the app quit, the machine
    // slept, Docker restarted — leaves one behind, possibly stopped part-way
    // through the setup script. Nothing may adopt it: the session would come up
    // against a workspace the script never finished preparing.
    const recorded = owned?.id
    const labeled = (await dockerSessionContainerIds(sessionId)) ?? []
    for (const id of labeled) {
      // Prefix, not equality — `docker ps` and `docker create` disagree on
      // short vs. full ids, the same way `teardown` has to allow for.
      if (recorded && (id.startsWith(recorded) || recorded.startsWith(id))) continue
      provisionLog(`removing container ${id.slice(0, 12)} left by an unfinished start`)
      this.forget(id)
      await dockerRemove(id, provisionLog)
    }

    // The container to restart in place: the record names one, on the same repo
    // set, with the artifacts bind, and the daemon still has it. Anything else
    // is a fresh create — the mount list is fixed at create time, so a
    // container from before the artifacts bind existed is re-created once.
    const existing =
      owned?.id &&
      sameRepos(owned.repos, info.repos) &&
      owned.artifacts &&
      adaptersCurrent(owned) &&
      (await dockerContainerExists(owned.id))
        ? owned
        : undefined
    if (owned?.id && !existing) {
      if (sameRepos(owned.repos, info.repos) && !owned.artifacts)
        provisionLog(`re-creating the container to add the scope's shared ${CONTAINER_ROOT}/${ARTIFACTS} directory`)
      this.forget(owned.id)
    }

    // `building` covers the clone and the image; the create flips it to `post`
    // as soon as the container exists and its setup script starts running.
    this.setStatus(
      sessionId,
      {
        repos: info.repos,
        // An outdated container awaiting its replacement stays named until
        // the replacement is ready — a failed start must not orphan it.
        ...(existing ?? (retireLater ? owned : {})),
        status: 'building',
        error: undefined
      },
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
          dir: await ensureClone(this.refOf(info), cfg, provisionLog, sessionRole(info) === 'proactive')
        }))
      )
      // The anchor builds the image: the first `write` repo, else the first
      // repo (docs/requirements-repo-mounts.md §2.2) — every other repo is a
      // sibling mount only. Absent only for a repo-less session of a role that
      // may start with none; the gate above already refused the rest.
      const anchorName = anchorRepo(info)
      const anchor = clones.find((c) => c.cfg.name === anchorName)
      // The env's setup hooks prepare a writable checkout of the anchor; against
      // a read-only one they would fail deterministically (§2.3).
      const skipSetup = !!anchor && repoModeIsReadOnly(repoMode(info, anchor.cfg.name))
      // Whether the selection is *deliverable* is the agent kind's to say
      // (`AgentManifest.skillsDir`): resolve the draft's instance to its kind,
      // falling back to the workspace default the way the create path does
      // (ipc.ts). An id that resolves to nothing mounts nothing — gurt cannot
      // link a directory for an agent it cannot name.
      const skillsDir = agent?.skillsDir ?? null
      const historyPaths = agent?.historyPaths ?? []
      if (info.skills?.length && skillsDir === null)
        provisionLog(
          `[skills] agent "${kind ?? agentId ?? 'unknown'}" does not read skills — selection not mounted`
        )
      // The skills the session picked, staged into its scratch dir by
      // `materializeSkills` just before this call, bound read-only at a fixed
      // path (docs/requirements-skills.md §5). Added only when the session
      // selected something *and* its agent reads skills, so any other session
      // provisions exactly as it did before this feature existed — and a draft
      // that changes its selection (or, with one, its agent) releases its
      // container, since the mount list is fixed at create time (§5.2).
      const skillMounts = usesSkillMounts(info, skillsDir)
        ? [
            {
              hostDir: store.sessionSkillsDir(info.workspace, info.task, sessionId),
              target: SKILLS_MOUNT,
              readonly: true
            }
          ]
        : []
      // The agent's own conversation/resume state, read-write, bound whenever
      // its kind names any `historyPaths` — unconditional on the kind alone,
      // there is no selection here the way skills has one
      // (docs/requirements-agent-history.md §4). `ensureSessionHistory` is
      // `mkdir -p` only: never wiped, so a rebuilt container finds its own
      // history exactly where it left it.
      if (usesHistoryMounts(historyPaths))
        await store.ensureSessionHistory(info.workspace, info.task, sessionId, historyPaths)
      const historyMounts = historyHostMounts(info.workspace, info.task, sessionId, historyPaths)
      // The scope's shared scratch dir, read-write for every session of the
      // scope (shared/files.ts ARTIFACTS).
      const artifactsMount = {
        hostDir: await store.ensureArtifactsDir(info.workspace, info.task),
        target: `${CONTAINER_ROOT}/${ARTIFACTS}`
      }
      const { mounts, workdir } = containerLayout(
        info,
        clones.map(({ cfg, dir }) => ({ name: cfg.name, dir })),
        [...skillMounts, ...historyMounts, artifactsMount]
      )
      const bindSources = mounts.filter((m) => m.type === 'bind').map((m) => m.source)

      let execT: ExecTarget
      let adapters = existing?.adapters
      if (existing) {
        // Restart in place. Whatever image the container was created from is
        // what it keeps, so nothing is pulled or built. It still runs on the
        // open network for the start script, like a fresh one: the session
        // network is joined again once everything has run
        // (`convergeProxyNetwork`, §7.1).
        enter('image')
        enter('up')
        await this.convergeNetworks(sessionId, existing.id!, [DEFAULT_BRIDGE])
        this.setStatus(sessionId, { ...existing, status: 'post' }, 'user')
        const t: ExecTarget = {
          containerId: existing.id!,
          user: existing.user ?? 'root',
          cwd: existing.remoteWorkspaceFolder ?? workdir,
          ...(existing.path ? { path: existing.path } : {})
        }
        const execPath = await restartContainer(t, envCfg, bindSources, provisionLog, sessionId)
        execT = { ...t, path: execPath }
      } else {
        enter('image')
        const image = await prepareEnvImage(
          envCfg,
          anchor?.cfg ?? null,
          anchor?.dir ?? null,
          provisionLog
        )
        if (retireLater) {
          provisionLog("re-creating the container to mount the agent's adapters volume")
          await prepareReplacementVolumes(image, agent, provisionLog, sessionId)
          this.deps.detach(sessionId)
          this.forget(retireLater)
          await dockerRemove(retireLater, provisionLog)
        }
        enter('up')
        const created = await createContainer(
          { session: sessionId, image, env: envCfg, workdir, mounts, skipSetup, ...(agent ? { agent } : {}) },
          provisionLog,
          {
            // The container exists and its setup script starts: flip to `post`.
            // No id yet — a record naming a half-provisioned container is the
            // one thing that must never be written.
            onCreated: () =>
              this.setStatus(sessionId, { repos: info.repos, artifacts: true, status: 'post' }, 'user'),
            onSetupDone: (id, user, adapters) =>
              this.setStatus(
                sessionId,
                {
                  repos: info.repos,
                  artifacts: true,
                  status: 'post',
                  id,
                  user,
                  remoteWorkspaceFolder: workdir,
                  ...(adapters ? { adapters } : {})
                },
                'user'
              )
          }
        )
        adapters = created.adapters
        execT = {
          containerId: created.containerId,
          user: created.user,
          cwd: workdir,
          path: created.path
        }
      }
      // Owed after the container is up, before anything reports it usable: the
      // agent resolves its skills and its history at startup. The history
      // link runs here; the skills link is deferred instead of run inline —
      // `prepareContainer` is the only caller ever reached right after this
      // one (only `resolveLaunch` calls `ensure`), and consuming the debt
      // there merges it into the same `docker exec` as the node/adapter check.
      this.pendingPrepare.set(execT.containerId, {
        skillsDir: skillsDir !== null && skillMounts.length ? skillsDir : null
      })
      if (historyMounts.length)
        await linkContainerHistory(execT, sessionId, kind ?? 'unknown', historyPaths, provisionLog)
      // Deleted mid-start: this container was born after its session's delete
      // had already looked for one to take down, so nothing owns it and nothing
      // records it (`patchContainer` on a gone session is a no-op). Remove it
      // here rather than leaving an orphan for the next boot reconcile.
      if (!this.deps.session(sessionId)) {
        this.forget(execT.containerId)
        await dockerRemove(execT.containerId, provisionLog)
        throw new Error('session no longer exists')
      }
      const next: SessionContainer = {
        status: 'running',
        id: execT.containerId,
        remoteWorkspaceFolder: execT.cwd,
        user: execT.user,
        ...(execT.path ? { path: execT.path } : {}),
        repos: info.repos,
        artifacts: true,
        ...(adapters ? { adapters } : {})
      }
      this.setStatus(sessionId, next, 'user')
      enter()
      provisionLog('container is running')
      return next
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // Keep whatever the record already names (a container whose setup
      // succeeded, kept after a failed start script) — never invent an id.
      this.setStatus(
        sessionId,
        { repos: info.repos, ...(this.container(sessionId) ?? existing ?? {}), status: 'error', error: message },
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
    await this.timed(sessionId, 'network-converge', async () => {
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
    })
  }

  /**
   * The proxy half of steps 4–5 (§7.1) that does not touch the *session's*
   * container network — reserving/starting the session's proxy, which runs on
   * whatever network it runs on regardless of where the session's container
   * currently sits. Split from {@link convergeProxyNetwork} so `resolveLaunch`
   * can run this alongside the container check (step 3).
   */
  private async ensureProxyScope(info: SessionInfo): Promise<ProxyRuntime> {
    const provisionLog = this.logFor(info.id)
    const settings = info.network ?? {}
    return this.timed(info.id, 'proxy-ensure', () => proxies.ensure(info.id, settings, provisionLog))
  }

  /**
   * The network half of steps 4–5: switch the container onto the proxy's
   * network, and in internal mode confirm the switch actually took before
   * anything launches an agent into it.
   *
   * No restart is involved. The daemon rewires a live container's interfaces,
   * rewrites its `/etc/hosts` and points it at the embedded resolver; sockets
   * open across the switch die, and nothing of the agent's exists yet — which is
   * the whole reason this happens here and not later.
   *
   * Also a resume path: a container that is already where it belongs costs one
   * `docker inspect`, and one left half-attached by a crash is corrected
   * rather than compounded.
   *
   * Every caller of this is one step
   * away from launching an agent, and an agent launched into a container still
   * on the default bridge has the unrestricted egress the session was created
   * to deny — so the last thing that happens here is asking whether the switch
   * actually took.
   */
  private async convergeProxyNetwork(
    info: SessionInfo,
    containerId: string,
    runtime: ProxyRuntime
  ): Promise<ProxyRuntime> {
    const provisionLog = this.logFor(info.id)
    const settings = info.network ?? {}
    const network = sessionNetworkName(info.id)
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
    const { secret, entry: credEntry, error: credError } = resolveAgentSecret(
      await listCredentials(),
      cfg.credentialId
    )
    if (credError) throw new Error(`agent "${cfg.label}": ${credError}`)
    const anchor = anchorRepo(info)
    // Same rule as `ensure`'s gate: a role that may start repo-less has no repo
    // config to resolve an identity from, and needs none.
    const missing = missingRepoReason(info)
    if (missing) throw new Error(missing)
    const ws = await store.getWorkspace(info.workspace)
    const repoCfg = anchor ? ws.repos.find((r) => r.name === anchor) : undefined
    if (anchor && !repoCfg)
      throw new Error(`repo "${anchor}" is not registered in "${info.workspace}"`)

    const c = await this.ensure(sessionId)
    if (c.status !== 'running' || !c.id || !c.remoteWorkspaceFolder)
      throw new Error('container is not running')

    const exec = this.execTarget(c)
    if (!exec) throw new Error('container is not running')
    const target: AdapterTarget = {
      agent: def,
      session: sessionId,
      containerId: c.id,
      exec
    }
    // Steps 3–5 of the provisioning sequence (§7.1): the container check, the
    // proxy reservation and the network switch. Nothing here needs the open
    // network any more (the adapter is a mounted volume, not an install), so
    // the switch happens as soon as the proxy's scope is reserved.
    const proxy = await this.prepareAndProxy(info, c.id, target)
    // The async half of the credential seam (docs/requirements-oauth-
    // credentials.md §2, §5.2): an oauth link resolves to a *live* access
    // token, refreshed (single-flight, persisted) right here — after
    // provisioning, so a cold image build cannot age the token it injects.
    // Every launch starts with a fresh one; a dead refresh token throws the
    // signed-out sentence and no container-bound adapter spawns without auth.
    const injected = credEntry?.kind === 'oauth' ? await resolveOAuthAccess(credEntry.id) : secret
    // §5.2.1: delivery is per agent kind. A kind whose plugin names a native
    // auth file consumes a sign-in through it — materialized access-only,
    // right now, with the token just resolved — and its secretEnv var must
    // stay unset (a non-key value in it sends such a CLI down the API-key
    // path). Every other kind, and every agent-token link, keeps the env-var
    // path.
    let envSecret = injected
    if (credEntry?.kind === 'oauth') {
      // Re-read after the refresh above: the copy resolveAgentSecret returned
      // predates it, and the file composes from the persisted set (idToken may
      // have rotated with the access token).
      const freshEntry =
        (await listCredentials()).find((e) => e.id === credEntry.id) ?? credEntry
      const authFile = oauthAuthFile(def.id, freshEntry, injected, Date.now())
      if (authFile) {
        await this.timed(sessionId, 'oauth-write-file', () =>
          writeContainerUserFile(target.exec, authFile.path, authFile.content)
        )
        this.logFor(sessionId)(`wrote ~/${authFile.path} (oauth sign-in, access token only)`)
        envSecret = ''
      }
    }
    // Rewrite on every adapter launch, including {} when the user clears config.
    const configFile = clientConfigFile(cfg.kind, cfg.config)
    if (configFile) {
      await this.timed(sessionId, 'client-config-write', () =>
        writeContainerUserFile(target.exec, configFile.path, configFile.content)
      )
    }
    // The kind's own launch env (non-secret: e.g. pinning where its CLI keys
    // history, docs/requirements-agent-history.md §3.2), composed beside
    // whatever the agent instance's own config already sets — which wins on a
    // clash: it is the more specific, user-made choice.
    const launchEnv = agentMain(def.id)?.launchEnv?.({ sessionId }) ?? {}
    const env = { ...launchEnv, ...cfg.env }
    return {
      ...target,
      remoteWorkspaceFolder: c.remoteWorkspaceFolder,
      secret: envSecret,
      secretEnv: cfg.secretEnv || def.secretEnv,
      ...(Object.keys(env).length ? { env } : {}),
      proxy: { ...proxy, env: proxyEnv(proxy.base) },
      // Identity is injected unconditionally — it carries no authority, and a
      // local commit an agent does make should still be attributed. Anchored on
      // the session's first repo: with several, that is the one the identity is
      // resolved from, and they normally share a forge account anyway. A
      // repo-less operator has no repo to resolve one from, and nothing to
      // commit to either.
      ...(repoCfg ? { gitIdentityEnv: await this.resolveGitIdentity(repoCfg) } : {})
    }
  }

  /** What an `up` owes the container before its adapter may launch (see
   *  {@link prepareContainer}): once per `up`, consumed from `pendingPrepare`.
   *  Concurrent callers share one run; a container already prepared (or one
   *  reused as it was, with nothing owed) costs nothing. */
  private prepare(ctx: AdapterTarget): Promise<void> {
    const inflight = this.prepInFlight.get(ctx.containerId)
    if (inflight) return inflight
    const owed = this.pendingPrepare.get(ctx.containerId)
    if (owed === undefined) return Promise.resolve()
    this.pendingPrepare.delete(ctx.containerId)
    const provisionLog = this.logFor(ctx.session)
    const p = this.timed(ctx.session, 'container-prepare', async () => {
      try {
        await prepareContainer(ctx.exec, ctx.agent, owed.skillsDir, provisionLog)
      } catch (e) {
        // The volume this container mounts lost its contents behind a cached
        // "ready" (removed while unused, then re-created empty by `create`):
        // drop the cache, refill through the usual probe, check once more.
        const name = this.container(ctx.session)?.adapters
        const arch = name?.split('-').at(-1)
        if (!(e instanceof AdapterMissingError) || !name || !arch) throw e
        provisionLog(`adapters volume ${name} is empty — refilling it`)
        forgetReadyVolume(name)
        await ensureAdaptersVolume(ctx.agent, arch, provisionLog, ctx.session)
        await prepareContainer(ctx.exec, ctx.agent, owed.skillsDir, provisionLog)
      }
    }).catch((e: unknown) => {
      // Still owed: the next launch attempt must check again, not skip it.
      this.pendingPrepare.set(ctx.containerId, owed)
      throw e
    })
    this.prepInFlight.set(ctx.containerId, p)
    p.finally(() => this.prepInFlight.delete(ctx.containerId)).catch(() => {})
    return p
  }

  /**
   * `resolveLaunch`'s steps 3–5 (§7.1): the container check and the proxy
   * scope reservation + network switch run concurrently. Neither needs the
   * open network — the adapter is a read-only volume — so the window that
   * began at `create` ends with `setup`/`start` and the switch onto the proxy
   * (and, in internal mode, confirming it) waits for nothing but the proxy's
   * own scope.
   *
   * Both branches are awaited to completion either way (`allSettled`, not
   * `all`) so neither error is lost to an unhandled rejection — the check's
   * error wins when both fail (a musl image explains more than a refused
   * switch does).
   */
  private async prepareAndProxy(
    info: SessionInfo,
    containerId: string,
    target: AdapterTarget
  ): Promise<ProxyRuntime> {
    const [prepResult, proxyResult] = await Promise.allSettled([
      this.prepare(target),
      this.ensureProxyScope(info).then((scope) => this.convergeProxyNetwork(info, containerId, scope))
    ])
    if (prepResult.status === 'rejected') throw prepResult.reason
    if (proxyResult.status === 'rejected') throw proxyResult.reason
    return proxyResult.value
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
    this.pendingPrepare.delete(containerId)
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
    // Prefix, not equality: `docker ps` and `docker create` disagree on
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
  async stop(sessionId: string, reason: ContainerStatusReason = 'user', findDeleted = false): Promise<void> {
    await this.teardown(sessionId, 'stop', reason)
    // Review §5.3/§8: cleanup still owns a deleted executor's labelled containers.
    if (findDeleted && !this.container(sessionId)?.id) {
      const ids = await dockerSessionContainerIds(sessionId)
      if (ids === null) throw new Error('cannot locate the deleted executor’s containers')
      for (const id of ids) await dockerStop(id, this.logFor(sessionId))
    }
  }

  /**
   * Destroy the session's container — the session was deleted, or its draft was
   * re-pointed at another repo/env. The clone stays: uncommitted work in the
   * working tree outlives the session that produced it.
   */
  async release(sessionId: string, reason: ContainerStatusReason = 'user'): Promise<void> {
    await this.teardown(sessionId, 'remove', reason)
  }

  /** True while any session's container start is running. */
  isStarting(): boolean {
    return this.ensureInFlight.size > 0
  }

  /**
   * Retention sweep: remove the container of every session that is `stopped`
   * and for which `expired(id)` says it has sat stopped long enough. The session
   * and its clone stay; the next start builds a fresh container. A session with
   * a start in flight is skipped — its record may be about to flip.
   * Returns how many containers were removed.
   */
  async gcStopped(expired: (containerId: string) => Promise<boolean>): Promise<number> {
    let removed = 0
    for (const info of this.deps.sessions()) {
      const c = info.container
      if (c?.status !== 'stopped' || !c.id || this.ensureInFlight.has(info.id)) continue
      if (!(await expired(c.id))) continue
      // Re-read: the await above is long enough for a start to have begun.
      if (this.container(info.id)?.status !== 'stopped' || this.ensureInFlight.has(info.id)) continue
      await this.release(info.id, 'gc')
      removed++
    }
    return removed
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
    const detailed = await dockerSessionContainersDetailed()
    // Could not reach the daemon — leave every record alone rather than read its
    // silence as "no containers exist" and delete all of them.
    if (!detailed) {
      log.warn('reconcile skipped — docker unavailable, container records left as-is')
      return
    }
    const live = new Map([...detailed].map(([session, c]) => [session, c.id]))
    let fixed = 0
    let orphans = 0
    let migrated = 0
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
      // A container made before this runtime (no `gurt.runtime=docker`) cannot
      // be driven by this runtime — different keep-alive, no node volume, no
      // recorded user/PATH. Remove it and reset the record: the session
      // recreates it on its next start. Clones and agent history are host
      // binds, so only in-container state is lost. Skipped when the store is
      // degraded, for the same reason the orphan sweep is.
      if (detailed.get(info.id)?.runtime !== 'docker' && !store.storeDegraded()) {
        await dockerRemove(actual, (line) => log.debug('reconcile.premigration', { c: actual, line }))
        this.forget(actual)
        this.deps.patchContainer(info.id, undefined)
        migrated++
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
    log.info('reconcile.done', { fixed, orphans, migrated, swept: mayReap, ...sweepResult })
    this.deps.bus.emit('tree.changed', undefined)
  }
}
