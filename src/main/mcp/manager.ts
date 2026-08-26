import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { AcpHttpMcpServer, EnvRef, McpMode, McpSelection } from '../../shared/types'
import type { McpLocalEntry, McpRegistryEntry } from '../../shared/mcp'
import { RESERVED_MCP_IDS, isLocalMcpEntry, mcpDef } from '../../shared/mcp'
import { resolveMcpEnvSecret } from '../../shared/credentials'
import { mcpServerKey } from '../../shared/keys'
import { cloneDir, getMcpServers } from '../store'
import { listCredentials } from '../credentials'
import { createLogger } from '../log'
import { buildGithubHttpServer } from './githubServer'
import { startStdioBridge, type StdioBridge } from './stdioBridge'

const log = createLogger('mcp')

interface Running {
  id: string
  mode: McpMode
  http: Server
  /** Resolves to the ACP descriptor once the server is listening. */
  ready: Promise<AcpHttpMcpServer>
  /** Set once `ready` resolves — the stop log needs the port without the
   *  descriptor's URL, which carries the session's bearer token. */
  port?: number
}

/** One host MCP server per (session, mcp id). Servers operate on the session's
 *  clone, and are torn down with the session's container.
 *
 *  Built-ins only. A *local* registry entry is not per-session — see
 *  {@link localBridges} and docs/requirements-mcp-stdio.md §6. */
const running = new Map<string, Running>()

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    // 0.0.0.0 (not loopback) so the container can reach it via host.docker.internal.
    server.listen(0, '0.0.0.0', () => {
      // The startup reject is done its job; a *runtime* server error after this
      // would otherwise call a settled promise's reject and vanish.
      server.removeListener('error', reject)
      server.on('error', (e) => log.error('internal.fail', { site: 'mcp-server', err: e }))
      resolve((server.address() as AddressInfo).port)
    })
  })
}

/** Build and start one built-in server. The record is complete before any
 *  await, so the caller can enter it into `running` ahead of the listen — two
 *  concurrent resolves for one key must share one server, not race a second
 *  into a leak. */
function startServer(
  sessionId: string,
  ref: EnvRef,
  repo: string,
  id: string,
  mode: McpMode
): Running {
  const dir = cloneDir(ref.workspace, ref.task, repo)
  const token = randomUUID()
  // `github` is the only built-in with a clone-scoped server; a local registry
  // entry never reaches here (it has no clone, and one process serves every
  // session — `resolveLocalServers`).
  const http = buildGithubHttpServer(ref, repo, dir, mode, token)
  const rec = { id, mode, http } as Running
  rec.ready = listen(http).then((port): AcpHttpMcpServer => {
    rec.port = port
    log.info('mcp.start', { id, s: sessionId, mode, port })
    return {
      type: 'http',
      name: id,
      // host.docker.internal resolves to the host from Docker Desktop containers.
      url: `http://host.docker.internal:${port}/mcp/${token}`,
      headers: []
    }
  })
  return rec
}

function stopServer(sessionId: string, key: string, rec: Running): void {
  rec.http.close()
  // `close()` only stops new connections — a keep-alive socket would keep the
  // listener alive past the session it served.
  rec.http.closeAllConnections()
  log.info('mcp.stop', { id: rec.id, s: sessionId, mode: rec.mode, port: rec.port })
  running.delete(key)
}

/** Stop this session's servers that its selection no longer names — the other
 *  half of "the selection is the scope". Without it, narrowing a session's MCP
 *  set would leave the dropped server listening for the container's lifetime,
 *  and the agent's own descriptor list is not what keeps it out. */
function pruneServers(sessionId: string, keep: Set<string>): void {
  const prefix = `${sessionId}::`
  for (const [key, rec] of running) {
    if (!key.startsWith(prefix) || keep.has(rec.id)) continue
    stopServer(sessionId, key, rec)
  }
}

