// The proxy container's lifecycle: one per session, created with it, stopped
// when it goes idle, destroyed with it (docs/requirements-mcp-proxy.md §4.1, §9).
//
// What runs in it is a stock `node:22-alpine` with one bind-mounted script and
// one bind-mounted scope file. There is no image to build, no `npm install` at
// session start and no registry of our own — the proxy is dependency-free Node
// by construction, so "ship the proxy" is "copy a file".
//
// Two rules shape everything here:
//
//   1. **The daemon is the registry.** Proxies are found by label
//      (`gurt.proxy=<session>`), never by a record — a `docker run` that
//      succeeded moments before the app died leaves a container that only the
//      label can name. The key is deliberately *not* `gurt.session`: that one
//      is how `dockerSessionContainers()` builds session → devcontainer, and a
//      proxy carrying it would be swept as if it were the session's own
//      container (§4.1).
//   2. **Fail closed.** The scope is pushed *after* the proxy is up and
//      *before* the agent exists. Until it lands there is no scope file, so the
//      proxy 503s every MCP call and refuses every tunnel; a start that dies in
//      between leaves a proxy that can do nothing rather than one running on
//      stale authority.
//
// The credentials the proxy holds live in its heap and in the one file mounted
// into it. The agent cannot reach either: there is no docker client in the
// session container and no socket to use one on.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, type LogSink } from '../provision'
import { createLogger } from '../log'
import {
  PROXY_ALIAS,
  PROXY_CONFIG_TARGET,
  PROXY_PORT,
  PROXY_SCRIPT_TARGET,
  proxyBaseUrl,
  type DomainPolicy,
  type ProxyConfig
} from '../../shared/proxy'
import {
  ensureProxyConfigDir,
  mintProxyToken,
  proxyConfigMount,
  readProxyToken,
  removeProxyConfig,
  removeProxyConfigDir,
  writeProxyConfig
} from './config'
import { traffic } from './traffic'
import {
  EGRESS_NETWORK,
  MANAGED_LABEL,
  convergeContainerNetworks,
  dockerSessionNetworks,
  ensureEgressNetwork,
  ensureSessionNetwork,
  removeSessionNetworks
} from './network'

const log = createLogger('proxy')

/** Label key for proxy containers — see rule 1 in the module header. */
export const PROXY_LABEL = 'gurt.proxy'

/**
 * Pinned by digest, not tag, exactly as `providers.ts` pins its feature refs: a
 * tag is mutable, so a compromised `node:22-alpine` release would otherwise
 * flow straight into the process that holds every session's credentials. This
 * is the multi-arch index digest of `node:22-alpine` as of 2026-08-24 — bump it
 * deliberately, with `docker buildx imagetools inspect node:22-alpine`.
 */
export const PROXY_IMAGE =
  'node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32'

/** Where the session's config directory is mounted. The scope file lands at
 *  `PROXY_CONFIG_TARGET` inside it, which is the proxy's own default path. */
const CONFIG_MOUNT_TARGET = path.posix.dirname(PROXY_CONFIG_TARGET)

/** `docker run` may have to pull the image on the very first session. */
const RUN_TIMEOUT_MS = 5 * 60_000
const DOCKER_TIMEOUT_MS = 20_000

/** Container name. Cosmetic — every lookup goes through the label — but a
 *  `docker ps` a user runs by hand should say whose proxy this is. */
export const proxyContainerName = (session: string): string => `gurt-proxy-${session}`

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

/**
 * Host path of the proxy script, following `devcontainerCliPath()`'s
 * dev-vs-packaged split: in a packaged build the app lives inside app.asar,
 * which only Electron's own fs can read, while a bind source has to be a real
 * file on disk — so the path is redirected to the unpacked mirror (`asarUnpack`
 * in electron-builder.yml already carries `resources/**`).
 *
 * `GURT_PROXY_SCRIPT` overrides it, which is how the docker smoke test points
 * the container at a script it can assert against.
 */
export function proxyScriptPath(): string {
  const override = process.env['GURT_PROXY_SCRIPT']
  if (override) return override
  return path
    .join(moduleDir, '..', '..', 'resources', 'proxy', 'gurt-proxy.mjs')
    .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
}

/** What a session's proxy is, once it is up. */
export interface ProxyRuntime {
  session: string
  /** Handle to the scope this proxy holds (§5.1). Never logged. */
  token: string
  containerId: string
  /** The session's own network — where the agent reaches `gurt-proxy`. */
  network: string
  /** Base URL the *session container* uses (`http://gurt-proxy:8100`). */
  base: string
  internal: boolean
}

