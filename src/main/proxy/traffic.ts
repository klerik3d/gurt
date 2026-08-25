// What the session's proxy has been seen doing (docs/requirements-mcp-proxy.md
// §8): the host tails the proxy container's stdout, parses the JSON lines it
// writes, folds them into a bounded per-session ledger and announces the change.
//
// The proxy logs to stdout and nowhere else — `docker logs -f` is the tail, so
// there is no file to mount, rotate or clean up, and a proxy that was started
// by a previous run of the app is just as readable as one we started ourselves.
//
// Two things this is for, in order:
//
//   1. **"Why doesn't X work?"** In internal mode a refused host is the whole
//      explanation, and it is invisible everywhere else — the agent sees a
//      connection error, the user sees a tool that failed. A blocked attempt
//      surfaced in the session is the difference between a policy a user can
//      operate and one they can only suffer.
//   2. **Writing an allow list at all.** open → watch → list is the workflow
//      (§6.3); the observed-domain list is its raw material.
//
// What is never in here, because it is never in the log: request paths, bodies,
// headers, the scope token. The proxy does not terminate TLS and records a
// hostname and a port — this module cannot surface what nobody collected.
import { spawn } from 'node:child_process'
import { lineBuffer } from '../provision'
import { createLogger } from '../log'
import { emptyTraffic, type SessionTraffic, type TrafficHost } from '../../shared/proxy'

const log = createLogger('proxy')

/** Distinct `host:port` entries kept per list, per session. Past this the
 *  least-recently-seen is evicted — `seen` still counts what was dropped, so a
 *  truncated list never reads as a complete one. */
const MAX_HOSTS = 100

/** How long changes are coalesced before the listener hears about them. An
 *  `npm install` is hundreds of connections in a few seconds and every one of
 *  them would otherwise be an IPC message carrying the whole aggregate. */
const EMIT_MS = 300

/** Lines of already-written log to pick up when attaching. Covers the window
 *  between `docker run` and this tail — and, after an app restart, the tail of
 *  what a proxy did while nobody was reading. */
const TAIL_LINES = 500

/** A dead `docker logs` is retried this many times before the session is left
 *  unwatched; the count resets as soon as a line arrives. A proxy we stopped on
 *  purpose is unwatched first, so those exits never reach the retry path. */
const MAX_RETRIES = 3
const RETRY_MS = 2000

/**
 * One record from the proxy's log, normalized. Everything is optional because
 * the writer is a separate program: an unknown `kind`, a missing field or a
 * future record shape must degrade to "not egress", never to a crash.
 */
export interface TrafficRecord {
  /** ISO timestamp, as the proxy stamped it. */
  at: string
  kind: string
  host?: string
  port?: number
  decision?: string
  /** The rule that refused it (`allowlist`, `builtin-denylist`), or why none
   *  was consulted (`no-scope`, `malformed`). */
  reason?: string
  /** MCP id, on `kind: 'mcp'` records. */
  id?: string
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/**
 * One JSON line → a record, or null for anything that is not one.
 *
 * `docker logs` interleaves whatever else the container wrote (a node warning,
 * a stack trace from a crash) with the proxy's own records, and a line that
 * does not parse is not an error here — it is someone else's output. It is
 * dropped rather than surfaced, because the only thing this ledger claims to
 * hold is connections.
 */
export function parseTrafficLine(line: string): TrafficRecord | null {
  const text = line.trim()
  if (!text.startsWith('{')) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const kind = str(r['kind'])
  if (!kind) return null
  const port = typeof r['port'] === 'number' && Number.isFinite(r['port']) ? r['port'] : undefined
  const rec: TrafficRecord = { at: str(r['t']) ?? new Date().toISOString(), kind }
  const host = str(r['host'])
  if (host) rec.host = host
  if (port !== undefined) rec.port = port
  const decision = str(r['decision'])
  if (decision) rec.decision = decision
  // `rule` is the policy's answer, `reason` the absence of one; the UI wants
  // whichever exists and does not care which field carried it.
  const reason = str(r['rule']) ?? str(r['reason'])
  if (reason) rec.reason = reason
  const id = str(r['id'])
  if (id) rec.id = id
  return rec
}

/** Egress is `CONNECT` and plain-HTTP forwarding. An `mcp` record is gurt's own
 *  routing (the upstream is a server the user picked, not a host the agent
 *  reached for), and `config`/`server` records are the proxy's lifecycle. */
const isEgress = (rec: TrafficRecord): boolean =>
  (rec.kind === 'connect' || rec.kind === 'http') && !!rec.host

const key = (host: string, port: number): string => `${host}:${port}`

/**
 * The folded record of one session's traffic.
 *
 * Bounded by construction and cheap to copy — `get` returns a fresh snapshot,
 * so a renderer holding one is never looking at state that mutates under it.
 */
class SessionLedger {
  internal = false
  seen = 0
  private blocked = new Map<string, TrafficHost>()
  private allowed = new Map<string, TrafficHost>()