// --- local (stdio) registry entries, shared across sessions -----------------
//
// A local entry is one process per *registry entry*, not per session
// (docs/requirements-mcp-stdio.md §6): three sessions that all selected
// `kubernetes` talk to one `kubernetes-mcp-server`. So the lifetime question is
// a refcount — and, per requirements-mcp-proxy.md §7.2, the refcount is never
// stored. It is recomputed from the live holders on every change, so a gurt
// restart, a crashed session or a hand-edited registry all converge instead of
// leaving a number on disk that nothing can be checked against.

/** A registry entry is workspace-scoped, so its identity is too. */
const localKey = (workspace: string, id: string): string => `${workspace}::${id}`

/** One live session and the MCP ids it has selected — the ground truth the
 *  refcount is derived from. */
export interface LocalMcpHolder {
  sessionId: string
  workspace: string
  ids: readonly string[]
}

/** One local server that at least one live session wants, and who wants it. */
export interface LocalMcpWant {
  key: string
  workspace: string
  entry: McpLocalEntry
  /** Session ids, in first-seen order. Its length is the refcount. */
  sessions: string[]
}

/**
 * Which local servers should be running, given who is live right now. Pure, and
 * the whole of the lifecycle decision: a key in the result must have a process,
 * a key absent from it must not.
 *
 * Ids that resolve to nothing, or to a remote entry, are simply not here —
 * a remote entry has no process to refcount, and a dangling id is reported by
 * `planProxy`, which is the layer that talks to the session log.
 */
export function localMcpWants(
  holders: readonly LocalMcpHolder[],
  registries: ReadonlyMap<string, readonly McpRegistryEntry[]>
): Map<string, LocalMcpWant> {
  const wants = new Map<string, LocalMcpWant>()
  for (const holder of holders) {
    const registry = registries.get(holder.workspace) ?? []
    for (const id of holder.ids) {
      // A reserved id never resolves to a registry entry, however a
      // hand-edited file spells it — `mcpEntries` makes the built-in win the
      // lookup, so nothing may hold a process under that name either.
      if (RESERVED_MCP_IDS.includes(id)) continue
      const entry = registry.find((e) => e.id === id)
      if (!entry || !isLocalMcpEntry(entry)) continue
      const key = localKey(holder.workspace, id)
      const want = wants.get(key)
      if (!want) {
        wants.set(key, { key, workspace: holder.workspace, entry, sessions: [holder.sessionId] })
      } else if (!want.sessions.includes(holder.sessionId)) {
        want.sessions.push(holder.sessionId)
      }
    }
  }
  return wants
}

/**
 * The identity of a *running* process, as opposed to of a registry entry: every
 * field that would have made gurt spawn something else. An entry edited in any
 * of these restarts its process on the next reconcile; a relabelled entry does
 * not.
 */
export function localMcpSpec(entry: McpLocalEntry): string {
  const common = { args: entry.args ?? [], env: entry.env ?? {}, cred: entry.credentialEnvVar ?? '' }
  return JSON.stringify(
    entry.kind === 'npm'
      ? { kind: 'npm', package: entry.package, version: entry.version ?? '', ...common }
      : { kind: 'command', command: entry.command, cwd: entry.cwd ?? '', ...common }
  )
}

interface RunningLocal {
  bridge: StdioBridge
  spec: string
  /** Whatever secret this process was started with — a credential rotated in
   *  the store has to reach the child, and the child only reads its env once. */
  secret: string
}

const localBridges = new Map<string, RunningLocal>()
/** sessionId → what it holds. Written by `resolveMcpServers`, cleared by
 *  `stopMcpServers`; never persisted (see the note above). */
const localHolders = new Map<string, LocalMcpHolder>()

/** Reconciles run one at a time: they start and stop processes, and two
 *  overlapping passes would each see the other's half-finished work. */
let reconciling: Promise<void> = Promise.resolve()