/** The session's network settings, as `ensure` needs them. */
export interface NetworkSettings {
  internal?: boolean | undefined
  policy?: DomainPolicy | undefined
}

interface Inspected {
  running: boolean
  image: string
  /** Mount destination → host source. */
  mounts: Record<string, string>
}

/** Split a `{{range}}`-joined docker format into its non-empty fields. */
const fields = (out: string, sep: string): string[] => out.trim().split(sep).filter(Boolean)

/**
 * Proxy containers carrying a session's label, running or not — the same
 * record-independent sweep `dockerSessionContainerIds` does for devcontainers.
 * Null means "could not ask the daemon", which must never be read as "there are
 * none": the callers below remove things on the strength of this answer.
 */
export async function dockerProxyContainers(session?: string): Promise<Map<string, string[]> | null> {
  const out = await run(
    'docker',
    [
      'ps', '-a', '--no-trunc',
      '--filter', session ? `label=${PROXY_LABEL}=${session}` : `label=${PROXY_LABEL}`,
      '--format', `{{.Label "${PROXY_LABEL}"}} {{.ID}}`
    ],
    () => {},
    { timeoutMs: DOCKER_TIMEOUT_MS }
  ).catch(() => null)
  if (out === null) return null
  const map = new Map<string, string[]>()
  for (const line of out.split('\n')) {
    const [owner, id] = line.trim().split(/\s+/)
    if (!owner || !id) continue
    map.set(owner, [...(map.get(owner) ?? []), id])
  }
  return map
}