  /** Fold one record in. True when a list changed — i.e. when the UI would
   *  render something different. */
  add(rec: TrafficRecord): boolean {
    this.seen++
    if (!isEgress(rec)) return false
    // An `error` decision is a connection that was permitted and then failed
    // (DNS, refused, timeout): the policy is not what stopped it, so it belongs
    // with the allowed hosts, where "we tried to reach this" is the claim.
    const denied = rec.decision === 'deny'
    const into = denied ? this.blocked : this.allowed
    const k = key(rec.host!, rec.port ?? 0)
    const prev = into.get(k)
    const entry: TrafficHost = {
      host: rec.host!,
      port: rec.port ?? 0,
      attempts: (prev?.attempts ?? 0) + 1,
      last: rec.at
    }
    if (denied && rec.reason) entry.reason = rec.reason
    into.set(k, entry)
    if (into.size > MAX_HOSTS) {
      // Least-recently-seen goes. Ordering by `last` rather than by insertion:
      // a host seen once an hour ago is less worth keeping than one seen twice
      // a minute ago, whichever arrived first.
      const oldest = [...into.entries()].sort((a, b) => a[1].last.localeCompare(b[1].last))[0]
      if (oldest && oldest[0] !== k) into.delete(oldest[0])
    }
    return true
  }