/** The environment a local entry's credential link contributes (§3.4). */
async function credentialEnv(entry: McpLocalEntry): Promise<{ env: Record<string, string>; secret: string }> {
  if (!entry.credentialId || !entry.credentialEnvVar) return { env: {}, secret: '' }
  const { secret, error } = resolveMcpEnvSecret(await listCredentials(), entry.credentialId)
  // Blocks rather than starting unauthenticated — the same rule the proxy
  // applies to a remote entry's header (requirements-mcp-proxy.md §3.2).
  if (error) throw new Error(`MCP server "${entry.id}": ${error}`)
  return { env: { [entry.credentialEnvVar]: secret ?? '' }, secret: secret ?? '' }
}

/**
 * Converge the running local servers on what the live holders want: start what
 * is missing, stop what nothing holds any more, and restart what has been
 * edited into a different process.
 *
 * Never throws. A server that will not start (its package will not install, its
 * command is gone, its credential does not resolve) is logged and left out; the
 * session that wanted it gets no descriptor, and `planProxy` reports the id as
 * unroutable in the session log.
 */
async function reconcileLocal(): Promise<void> {
  const holders = [...localHolders.values()]
  const workspaces = [...new Set(holders.map((h) => h.workspace))]
  const registries = new Map<string, readonly McpRegistryEntry[]>()
  await Promise.all(
    workspaces.map(async (ws) => registries.set(ws, await getMcpServers(ws).catch(() => [])))
  )
  const wants = localMcpWants(holders, registries)

  // Resolve each want's credential up front: the secret is both what the child
  // is started with and half of "is the running process still the right one" —
  // a stdio server reads its environment once, so a rotated credential reaches
  // it only through a restart.
  const desired = new Map<
    string,
    { want: LocalMcpWant; spec: string; env: Record<string, string>; secret: string; error?: string }
  >()
  for (const want of wants.values()) {
    const base = { want, spec: localMcpSpec(want.entry) }
    try {
      const { env, secret } = await credentialEnv(want.entry)
      desired.set(want.key, { ...base, env, secret })
    } catch (e) {
      desired.set(want.key, {
        ...base,
        env: {},
        secret: '',
        error: e instanceof Error ? e.message : String(e)
      })
    }
  }

  // Stops first: an entry edited in place must not hold two processes open, and
  // an unheld one should be gone even if a replacement then fails to start.
  for (const [key, rec] of [...localBridges]) {
    const next = desired.get(key)
    if (next && !next.error && next.spec === rec.spec && next.secret === rec.secret) continue
    localBridges.delete(key)
    await rec.bridge.stop().catch(() => {})
  }

  for (const [key, next] of desired) {
    if (localBridges.has(key)) continue
    if (next.error) {
      log.error('mcp.fail', { id: next.want.entry.id, kind: next.want.entry.kind, err: next.error })
      continue
    }
    const bridge = startStdioBridge(next.want.entry, next.env)
    localBridges.set(key, { bridge, spec: next.spec, secret: next.secret })
    try {
      await bridge.ready
    } catch (e) {
      localBridges.delete(key)
      log.error('mcp.fail', {
        id: next.want.entry.id,
        kind: next.want.entry.kind,
        err: e instanceof Error ? e.message : String(e)
      })
    }
  }
}

/** Queue a reconcile behind any in flight. */
function scheduleReconcile(): Promise<void> {
  reconciling = reconciling.then(() => reconcileLocal()).catch(() => {})
  return reconciling
}

/**
 * Ensure the host MCP servers for `selection` are running for this session and
 * return their ACP descriptors. Restarts a server whose granted mode changed,
 * and stops one the selection dropped — this runs again on every start and
 * resume, so it is where a mid-session scope change takes effect.
 *
 * Two kinds of host server come back from here:
 *
 *   - gurt's **built-ins** (`github`), one listener per (session, id), scoped to
 *     the session's clone;
 *   - the registry's **local** entries (`npm` / `command`), one shared process
 *     per entry, refcounted across every live session (§6).
 *
 * A *remote* registry entry is neither: the proxy calls it directly, and this
 * path leaves it to `planProxy`.
 */
