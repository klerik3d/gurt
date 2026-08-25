// Per-session Docker networks: what they are called, how a container's
// endpoints are converged onto them, and how they are swept
// (docs/requirements-mcp-proxy.md §6.1, §7.1, §7.2).
//
// One network per session, `gurt-s-<id>`, labelled `gurt.session=<id>` — so
// `docker network ls --filter label=gurt.session` is the registry for networks
// exactly as `docker ps --filter label=gurt.session` is for containers, and
// teardown can ask the daemon instead of trusting a record that a crash may
// never have written.
//
// The load-bearing idea is `planNetworkConverge`: nothing here assumes a fresh
// start. A container is reused across stop/start, the app can be killed between
// any two docker calls, and endpoints *survive* a container's stop/start — so
// the only safe move is to observe what the daemon has, diff it against what
// the session wants, and apply the delta. Connect before disconnect, always: a
// container that is momentarily on no network at all has no route to anything,
// and on a live container that is a dropped connection rather than a rewired one.
//
// The planner is pure and is the unit-testable core (scripts/network-converge.test.mjs);
// everything below it is one `docker` invocation each.
//
// The other load-bearing idea is that a query has three answers, not two: what
// the daemon said, "the daemon says there is no such thing", and "the daemon did
// not answer". Collapsing the last two is how a converge silently does nothing
// — see `containerNetworks`, and `assertContainerNetworks` for the post-condition
// that catches it anyway.
import { run, type LogSink } from '../provision'

/** Networks (and session containers) carry the session id under this key. */
export const SESSION_LABEL = 'gurt.session'

/** Anything gurt created that is *not* per session — the shared egress bridge. */
export const MANAGED_LABEL = 'gurt.managed'

/** Docker's default bridge, where `devcontainer up` lands a fresh container and
 *  where provisioning deliberately runs (§7.3, the open-network window). */
export const DEFAULT_BRIDGE = 'bridge'

/**
 * The one shared network the proxies sit on for their own egress. Shared, not
 * per session: Docker's default address pool hands out /16s from 172.17.0.0/12,
 * so a second network per session would halve the number of concurrent sessions
 * a stock daemon supports (§6.1).
 */
export const EGRESS_NETWORK = 'gurt-egress'

/** The session's own network. Session ids are UUIDs, so this is always a legal
 *  docker name and always unambiguous. */
export const sessionNetworkName = (session: string): string => `gurt-s-${session}`

/** How long any single docker call here may take before it is killed. Well
 *  above a network create/connect (milliseconds) and far below forever. */
const DOCKER_TIMEOUT_MS = 20_000

/** Queries log nothing: they run several times per start and their output is
 *  parsed, not read. Failures surface at the call site instead. */
const quiet: LogSink = () => {}

export interface NetworkPlan {
  /** Networks to attach, in the caller's desired order. */
  connect: string[]
  /** Networks to detach — applied *after* every connect. */
  disconnect: string[]
}

/**
 * The whole of the converge logic: a pure function of (observed, desired).
 *
 * `observed` is what `docker inspect` says the container is attached to right
 * now — fresh from `up` (`['bridge']`), reused from a previous session
 * (`['gurt-s-<id>']`), or half-attached after a crash (both). `desired` is what
 * this phase of provisioning wants. The plan is the delta and nothing else, so
 * an already-converged container produces `{connect: [], disconnect: []}` and
 * costs zero docker calls.
 *
 * Order is part of the contract: the caller applies every `connect` before any
 * `disconnect` (see the module header).
 */
export function planNetworkConverge(
  observed: readonly string[],
  desired: readonly string[]
): NetworkPlan {
  const have = new Set(observed)
  const want = new Set(desired)
  return {
    connect: desired.filter((n) => !have.has(n)),
    disconnect: observed.filter((n) => !want.has(n))
  }
}

/** Docker's stdout, or null when the daemon could not be asked at all. The
 *  distinction matters everywhere a caller would otherwise read silence as
 *  "there is nothing there" and delete on the strength of it. */