async function inspectProxy(containerId: string): Promise<Inspected | null> {
  const out = await run(
    'docker',
    [
      'inspect',
      '-f',
      '{{.State.Running}}\t{{.Config.Image}}\t{{range .Mounts}}{{.Destination}}={{.Source}};{{end}}',
      containerId
    ],
    () => {},
    { timeoutMs: DOCKER_TIMEOUT_MS }
  ).catch(() => null)
  if (out === null) return null
  const [running = '', image = '', mounted = ''] = out.trim().split('\t')
  const mounts: Record<string, string> = {}
  for (const pair of fields(mounted, ';')) {
    const at = pair.indexOf('=')
    if (at > 0) mounts[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return { running: running === 'true', image, mounts }
}

/**
 * The proxy runs as the host user, not as root.
 *
 * `--cap-drop ALL` takes CAP_DAC_OVERRIDE with it, so a root process in the
 * container cannot read the 0600 scope file in its 0700 directory — root's
 * usual permission bypass *is* that capability. Matching the owning uid is what
 * keeps the file readable without either handing the proxy capabilities or
 * loosening the one file a resolved MCP credential is at rest in. On Windows
 * there are no uids to match and Docker Desktop does not enforce these bits.
 */
function userArgs(): string[] {
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  return uid === undefined || gid === undefined ? [] : ['--user', `${uid}:${gid}`]
}

/**
 * Per-session proxy containers, networks and scopes.
 *
 * Holds no authoritative state: the `live` map is a cache of what the last
 * `ensure` found, and everything it answers can be (and, after an app restart,
 * is) rebuilt from the daemon and from the scope file on disk.
 */
export class ProxyManager {
  private live = new Map<string, ProxyRuntime>()

  /**
   * The session's network and proxy, converged: the network exists with the
   * right `internal` flag, `gurt-egress` exists, and exactly one healthy proxy
   * is attached to both, answering to `gurt-proxy` on the session's network.
   *
   * Idempotent. A proxy that is running from the current image with the current
   * mounts is reused (and keeps its token, so a scope pushed against it stays
   * valid); anything else — stopped, from a stale script path, from an older
   * image — is removed and recreated, because a proxy is ~200ms and a stale one
   * is a session running on authority nobody can account for (§7.2).
   */
  async ensure(session: string, settings: NetworkSettings, sink: LogSink): Promise<ProxyRuntime> {
    const internal = settings.internal === true
    await ensureEgressNetwork(sink)
    const network = await ensureSessionNetwork(session, internal, sink)
    // The mount source must exist before `docker run`, or docker invents it as
    // a root-owned directory the host then cannot write the scope into.
    await ensureProxyConfigDir(session)

    let reused = ''
    for (const id of (await dockerProxyContainers(session))?.get(session) ?? []) {
      if (!reused && (await this.reusable(session, id))) {
        reused = id
        continue
      }
      // Every other proxy carrying this session's label is a leftover: two
      // proxies on one session network both answer to `gurt-proxy`, and which
      // one the agent reaches is a coin toss.
      sink(`proxy: removing stale proxy container ${id.slice(0, 12)}`)
      await this.removeContainer(id, sink)
    }
    // A reused proxy keeps the token of the scope it is already serving, so the
    // copy the agent baked into its environment survives the resume; a fresh
    // one has no scope yet and mints one.
    const token = (reused ? await readProxyToken(session) : null) ?? mintProxyToken()
    const containerId = reused || (await this.create(session, sink))
    await this.attach(containerId, network, sink)
    const runtime = { session, token, containerId, network, base: proxyBaseUrl(), internal }
    this.live.set(session, runtime)
    // Read the proxy's log from here on — including the lines it wrote before
    // this process existed, which is how a session resumed after an app restart
    // still explains a host it was refused (§8).
    traffic.watch(session, containerId, internal)
    // Port, never the URL and never the token — the same convention every other
    // credential-bearing listener in this codebase logs by.
    log.info(reused ? 'proxy.reuse' : 'proxy.start', {
      s: session,
      c: containerId.slice(0, 12),
      port: PROXY_PORT,
      internal
    })
    if (!reused)
      sink(`proxy: ${proxyContainerName(session)} listening on ${PROXY_ALIAS}:${PROXY_PORT}`)
    return runtime
  }

  /**
   * Is this container a proxy we can go on using, or one to replace?
   *
   * Reuse is only safe while every input it was created from still holds: it is
   * running, it is *this* build's image, and both binds point where this
   * process would point them. A proxy left by an older build, or by a run
   * against a different `GURT_ROOT`, is serving a script and a scope this
   * process cannot see — which is precisely the state that would go unnoticed.
   *
   * There is no health probe beyond `Running`: the scope arrives as a file
   * rather than over a control listener (§5.4), so the proxy exposes nothing to
   * ask. A proxy that is up but wedged is caught by the caller's first MCP call
   * failing, not here.
   */
  private async reusable(session: string, containerId: string): Promise<boolean> {
    const got = await inspectProxy(containerId)
    if (!got || !got.running) return false
    if (got.image !== PROXY_IMAGE) return false
    return (
      got.mounts[PROXY_SCRIPT_TARGET] === proxyScriptPath() &&
      got.mounts[CONFIG_MOUNT_TARGET] === proxyConfigMount(session)
    )
  }

  private async create(session: string, sink: LogSink): Promise<string> {
    // A container whose label we could not read but whose *name* is ours would
    // fail the run below; it is ours either way, so take it out first.
    await run('docker', ['rm', '-f', proxyContainerName(session)], () => {}, {
      timeoutMs: DOCKER_TIMEOUT_MS
    }).catch(() => {})
    sink(`proxy: starting ${proxyContainerName(session)}`)
    const out = await run(
      'docker',
      [
        'run', '-d',
        '--name', proxyContainerName(session),
        '--label', `${PROXY_LABEL}=${session}`,
        '--label', `${MANAGED_LABEL}=1`,
        // Started on the shared egress bridge, so it has a route out from its
        // first instruction; the session network is connected right after.
        '--network', EGRESS_NETWORK,
        // Host-side MCP (`github`, `gurt`) is reached here, and only from here:
        // in internal mode the session container has no route to the host at all.
        '--add-host', 'host.docker.internal:host-gateway',
        '--mount', `type=bind,source=${proxyScriptPath()},target=${PROXY_SCRIPT_TARGET},readonly`,
        '--mount', `type=bind,source=${proxyConfigMount(session)},target=${CONFIG_MOUNT_TARGET},readonly`,
        // Nothing in this container is allowed to be interesting: no writable
        // filesystem, no capabilities, no privilege escalation, no docker
        // socket, no workspace, no ports published to the host.
        '--read-only',
        '--tmpfs', '/tmp',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        ...userArgs(),
        PROXY_IMAGE,
        'node', PROXY_SCRIPT_TARGET
      ],
      sink,
      { timeoutMs: RUN_TIMEOUT_MS }
    )
    const id = out.trim().split('\n').pop()?.trim()
    if (!id) throw new Error('docker run reported no container id for the session proxy')
    return id
  }

  /** Put the proxy on both networks it needs, under the alias the agent's
   *  `HTTP_PROXY` names. Converged, not connected: a reused proxy may already
   *  be exactly right, or be left on a network that was recreated under it. */
  private async attach(containerId: string, network: string, sink: LogSink): Promise<void> {
    await convergeContainerNetworks(containerId, [EGRESS_NETWORK, network], sink, {
      [network]: [PROXY_ALIAS]
    })
  }

  /**
   * Hand the proxy a new scope: the MCP routes it may serve, the credentials it
   * injects on the way, and the session's egress policy.
   *
   * This is the whole of "push" (§5.4) — the file *is* the state, so a write is
   * a push, and one that lands while the agent is mid-turn takes effect without
   * reissuing the token the agent already holds. `SIGHUP` only saves the proxy's
   * poll interval; it is best-effort for exactly that reason.
   */
  async pushScope(session: string, config: ProxyConfig): Promise<void> {
    await writeProxyConfig(session, config)
    await this.reload(session)
    log.info('proxy.scope', { s: session, mcp: Object.keys(config.mcp), internal: config.network.internal })
  }

  /** Revoke the session's scope: the proxy fails closed on its next read. */
  async revokeScope(session: string): Promise<void> {
    await removeProxyConfig(session)
    await this.reload(session)
  }

  private async reload(session: string): Promise<void> {
    const containerId = this.live.get(session)?.containerId ?? proxyContainerName(session)
    await run('docker', ['kill', '--signal=HUP', containerId], () => {}, {
      timeoutMs: DOCKER_TIMEOUT_MS
    }).catch(() => {})
  }

  /**
   * The session went idle: revoke the scope and stop the container, keeping the
   * network (and every endpoint on it) for the resume. Recreating the proxy on
   * resume rather than restarting this one is deliberate — it costs ~200ms and
   * it guarantees the resumed session's scope is rebuilt from current config
   * instead of inherited from whatever the proxy was told before (§9).
   */
  async stop(session: string, sink: LogSink): Promise<void> {
    this.live.delete(session)
    // The tail goes, the ledger stays: "which host was blocked" is exactly the
    // question asked *after* a session has gone quiet.
    traffic.unwatch(session)
    await this.revokeScope(session)
    const found = await dockerProxyContainers(session)
    for (const id of found?.get(session) ?? [])
      await run('docker', ['stop', id], sink, { timeoutMs: DOCKER_TIMEOUT_MS }).catch(() => {})
  }

  /**
   * The session is gone: revoke, remove the proxy, then remove the network.
   *
   * That order is not stylistic — a network with live endpoints refuses to be
   * removed, and the endpoint that outlives everything is usually a container a
   * failed start left behind. `removeSessionNetworks` disconnects whatever is
   * still there before the `rm`, so both orderings converge on "gone".
   */
  async remove(session: string, sink: LogSink): Promise<void> {
    this.live.delete(session)
    traffic.forget(session)
    const found = await dockerProxyContainers(session)
    // Nothing found and nothing askable both mean "remove what we can name".
    const ids = found?.get(session) ?? (found ? [] : [proxyContainerName(session)])
    for (const id of ids) await this.removeContainer(id, sink)
    await removeSessionNetworks(session, sink)
    await removeProxyConfigDir(session)
    if (ids.length) log.info('proxy.remove', { s: session, c: ids.map((i) => i.slice(0, 12)) })
  }

  private async removeContainer(containerId: string, sink: LogSink): Promise<void> {
    await run('docker', ['rm', '-f', containerId], sink, { timeoutMs: DOCKER_TIMEOUT_MS }).catch(
      () => {}
    )
  }

  /**
   * Boot reconcile: take down every proxy and every session network whose
   * session no longer exists. `null` from either query means the daemon could
   * not be asked — nothing is removed on the strength of silence.
   */
  async sweepOrphans(known: Set<string>, sink: LogSink): Promise<{ proxies: number; networks: number }> {
    const swept = { proxies: 0, networks: 0 }
    for (const [session, ids] of (await dockerProxyContainers()) ?? []) {
      if (known.has(session)) continue
      this.live.delete(session)
      traffic.forget(session)
      for (const id of ids) await this.removeContainer(id, sink)
      await removeProxyConfigDir(session)
      swept.proxies += ids.length
    }
    // Networks are swept after the proxies that sit on them, so the `rm` is not
    // fighting an endpoint that is about to go anyway.
    for (const [session, names] of (await dockerSessionNetworks()) ?? []) {
      if (known.has(session)) continue
      await removeSessionNetworks(session, sink)
      swept.networks += names.length
    }
    return swept
  }
}

/** The one manager, shared by the container manager and the session manager. */
export const proxies = new ProxyManager()