  snapshot(session: string): SessionTraffic {
    const recent = (m: Map<string, TrafficHost>): TrafficHost[] =>
      [...m.values()].sort((a, b) => b.last.localeCompare(a.last)).map((h) => ({ ...h }))
    return {
      session,
      internal: this.internal,
      blocked: recent(this.blocked),
      allowed: recent(this.allowed),
      seen: this.seen
    }
  }
}

/** Attach to a container's log stream. Returns a detach function; `onExit` fires
 *  when the stream ends on its own. Injectable so the ledger and the emit path
 *  can be tested without a daemon. */
export type Follow = (
  containerId: string,
  onLine: (line: string) => void,
  onExit: () => void
) => () => void

/** The real one: `docker logs -f`, line-buffered before anything reads it. */
const dockerFollow: Follow = (containerId, onLine, onExit) => {
  const child = spawn('docker', ['logs', '-f', '--tail', String(TAIL_LINES), containerId], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const buf = lineBuffer(onLine)
  child.stdout?.on('data', (chunk: Buffer) => buf.push(chunk))
  // The proxy writes its records to stdout only; anything on stderr is docker's
  // own or a crash in the proxy, and belongs in the app log rather than in a
  // list of hosts.
  child.stderr?.on('data', (chunk: Buffer) =>
    log.debug('proxy.logs.stderr', { c: containerId.slice(0, 12), out: String(chunk).trim() })
  )
  let done = false
  const ended = (): void => {
    if (done) return
    done = true
    buf.flush()
    onExit()
  }
  child.on('exit', ended)
  child.on('error', ended)
  return () => {
    done = true
    child.kill()
  }
}

interface Watched {
  ledger: SessionLedger
  /** Set while a follower is attached; cleared by `unwatch`. */
  stop?: (() => void) | undefined
  containerId?: string | undefined
  retries: number
  timer?: NodeJS.Timeout | undefined
}

/**
 * Every session's traffic, and the tails that feed it.
 *
 * The ledger outlives the tail on purpose: a session that went idle (its proxy
 * stopped, §9) keeps the blocked hosts that explain what did not work, and a
 * resumed one folds new records into the same list. Only deleting the session
 * — or sweeping it as an orphan — forgets them.
 */
export class TrafficWatcher {
  private sessions = new Map<string, Watched>()
  private listener: ((traffic: SessionTraffic) => void) | null = null
  private pending = new Set<string>()
  private flushTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly opts: { follow?: Follow; emitMs?: number } = {}
  ) {}

  /** Where coalesced changes go — the kernel points this at the bus. One
   *  listener, not a set: the bus is the fan-out, this is the seam to it. */
  onChange(fn: ((traffic: SessionTraffic) => void) | null): void {
    this.listener = fn
  }

  /** Follow this session's proxy container. Idempotent per container: a resume
   *  that reused the same proxy keeps the tail it already has. */
  watch(session: string, containerId: string, internal: boolean): void {
    const w = this.entry(session)
    w.ledger.internal = internal
    if (w.stop && w.containerId === containerId) return
    this.detach(w)
    w.containerId = containerId
    w.retries = 0
    this.attach(session, w)
  }

  /** Stop reading, keep what was read — the idle path. */
  unwatch(session: string): void {
    const w = this.sessions.get(session)
    if (w) this.detach(w)
  }

  /** The session is gone: drop the tail and the ledger with it. */
  forget(session: string): void {
    this.unwatch(session)
    this.sessions.delete(session)
    this.pending.delete(session)
  }

  /** Snapshot for the UI. A session nothing has been observed for reads as
   *  empty rather than absent — "no traffic yet" is an answer. */
  get(session: string, internal = false): SessionTraffic {
    const w = this.sessions.get(session)
    return w ? w.ledger.snapshot(session) : emptyTraffic(session, internal)
  }

  /** Fold one already-read line in. The tail's own sink, and the seam a test
   *  drives instead of a container. */
  ingest(session: string, line: string): void {
    const rec = parseTrafficLine(line)
    if (!rec) return
    const w = this.entry(session)
    w.retries = 0
    this.trace(session, rec)
    if (w.ledger.add(rec)) this.schedule(session)
  }

  private entry(session: string): Watched {
    let w = this.sessions.get(session)
    if (!w) this.sessions.set(session, (w = { ledger: new SessionLedger(), retries: 0 }))
    return w
  }

  private attach(session: string, w: Watched): void {
    const containerId = w.containerId
    if (!containerId) return
    const follow = this.opts.follow ?? dockerFollow
    log.debug('proxy.logs.attach', { s: session, c: containerId.slice(0, 12), retry: w.retries })
    w.stop = follow(
      containerId,
      (line) => this.ingest(session, line),
      () => {
        // The stream ended by itself: the proxy stopped, was replaced, or the
        // daemon went away. A few retries cover a restart; past that the
        // session is left unwatched rather than spinning, and the next `ensure`
        // attaches a fresh tail anyway.
        w.stop = undefined
        if (!this.sessions.has(session) || w.retries >= MAX_RETRIES) return
        w.retries++
        w.timer = setTimeout(() => {
          w.timer = undefined
          if (this.sessions.get(session) === w && !w.stop) this.attach(session, w)
        }, RETRY_MS)
        w.timer.unref?.()
      }
    )
  }

  private detach(w: Watched): void {
    w.stop?.()
    w.stop = undefined
    if (w.timer) clearTimeout(w.timer)
    w.timer = undefined
    w.containerId = undefined
  }

  /**
   * The app-log half of §8: allows at DBG, refusals at INF, and never more than
   * the proxy itself recorded. A refusal is worth a default-level line — it is
   * the one event a user goes looking for after the fact.
   */
  private trace(session: string, rec: TrafficRecord): void {
    const where = rec.host ? { host: rec.host, port: rec.port } : { id: rec.id }
    if (rec.decision === 'deny') log.info('proxy.deny', { s: session, kind: rec.kind, ...where, rule: rec.reason })
    else if (rec.decision === 'error') log.debug('proxy.error', { s: session, kind: rec.kind, ...where })
    else log.debug('proxy.allow', { s: session, kind: rec.kind, ...where })
  }

  private schedule(session: string): void {
    if (!this.listener) return
    this.pending.add(session)
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      const due = [...this.pending]
      this.pending.clear()
      for (const id of due) {
        const w = this.sessions.get(id)
        if (w) this.listener?.(w.ledger.snapshot(id))
      }
    }, this.opts.emitMs ?? EMIT_MS)
    this.flushTimer.unref?.()
  }
}

/** The one watcher, shared by the proxy manager (which feeds it) and the IPC
 *  layer (which reads it). */
export const traffic = new TrafficWatcher()