async function query(args: string[]): Promise<string | null> {
  return run('docker', args, quiet, { timeoutMs: DOCKER_TIMEOUT_MS }).catch(() => null)
}

/**
 * Docker saying "there is no such thing" — an *answer*, and the only failure of
 * an inspect that is also a fact about the world.
 *
 * Every other failure (a socket it cannot reach, a daemon mid-restart, a
 * timeout, no `docker` on PATH) is the absence of an answer, and the two must
 * never collapse into one value: "the container is gone" is a reason to do
 * nothing, "the daemon did not reply" is a reason to stop — see
 * {@link containerNetworks}.
 *
 * Matched on the message because that is where `run` puts the tail of stderr,
 * and matched loosely because the spelling is version-dependent:
 * `Error: No such object: <id>` and
 * `Error response from daemon: No such container: <id>` are the same event.
 */
export function isNoSuchObject(e: unknown): boolean {
  return /no such (object|container|network|image)\b/i.test(
    e instanceof Error ? e.message : String(e)
  )
}

/**
 * How hard an inspect that never reached the daemon is retried before it is
 * believed. A daemon that is reloading (Docker Desktop updating its VM,
 * `systemctl restart docker`, a laptop coming back from sleep) is unreachable
 * for a moment and then fine; three tries across ~0.6s covers that without
 * stalling a start behind a daemon that is genuinely down.
 */
const INSPECT_TRIES = 3
const INSPECT_RETRY_MS = 300

/**
 * Networks a container is attached to.
 *
 * Three outcomes, kept three: the list (empty is legal — a live container can
 * genuinely be on no network at all), `null` when the daemon says there is no
 * such container, and a **throw** when the daemon could not be asked.
 *
 * That last one is the whole point of this function's shape. Folding a failed
 * inspect into `null` used to make a transient docker hiccup read exactly like
 * "nothing to converge", and the caller that acts on it
 * ({@link convergeContainerNetworks}) then left the container wherever it was
 * born — the default bridge — while provisioning carried on and launched the
 * agent. In internal mode that is the isolation guarantee silently evaporating,
 * so an inspect nobody answered has to be loud.
 */
export async function containerNetworks(containerId: string): Promise<string[] | null> {
  const args = [
    'inspect',
    '-f',
    '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}',
    containerId
  ]
  let last: unknown
  for (let attempt = 0; attempt < INSPECT_TRIES; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, INSPECT_RETRY_MS))
    try {
      const out = await run('docker', args, quiet, { timeoutMs: DOCKER_TIMEOUT_MS })
      return out.trim().split(/\s+/).filter(Boolean)
    } catch (e) {
      // The daemon answered, and its answer is "it does not exist".
      if (isNoSuchObject(e)) return null
      last = e
    }
  }
  throw new Error(
    `could not inspect container ${containerId.slice(0, 12)} after ${INSPECT_TRIES} tries: ` +
      (last instanceof Error ? last.message : String(last))
  )
}

/** Attach one container to one network, optionally under extra names its peers
 *  can resolve through the network's embedded DNS. */
async function connect(
  network: string,
  containerId: string,
  aliases: string[],
  log: LogSink
): Promise<void> {
  await run(
    'docker',
    ['network', 'connect', ...aliases.flatMap((a) => ['--alias', a]), network, containerId],
    log,
    { timeoutMs: DOCKER_TIMEOUT_MS }
  )
}

/** Detach one container from one network. `--force` because an endpoint left by
 *  a container the daemon considers half-dead is exactly the one blocking the
 *  `network rm` this is usually clearing the way for. */
async function disconnect(network: string, containerId: string, log: LogSink): Promise<void> {
  await run('docker', ['network', 'disconnect', '--force', network, containerId], log, {
    timeoutMs: DOCKER_TIMEOUT_MS
  })
}