export async function resolveMcpServers(
  ref: EnvRef,
  sessionId: string,
  repo: string | undefined,
  selection: McpSelection[] | undefined
): Promise<AcpHttpMcpServer[]> {
  const registry = await getMcpServers(ref.workspace).catch(() => [] as McpRegistryEntry[])
  const picked = selection ?? []

  // Record what this session holds before the reconcile, so the refcount is
  // computed from a set that already includes it. Local entries need no repo:
  // the process runs on the host, against whatever the user's host auth
  // reaches, not against the session's clone.
  //
  // A reserved id is excluded here as well as in the store validator: a
  // hand-edited `workspace.json` must not be able to put a process behind
  // `github`, which is the same shadowing rule `mcpEntries` enforces for the
  // lookup. Duplicates collapse — selecting an id twice is one hold and one
  // descriptor.
  const localIds = [
    ...new Set(
      picked
        .filter((sel) => {
          if (RESERVED_MCP_IDS.includes(sel.id)) return false
          const entry = registry.find((e) => e.id === sel.id)
          return !!entry && isLocalMcpEntry(entry)
        })
        .map((sel) => sel.id)
    )
  ]
  localHolders.set(sessionId, { sessionId, workspace: ref.workspace, ids: localIds })
  await scheduleReconcile()

  const out: AcpHttpMcpServer[] = []

  // The built-ins operate on the session's clone; without a repo there is none —
  // and the prune still runs, so this revokes rather than leaks.
  const wanted = repo
    ? picked.filter((sel) => {
        if (mcpDef(sel.id)) return true
        if (!localIds.includes(sel.id))
          log.info('mcp.skip', { id: sel.id, s: sessionId, why: 'not-builtin' })
        return false
      })
    : []
  // Before the starts, so a selection that swapped one built-in for another does
  // not hold both open for the moment in between.
  pruneServers(sessionId, new Set(wanted.map((sel) => sel.id)))
  for (const sel of wanted) {
    const key = mcpServerKey(sessionId, sel.id)
    let rec = running.get(key)
    if (rec && rec.mode !== sel.mode) {
      stopServer(sessionId, key, rec)
      rec = undefined
    }
    if (!rec) {
      const started = startServer(sessionId, ref, repo!, sel.id, sel.mode)
      rec = started
      running.set(key, started)
      // A failed listen must not poison the key for every later resolve.
      started.ready.catch(() => {
        if (running.get(key) === started) running.delete(key)
      })
    }
    out.push(await rec.ready)
  }

  // In the user's order, and only the ones whose process actually came up: a
  // descriptor without a live bridge is a route the agent cannot use.
  const served = new Set<string>()
  for (const sel of picked) {
    if (!localIds.includes(sel.id) || served.has(sel.id)) continue
    served.add(sel.id)
    const rec = localBridges.get(localKey(ref.workspace, sel.id))
    if (!rec) continue
    const url = await rec.bridge.ready.catch(() => null)
    if (url) out.push({ type: 'http', name: sel.id, url, headers: [] })
  }
  return out
}

/** Tear down every host MCP server of a session (its container is going away),
 *  and release its share of the local servers — the last release is what stops
 *  a shared process. */
export function stopMcpServers(sessionId: string): void {
  pruneServers(sessionId, new Set())
  if (!localHolders.delete(sessionId)) return
  void scheduleReconcile()
}

/**
 * Stop every shared local server, synchronously. The app is quitting: nothing
 * holds them, and nothing will get a turn to await.
 *
 * Called from `before-quit`, which is why it does not go through the reconcile
 * — a promise scheduled there is not reliably given a turn before the process
 * exits, and an orphaned `kubernetes-mcp-server` holding a `tsh` session is not
 * something a user would think to go looking for.
 */
export function stopLocalMcpServers(): void {
  localHolders.clear()
  for (const [key, rec] of [...localBridges]) {
    localBridges.delete(key)
    rec.bridge.kill()
  }
}