/**
 * Bring one container's endpoints to exactly `desired`.
 *
 * Idempotent by construction — it plans against what the daemon reports, so a
 * fresh container, a reused one and one left half-attached by a crash all end
 * in the same place, and a container that is already there costs two docker
 * calls less than the version that "just reconnects".
 *
 * Returns the plan it applied (for the caller's log), or null when the daemon
 * says there is no such container — nothing to converge, and nothing anyone can
 * do about it here.
 *
 * Everything else fails loudly. A connect or a disconnect that throws already
 * did, and since the observation is the thing every decision below rests on, an
 * inspect the daemon never answered ({@link containerNetworks}) throws too: the
 * alternative is a start that quietly carries on with the container still on
 * whatever network it was born on, which in internal mode is the open one.
 *
 * Both operations work on a stopped container and take effect at its next
 * start; on a running one the daemon rewires the live interfaces. Sockets open
 * across a disconnect die, which is why the switch happens before the agent
 * exists (§7.1).
 */
export async function convergeContainerNetworks(
  containerId: string,
  desired: readonly string[],
  log: LogSink,
  aliases: Record<string, string[]> = {}
): Promise<NetworkPlan | null> {
  const observed = await containerNetworks(containerId)
  if (observed === null) return null
  const plan = planNetworkConverge(observed, desired)
  for (const network of plan.connect) await connect(network, containerId, aliases[network] ?? [], log)
  for (const network of plan.disconnect) await disconnect(network, containerId, log)
  return plan
}

/**
 * Re-ask the daemon and throw unless the container's endpoints are *exactly*
 * `desired`. The post-condition of the switch, for the sessions where the switch
 * is a security boundary (§7.1 step 5).
 *
 * Belt and braces, deliberately: `convergeContainerNetworks` already applied a
 * plan and already throws on every failure it can see. This costs one more
 * inspect and buys the property that a converge bug — this one, or the next one
 * — surfaces as a session that refuses to start rather than as an internal
 * session with a full route to the internet that nothing in the log mentions.
 *
 * Exact, not superset: in internal mode a leftover endpoint on the default
 * bridge *is* the failure being checked for, so an extra network is as much a
 * mismatch as a missing one.
 */
export async function assertContainerNetworks(
  containerId: string,
  desired: readonly string[]
): Promise<void> {
  const observed = await containerNetworks(containerId)
  if (observed === null)
    throw new Error(`container ${containerId.slice(0, 12)} no longer exists`)
  // "Nothing left to do" is the definition of converged, so the planner is also
  // the checker — one meaning of the word, in one place.
  const plan = planNetworkConverge(observed, desired)
  if (!plan.connect.length && !plan.disconnect.length) return
  throw new Error(
    `container ${containerId.slice(0, 12)} is on [${observed.join(', ') || 'no network'}], ` +
      `expected exactly [${desired.join(', ')}]`
  )
}

/** `internal` of an existing network, or null when there is no such network
 *  (or no daemon to ask). */
async function networkInternal(name: string): Promise<boolean | null> {
  const out = await query(['network', 'inspect', '-f', '{{.Internal}}', name])
  if (out === null) return null
  return out.trim() === 'true'
}

/** Container ids holding an endpoint on a network. Null when it could not be
 *  asked; `[]` when the network genuinely has none. */
async function networkEndpoints(name: string): Promise<string[] | null> {
  const out = await query([
    'network',
    'inspect',
    '-f',
    '{{range $id, $_ := .Containers}}{{$id}} {{end}}',
    name
  ])
  if (out === null) return null
  return out.trim().split(/\s+/).filter(Boolean)
}

/** Create a network, tolerating the "someone else just created it" race two
 *  concurrent session starts can produce. */
async function createNetwork(
  name: string,
  opts: { internal: boolean; labels: Record<string, string> },
  log: LogSink
): Promise<void> {
  const args = [
    'network',
    'create',
    ...(opts.internal ? ['--internal'] : []),
    ...Object.entries(opts.labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
    name
  ]
  try {
    await run('docker', args, log, { timeoutMs: DOCKER_TIMEOUT_MS })
  } catch (e) {
    // Lost the race (or a leftover we did not see): only "it is there now, with
    // the flag we asked for" excuses the failure — anything else is a real one.
    if ((await networkInternal(name)) !== opts.internal) throw e
  }
}

/**
 * Remove a network, endpoints and all.
 *
 * A network with live endpoints refuses to be removed, and the endpoint that
 * outlives everything is usually a container a failed start left behind — so
 * every endpoint is disconnected first (§9). Best-effort throughout: a network
 * that is already gone is the outcome this asked for.
 */
export async function removeNetwork(name: string, log: LogSink): Promise<void> {
  for (const id of (await networkEndpoints(name)) ?? [])
    await disconnect(name, id, log).catch(() => {})
  await run('docker', ['network', 'rm', name], log, { timeoutMs: DOCKER_TIMEOUT_MS }).catch(() => {})
}

/**
 * The session's network, created if missing.
 *
 * `internal` cannot be edited on a live network, so a network that exists with
 * the wrong flag is recreated — which is why this lives next to the converge
 * planner rather than in `ensure`: recreating means disconnecting whatever is
 * still on it, and the containers that come back are converged by the planner
 * moments later.
 */
export async function ensureSessionNetwork(
  session: string,
  internal: boolean,
  log: LogSink
): Promise<string> {
  const name = sessionNetworkName(session)
  const found = await networkInternal(name)
  if (found === internal) return name
  if (found !== null) {
    log(`network: ${name} exists as internal=${found}, recreating it as internal=${internal}`)
    await removeNetwork(name, log)
  }
  await createNetwork(name, { internal, labels: { [SESSION_LABEL]: session } }, log)
  log(`network: ${name} ready (internal=${internal})`)
  return name
}

/** Serialises the egress network's creation across concurrent session starts —
 *  `createNetwork` tolerates the race, but there is no reason to run it. */
let egressInFlight: Promise<string> | undefined

/**
 * The shared egress bridge the proxies use to reach the internet. Created on
 * demand and then left alone: an empty user-defined network costs one subnet
 * and nothing else, and removing it is a race against every other session (§9).
 */
export function ensureEgressNetwork(log: LogSink): Promise<string> {
  if (egressInFlight) return egressInFlight
  const p = (async () => {
    if ((await networkInternal(EGRESS_NETWORK)) === null)
      await createNetwork(EGRESS_NETWORK, { internal: false, labels: { [MANAGED_LABEL]: '1' } }, log)
    return EGRESS_NETWORK
  })()
  egressInFlight = p
  // A failed create must not poison the answer for every later start.
  p.catch(() => {}).finally(() => {
    if (egressInFlight === p) egressInFlight = undefined
  })
  return p
}

/**
 * Every gurt session network the daemon currently has, as session id → network
 * names. Null means "could not ask" and must never be read as "there are none"
 * — the same discipline `dockerSessionContainers` holds to, for the same reason:
 * the caller deletes on the strength of this answer.
 */
export async function dockerSessionNetworks(session?: string): Promise<Map<string, string[]> | null> {
  const out = await query([
    'network',
    'ls',
    '--filter',
    session ? `label=${SESSION_LABEL}=${session}` : `label=${SESSION_LABEL}`,
    '--format',
    `{{.Label "${SESSION_LABEL}"}} {{.Name}}`
  ])
  if (out === null) return null
  const map = new Map<string, string[]>()
  for (const line of out.split('\n')) {
    const [owner, name] = line.trim().split(/\s+/)
    if (!owner || !name) continue
    map.set(owner, [...(map.get(owner) ?? []), name])
  }
  return map
}

/** Remove every network carrying this session's label — by label, not by name,
 *  so a network whose session id was never recorded still goes. */
export async function removeSessionNetworks(session: string, log: LogSink): Promise<string[]> {
  const found = await dockerSessionNetworks(session)
  // Nothing found and nothing askable both mean "remove what we can name".
  const names = found?.get(session) ?? (found ? [] : [sessionNetworkName(session)])
  for (const name of names) await removeNetwork(name, log)
  return names
}
