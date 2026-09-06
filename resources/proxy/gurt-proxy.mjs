// The gurt session proxy — one process per session, holding the credentials and
// the policy so the session container holds neither
// (docs/requirements-mcp-proxy.md §4).
//
// It runs inside a stock `node:22-alpine` with this single file bind-mounted at
// /opt/gurt/proxy.mjs, so it is **dependency-free by construction**: node:http,
// node:https, node:net, node:fs, node:crypto and nothing else. There is no
// `npm install` at session start and no image of our own to build; if you reach
// for a package here, the deployment story breaks, not just the build.
//
// It answers three kinds of traffic, all on one listener:
//
//   1. `/mcp/<token>/<mcpId>`  — MCP routing. The upstream URL, its static
//      headers and its resolved credential live in this process's config; the
//      session container knows only the opaque token. Bodies and responses are
//      **piped, never buffered**: streamable HTTP answers a POST with an SSE
//      stream, and a buffering proxy turns a working server into a hang.
//   2. `CONNECT host:port`     — HTTPS egress, tunnelled byte for byte. TLS is
//      never terminated and no certificate is ever generated, so the policy
//      below is domain-granular and cannot be anything finer.
//   3. absolute-form requests  — plain-HTTP egress, the shape a forward proxy
//      receives (`GET http://example.com/x HTTP/1.1`).
//
// **The token is a handle to a scope, not a claim about one.** It is 32 random
// bytes minted by the host, and this process resolves it against the scope it
// was given — no signature, no expiry, no JWT. The next reader will reach for a
// JWT; the reasons not to are in §5.2 of the requirements and they are all one
// reason: issuer and verifier are the same boundary, so a signature convinces
// nobody, while server-side scope is what lets the user flip an MCP server off
// or edit the policy *mid-session* without reissuing a token the agent already
// baked into its environment.
//
// **Config is a file, watched.** The host writes `<gurtRoot>/proxy/<session>.json`
// and bind-mounts it in; this process reloads it in place, so a scope change
// costs a file write rather than a restart (which would reissue the token, which
// is the thing that must not happen). The alternative — a loopback control
// endpoint — buys secrecy at rest, at the cost of a second token, a second
// listener and a push that has to be retried whenever the proxy restarts before
// the host notices. The file is written 0600 and is only ever mounted into this
// container.
//
// **Fail closed.** With no config loaded — before the first write, or after the
// host removes the file to revoke — `/mcp/*` answers 503 and every egress path
// is refused. A parse error keeps the last good scope instead, because a
// half-typed edit must not silently open or close a running session.
//
// **One allow list, three rules.** The user's policy is a single list of
// `host` or `host:port` entries (§6.3), and everything follows from whether it
// is empty:
//
//   1. empty     — everything outward is allowed, except a built-in denylist
//                  (§6.4): loopback, link-local (the cloud metadata service at
//                  169.254.169.254), the docker host and the RFC1918 ranges.
//                  That list is not about the internet, it is about the machine
//                  gurt runs on — an agent that reaches 169.254.169.254 through
//                  the proxy has the host's cloud credentials.
//   2. non-empty — *only* the listed destinations are allowed, and the built-in
//                  denylist is not consulted at all: a user who named a target
//                  has said something more specific than a default can.
//   3. a listed destination is connected exactly as written — dialled by name
//                  through the normal lookup, with no address vetting and no
//                  pinning, because that is the case the entry exists for
//                  (`internal.corp.com` resolving into 192.168.x is the point).
//                  A user who fears a name being repointed writes the literal.
//
// Under rule 1, checking the *name* would be theatre — an agent can point a
// name it controls at 169.254.169.254 — so a target is resolved once, every
// address it resolved to is vetted, and the connection is then made to the
// vetted address. Nothing re-resolves in between, which is the whole of the
// DNS-rebinding defence.
//
// The MCP routes are deliberately outside all of this: an upstream in the scope
// file is there because a human put it in the registry, and `host.docker.internal`
// is where a user's own MCP server usually lives.
//
// Nothing sensitive is ever logged: no request path (a URL routinely carries a
// token), no header, no body, no session token. One JSON line per attempt goes
// to stdout — `docker logs -f` is the tail, so there is nothing to mount and
// nothing to rotate. `GURT_PROXY_LOG=<path>` redirects to a file instead.
//
//   node gurt-proxy.mjs            # env: GURT_PROXY_CONFIG, _PORT, _BIND, _LOG
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import net from 'node:net'
import dns from 'node:dns'
import fs from 'node:fs'
import os from 'node:os'
import { timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'

/** Config file version this build understands (`ProxyConfig.version`). */
export const CONFIG_VERSION = 1

/** Defaults mirrored by src/shared/proxy.ts — change both or neither. */
const DEFAULT_PORT = 8100
const DEFAULT_CONFIG = '/etc/gurt/proxy.json'
/** Poll interval of the config watcher. fs.watch's inotify events do not cross
 *  a Docker Desktop bind mount, so the watch is a stat poll — one stat a second
 *  is free, and a second of latency on a policy edit is not felt. */
const DEFAULT_WATCH_MS = 1000

/** Names the proxy answers for *itself*, so a client that ignores NO_PROXY and
 *  sends `GET http://gurt-proxy:8100/mcp/...` absolute-form is still routed. */
const SELF_NAMES = new Set(['gurt-proxy', 'localhost', '127.0.0.1', '::1', os.hostname()])

/** Dropped in both directions: RFC 9110 connection-specific fields are a
 *  property of one hop and mean nothing to the next one. */
const HOP_BY_HOP = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

// ---------------------------------------------------------------------------
// Domain policy (§6.3) — pure, and the reason this file is importable.
// ---------------------------------------------------------------------------

/** Lowercased, de-bracketed, trailing-root-dot stripped: the one form every
 *  comparison below is made in. `EXAMPLE.com.` and `example.com` are one host. */
export function normalizeHost(host) {
  let h = String(host ?? '').trim().toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  while (h.endsWith('.')) h = h.slice(0, -1)
  return h
}

/** True for an IPv4/IPv6 literal — `net.isIP` is the whole test. */
export const isIpLiteral = (host) => net.isIP(normalizeHost(host)) !== 0

/**
 * Does `rule` cover `host`? A rule matches the host itself and any subdomain of
 * it (`example.com` covers `api.example.com`, never `notexample.com` — the dot
 * is what makes the boundary a label boundary). No mid-label wildcards.
 *
 * An IP literal matches exactly and never by suffix (`10.0.0.1` must not cover
 * `210.0.0.1`), and the two namespaces never cross: a name rule never matches a
 * literal and a literal rule never matches a name, because deciding that would
 * take a reverse lookup — slow, and forgeable by whoever controls the PTR.
 */
export function matchesDomain(host, rule) {
  const h = normalizeHost(host)
  const r = normalizeHost(rule)
  if (!h || !r) return false
  const hIp = net.isIP(h) !== 0
  const rIp = net.isIP(r) !== 0
  if (hIp !== rIp) return false
  if (h === r) return true
  // Textual comparison only: `::1` and `0:0:0:0:0:0:0:1` are the same address
  // and different rules. Hosts arrive as text from CONNECT, and the policy is
  // written by hand, so the two agree in practice.
  if (hIp) return false
  return h.endsWith(`.${r}`)
}

/**
 * The whole of the user's policy: one allow list, read as one of two rules
 * (§6.3).
 *
 *   - empty      → `{ allowed: true }`. Everything is permitted; the built-in
 *                  denylist below is what is left to say no.
 *   - non-empty  → only a target the list names is permitted, and `match` is
 *                  the entry that named it. Everything else is `allowlist`,
 *                  which is a rule the user can edit.
 *
 * `port` is part of the question because an entry may carry one: "the user
 * allowed this host" and "the user allowed this host on 5173" are different
 * sentences, and only the second one is what `host:port` says.
 */
export function policyDecision(host, port, policy) {
  const list = allowEntries(policy)
  if (!list.length) return { allowed: true }
  const match = list.find((entry) => matchesAllowEntry(host, port, entry))
  return match ? { allowed: true, match } : { allowed: false, rule: 'allowlist' }
}

// ---------------------------------------------------------------------------
// The built-in denylist (§6.4) — under every mode, and evaluated on addresses.
// ---------------------------------------------------------------------------

/** The rule name in the log and in the 403. Mirrored by `BUILTIN_DENY_REASON`
 *  in src/shared/proxy.ts, which is what the UI phrases. */
export const BUILTIN_DENY = 'builtin-denylist'

/**
 * Names refused outright, whatever they resolve to. The docker-host aliases are
 * here as well as in the address check because they are the *name* an agent
 * would reach for, and saying so in the log is more use than "192.168.65.2".
 *
 * `localhost` covers `*.localhost` too: RFC 6761 reserves the whole subtree for
 * the loopback, and a resolver that honours it is one bypass if we do not.
 */
export const BUILTIN_DENIED_NAMES = [
  'localhost',
  'host.docker.internal',
  'gateway.docker.internal'
]

/** IPv4/IPv6 text → bytes (4 or 16), or null. `net.isIP` says *whether* an
 *  address is one; a range test needs the octets, and a range test on text is
 *  how `169.254.169.254` gets in dressed as `::ffff:a9fe:a9fe`. */
export function ipToBytes(address) {
  const ip = normalizeHost(address)
  const family = net.isIP(ip)
  if (family === 4) return Uint8Array.from(ip.split('.').map(Number))
  if (family !== 6) return null
  const [head, tail = null] = ip.split('::')
  const groups = (text) => (text ? text.split(':') : [])
  const parse = (parts) => {
    const out = []
    for (const [i, part] of parts.entries()) {
      // A trailing dotted quad (`::ffff:127.0.0.1`) is four more bytes, not one
      // group — and it is the shape that matters most here.
      if (i === parts.length - 1 && part.includes('.')) {
        const v4 = ipToBytes(part)
        if (!v4) return null
        out.push(...v4)
        continue
      }
      const n = Number.parseInt(part, 16)
      out.push((n >> 8) & 0xff, n & 0xff)
    }
    return out
  }
  const left = parse(groups(head))
  const right = tail === null ? [] : parse(groups(tail))
  if (!left || !right) return null
  const gap = 16 - left.length - right.length
  if (tail === null ? gap !== 0 : gap < 0) return null
  return Uint8Array.from([...left, ...new Array(gap).fill(0), ...right])
}

/**
 * Is this address one of the ranges that are gurt's machine rather than the
 * internet? Returns the range's name (for the log) or null.
 *
 * IPv4: loopback 127/8, "this network" 0/8 (0.0.0.0 reaches the local host on
 * Linux, which makes it loopback by another spelling), link-local 169.254/16,
 * and RFC1918 10/8, 172.16/12, 192.168/16.
 *
 * IPv6: the same set in its own notation — ::1, the unspecified ::, fe80::/10,
 * and fc00::/7 (unique-local, the RFC1918 of v6) — plus every notation that
 * carries a v4 address inside a v6 one (mapped, compatible, NAT64, 6to4),
 * which is unwrapped and checked as v4.
 */
export function deniedRange(address) {
  const b = ipToBytes(address)
  if (!b) return null
  if (b.length === 4) {
    if (b[0] === 127 || b[0] === 0) return 'loopback'
    if (b[0] === 169 && b[1] === 254) return 'link-local'
    if (b[0] === 10) return 'private'
    if (b[0] === 172 && b[1] >= 16 && b[1] <= 31) return 'private'
    if (b[0] === 192 && b[1] === 168) return 'private'
    return null
  }
  // Four notations carry a v4 address inside a v6 one, and a range test that
  // reads only some of them is a hole the others walk through.
  const zeros = (from, to) => b.slice(from, to).every((x) => x === 0)
  const mapped = zeros(0, 10) && b[10] === 0xff && b[11] === 0xff
  const nat64 = b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)
  // ::/96 (compatible, deprecated but still routed by some stacks) is the one
  // notation that overlaps the plain v6 answers: `::` and `::1` are the
  // unspecified and loopback addresses themselves, not 0.0.0.0 and 0.0.0.1
  // wearing a prefix, so they fall through to the v6 rules below. That escape
  // is *only* theirs — `::ffff:0.0.0.0` is a real quad and must unwrap, or
  // 0.0.0.0 (the local host, on Linux) gets in by the back door.
  const compatible = zeros(0, 12) && !(zeros(12, 15) && b[15] <= 1)
  // 6to4 keeps its quad in bits 16-47 rather than the last four bytes.
  const sixToFour = b[0] === 0x20 && b[1] === 0x02
  const v4 = sixToFour ? b.slice(2, 6) : mapped || nat64 || compatible ? b.slice(12) : null
  if (v4) return deniedRange(v4.join('.'))
  if (b.every((x, i) => (i < 15 ? x === 0 : x <= 1))) return 'loopback'
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return 'link-local'
  if ((b[0] & 0xfe) === 0xfc) return 'private'
  return null
}

/** A name the built-in denylist refuses on sight — the loopback and docker-host
 *  aliases. Exact, or a subdomain of one, on the same label boundary every
 *  other rule in this file uses. */
export const deniedName = (host) =>
  BUILTIN_DENIED_NAMES.find((name) => matchesDomain(host, name)) ?? null

/**
 * {@link deniedRange}, plus the addresses `host.docker.internal` resolved to in
 * this container — the docker host itself, which the proxy reaches through
 * `--add-host …:host-gateway` and the session must not.
 *
 * On Docker Desktop that address is already RFC1918, so this is usually the
 * same answer twice; it is here for the topology where it is not.
 */
export function deniedAddress(address, gateway = []) {
  const range = deniedRange(address)
  if (range) return range
  const ip = normalizeHost(address)
  return gateway.some((g) => normalizeHost(g) === ip) ? 'host-gateway' : null
}

/**
 * One explicit-allow entry: `host`, `host:port`, `[::1]` or `[::1]:8443`.
 * `port` is null for a bare host, which covers every port on it.
 *
 * Deliberately not `parseAuthority`, which defaults the port — the difference
 * between "the user allowed this host" and "the user allowed this host on 443"
 * is the whole meaning of the entry.
 */
export function parseAllowEntry(entry) {
  const raw = String(entry ?? '').trim().toLowerCase()
  if (!raw) return null
  let host = raw
  let port = null
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    if (end < 0) return null
    host = raw.slice(1, end)
    const rest = raw.slice(end + 1)
    if (rest.startsWith(':')) port = Number(rest.slice(1))
    else if (rest) return null
  } else {
    const colon = raw.lastIndexOf(':')
    // A bare v6 literal is all colons and no port; only a colonless head splits.
    if (colon > 0 && !raw.slice(0, colon).includes(':')) {
      host = raw.slice(0, colon)
      port = Number(raw.slice(colon + 1))
    }
  }
  host = normalizeHost(host)
  if (!host) return null
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) return null
  return { host, port }
}

/** Does one entry name this target? The host half matches the way every rule in
 *  this file does (the host or a subdomain, an IP literal exactly); the port
 *  half, when the entry carries one, must be equal. */
export function matchesAllowEntry(host, port, entry) {
  const parsed = parseAllowEntry(entry)
  if (!parsed) return false
  if (parsed.port !== null && parsed.port !== Number(port)) return false
  return matchesDomain(host, parsed.host)
}

/** The policy's entries, or an empty list if it has none this process can read.
 *  A non-array `allow` never reaches here — `parseConfig` refuses the config
 *  rather than reading it as "no entries", which would be a silent widening. */
export const allowEntries = (policy) => (Array.isArray(policy?.allow) ? policy.allow : [])

/**
 * The entry by which the user allowed this target, or null.
 *
 * There is one list and it is that set: an entry is a sentence the user wrote
 * about one destination, and rule 3 connects it exactly as written — dialled by
 * name, no address check, no pinning. The list being empty is not an allow of
 * anything; it is rule 1, which is a statement about the internet, and the
 * built-in denylist is about this machine.
 */
export function explicitAllow(host, port, policy) {
  return allowEntries(policy).find((entry) => matchesAllowEntry(host, port, entry)) ?? null
}

/**
 * Everything that can be decided about a target before a resolver is involved.
 * Returns one of:
 *
 *   `{ allowed: true, explicit }`  — the user named it; dial it by name.
 *   `{ allowed: false, rule, … }`  — refused, by their allow list (rule 2) or by
 *                                    the built-in one (rule 1).
 *   `{ allowed: true, resolve: true }` — permitted so far; every address it
 *                                    resolves to still has to pass `deniedRange`.
 *
 * The order is the three rules, in order. An entry the user wrote wins over
 * everything and is connected as written (rule 3) — no resolve-and-vet, no
 * pinning, so `internal.corp.com` may point at `192.168.x` and a user who fears
 * a name being repointed writes the literal instead. Failing that, a non-empty
 * list refuses everything it does not name and the built-in denylist is never
 * consulted (rule 2). Only under an empty list (rule 1) does the built-in list
 * decide — by name, and then on every address the name answers with.
 */
export function vetTarget(host, port, policy, gateway = []) {
  const explicit = explicitAllow(host, port, policy)
  if (explicit) return { allowed: true, explicit }
  const verdict = policyDecision(host, port, policy)
  if (!verdict.allowed) return verdict
  const name = deniedName(host)
  if (name) return { allowed: false, rule: BUILTIN_DENY, match: name }
  if (isIpLiteral(host)) {
    const range = deniedAddress(host, gateway)
    return range
      ? { allowed: false, rule: BUILTIN_DENY, match: range, ip: normalizeHost(host) }
      : { allowed: true, ip: normalizeHost(host) }
  }
  return { allowed: true, resolve: true }
}

/** The address half of {@link vetTarget}: the first vetted address to pin to, or
 *  the range that refused one of them. Every address is checked, not just the
 *  one we would use — a name that answers with a public address *and* a private
 *  one is not a name this proxy will race against. */
export function vetAddresses(addresses, gateway = []) {
  const list = (Array.isArray(addresses) ? addresses : []).filter((a) => net.isIP(String(a)) !== 0)
  if (!list.length) return { allowed: false, rule: BUILTIN_DENY, match: 'unresolvable' }
  for (const address of list) {
    const range = deniedAddress(address, gateway)
    if (range) return { allowed: false, rule: BUILTIN_DENY, match: range, ip: String(address) }
  }
  return { allowed: true, ip: String(list[0]) }
}

// ---------------------------------------------------------------------------
// Route + config parsing
// ---------------------------------------------------------------------------

/**
 * `/mcp/<token>/<mcpId>` → `{ token, id }`, anything else → null. Exactly three
 * segments: a trailing slash or a deeper path is not this route, because the
 * upstream's own path replaces it wholesale (§4.3) and there is nothing left to
 * put a suffix on.
 */
export function parseMcpRoute(pathname) {
  const parts = String(pathname ?? '').split('/')
  if (parts.length !== 4 || parts[0] !== '' || parts[1] !== 'mcp') return null
  const token = decodeURIComponent(parts[2])
  const id = decodeURIComponent(parts[3])
  if (!token || !id) return null
  return { token, id }
}

/** `host:port`, `[::1]:port` or a bare host → `{ host, port }`. */
export function parseAuthority(target, defaultPort = 443) {
  const raw = String(target ?? '').trim()
  if (!raw) return null
  let host = raw
  let port = defaultPort
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    if (end < 0) return null
    host = raw.slice(1, end)
    const rest = raw.slice(end + 1)
    if (rest.startsWith(':')) port = Number(rest.slice(1))
    else if (rest) return null
  } else {
    const colon = raw.lastIndexOf(':')
    if (colon > 0) {
      host = raw.slice(0, colon)
      port = Number(raw.slice(colon + 1))
    }
  }
  host = normalizeHost(host)
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port }
}

const isHeaderList = (v) =>
  v === undefined ||
  (Array.isArray(v) && v.every((h) => h && typeof h.name === 'string' && typeof h.value === 'string'))

/**
 * Validate a parsed config file. Returns `{ config }` or `{ error }` — never a
 * partially-applied scope, because "half the MCP servers and no policy" is a
 * state no caller could reason about.
 */
export function parseConfig(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'config is not an object' }
  if (raw.version !== CONFIG_VERSION)
    return { error: `unsupported config version ${JSON.stringify(raw.version)}` }
  if (typeof raw.token !== 'string' || !raw.token) return { error: 'token must be a non-empty string' }
  if (typeof raw.session !== 'string' || !raw.session)
    return { error: 'session must be a non-empty string' }

  const mcp = {}
  const entries = raw.mcp && typeof raw.mcp === 'object' ? Object.entries(raw.mcp) : []
  if (raw.mcp !== undefined && (typeof raw.mcp !== 'object' || raw.mcp === null))
    return { error: 'mcp must be an object' }
  for (const [id, up] of entries) {
    if (!up || typeof up !== 'object') return { error: `mcp "${id}" is not an object` }
    if (up.kind !== 'host' && up.kind !== 'registry')
      return { error: `mcp "${id}" has unknown kind ${JSON.stringify(up.kind)}` }
    let url
    try {
      url = new URL(up.url)
    } catch {
      return { error: `mcp "${id}" has an invalid url` }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return { error: `mcp "${id}" must be http(s)` }
    if (!isHeaderList(up.headers)) return { error: `mcp "${id}" has malformed headers` }
    mcp[id] = { kind: up.kind, url: up.url, headers: up.headers ?? [] }
  }

  // The policy is one list, and it is the field that decides *both* directions:
  // a list this process cannot read would be read as empty, which is rule 1 —
  // an open session whose user thinks they wrote an allow list. So it is
  // refused rather than skipped, and so is any single entry in it.
  const policy = raw.network?.policy ?? { allow: [] }
  if (!policy || typeof policy !== 'object') return { error: 'policy must be an object' }
  const allow = policy.allow ?? []
  if (!Array.isArray(allow)) return { error: 'policy allow must be an array' }
  const bad = allow.find((e) => typeof e !== 'string' || !parseAllowEntry(e))
  if (bad !== undefined)
    return { error: `allow entry ${JSON.stringify(bad)} is not a host or host:port` }

  return {
    config: {
      version: raw.version,
      session: raw.session,
      token: raw.token,
      mcp,
      network: { internal: raw.network?.internal === true, policy: { allow: [...allow] } },
      selfNames: Array.isArray(raw.selfNames) ? raw.selfNames.map(normalizeHost) : []
    }
  }
}

/** Read + parse the config file. `missing` distinguishes "revoked" (the host
 *  removed it) from "broken" (keep the last good scope). */
export function readConfigFile(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    return e?.code === 'ENOENT' ? { missing: true } : { error: `cannot read config: ${e?.code ?? e}` }
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return { error: 'config is not valid JSON' }
  }
  return parseConfig(raw)
}

/** Constant-time token compare. Length leaks either way (the strings are one
 *  fixed length in practice), the bytes must not. */
export function tokenMatches(given, expected) {
  const a = Buffer.from(String(given ?? ''), 'utf8')
  const b = Buffer.from(String(expected ?? ''), 'utf8')
  if (a.length === 0 || a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// ---------------------------------------------------------------------------
// Header plumbing
// ---------------------------------------------------------------------------

/** Fields a `Connection:` header nominates are hop-by-hop too, by definition. */
function connectionTokens(headers) {
  return String(headers?.connection ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/** Copy headers minus everything that belongs to this hop. `drop` names extras
 *  (the MCP path drops `host`; the upstream URL decides that one). */
function forwardable(headers, drop = []) {
  const banned = new Set([...HOP_BY_HOP, ...connectionTokens(headers), ...drop])
  const out = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (banned.has(name.toLowerCase())) continue
    out[name] = value
  }
  return out
}

/** Set `name` on `headers`, replacing any existing spelling of it. The injected
 *  credential must win over whatever the container sent, case included. */
function setHeader(headers, name, value) {
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) if (key.toLowerCase() === lower) delete headers[key]
  headers[name] = value
}

// ---------------------------------------------------------------------------
// The proxy
// ---------------------------------------------------------------------------

/** Node hangs `code` off socket and HTTP errors; the string form is the
 *  fallback. Never the message of an upstream error, which can echo a URL. */
function errCode(e) {
  return e && typeof e === 'object' && 'code' in e ? String(e.code) : 'error'
}

/** One JSON line per record, timestamp first. The caller supplies the sink. */
export function jsonLineLogger(write) {
  return (record) => {
    try {
      write(`${JSON.stringify({ t: new Date().toISOString(), ...record })}\n`)
    } catch {
      // A logging failure must never take the session's egress down with it.
    }
  }
}

/** The default resolver: every address a name has, in the order the system
 *  would have used. `dns.lookup` and not `dns.resolve` on purpose — /etc/hosts
 *  is how `host.docker.internal` exists at all, and a resolver that skipped it
 *  would vet a different address than the one node would dial. */
const systemResolve = async (hostname) => {
  const found = await dns.promises.lookup(hostname, { all: true, verbatim: true })
  return found.map((entry) => entry.address)
}

/**
 * Build the proxy. `listen()`/`close()` are the caller's (the container's entry
 * point below, or a test's).
 *
 * `resolve` is the seam the rebinding tests drive: one name → its addresses,
 * used both to vet a target and (through the node-style `lookup` below) to dial
 * the paths that are not pinned to an address.
 *
 * @param {{ configPath?: string, log?: (rec: any) => void, watch?: boolean, watchMs?: number, resolve?: (hostname: string) => Promise<string[]> }} opts
 */
export function createProxy(opts = {}) {
  const configPath = opts.configPath ?? DEFAULT_CONFIG
  const log = opts.log ?? jsonLineLogger((line) => process.stdout.write(line))
  const watchMs = opts.watchMs ?? DEFAULT_WATCH_MS
  const resolve = opts.resolve ?? systemResolve

  /** `resolve` in the shape node's http/net options want, so an injected
   *  resolver is the *only* resolver this process has. */
  const lookup = (hostname, options, callback) => {
    resolve(hostname).then((addresses) => {
      const list = (addresses ?? []).filter((a) => net.isIP(String(a)) !== 0)
      if (!list.length) {
        callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }))
        return
      }
      if (options?.all) callback(null, list.map((address) => ({ address, family: net.isIP(address) })))
      else callback(null, list[0], net.isIP(list[0]))
    }, callback)
  }

  /** The whole authority of this process. null = fail closed. */
  let config = null
  /** Addresses `host.docker.internal` has in *this* container — the docker host,
   *  which the built-in denylist refuses by address as well as by name. Resolved
   *  once at listen: `--add-host` writes it into /etc/hosts and it does not move
   *  while the container lives. Empty until then, and empty if it does not
   *  resolve at all, which is the topology where there is no host to reach. */
  let gateway = []
  /** CONNECT tunnels are detached from the server's socket bookkeeping, so
   *  close() has to know about them or a stopped proxy keeps a session alive. */
  const tunnels = new Set()

  const reload = (reason) => {
    const result = readConfigFile(configPath)
    if (result.missing) {
      if (config) log({ kind: 'config', decision: 'revoked', reason })
      config = null
      return { revoked: true }
    }
    if (result.error) {
      // Keep the last good scope: a truncated or half-typed file must not open
      // or close a running session by accident.
      log({ kind: 'config', decision: 'error', reason, error: result.error })
      return { error: result.error }
    }
    config = result.config
    log({
      kind: 'config',
      decision: 'loaded',
      reason,
      session: config.session,
      mcp: Object.keys(config.mcp).length,
      // The list's *size*, never its contents: the log is safe to show.
      policy: allowEntries(config.network.policy).length ? 'allowlist' : 'open',
      internal: config.network.internal
    })
    return { config }
  }

  const server = createServer()
  // A streamable-HTTP POST can stay open for the length of a model turn and an
  // SSE response for the length of the session: neither is a stalled request,
  // and node's 300s request timeout would cut both. The header and keep-alive
  // timeouts keep their defaults — they bound a connection that has not started
  // talking yet, which is a different thing and still worth reaping.
  server.requestTimeout = 0
  server.timeout = 0

  /** Our own listening port, for telling "reached through the proxy" apart from
   *  "asked the proxy to fetch something that happens to look like our route". */
  const selfPort = () => {
    const address = server.address()
    return address && typeof address === 'object' ? address.port : null
  }

  const isSelf = (url) => {
    const host = normalizeHost(url.hostname)
    const names = new Set([...SELF_NAMES, ...(config?.selfNames ?? [])])
    if (!names.has(host)) return false
    const port = url.port ? Number(url.port) : 80
    return port === selfPort() || port === DEFAULT_PORT
  }

  const deny = (res, status, text) => {
    const body = `${text}\n`
    res.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      connection: 'close'
    })
    res.end(body)
  }

  // -- MCP -----------------------------------------------------------------

  function handleMcp(req, res, route, url) {
    const started = Date.now()
    if (!config) {
      log({ kind: 'mcp', id: route.id, decision: 'deny', reason: 'no-scope', status: 503 })
      deny(res, 503, 'gurt proxy has no session scope yet')
      return
    }
    if (!tokenMatches(route.token, config.token)) {
      // Same answer as an unknown id, and the same answer the host servers give
      // (`mcp/githubServer.ts`): an unknown path is a 404, not a hint.
      log({ kind: 'mcp', id: route.id, decision: 'deny', reason: 'token', status: 404 })
      deny(res, 404, 'not found')
      return
    }
    const upstream = config.mcp[route.id]
    if (!upstream) {
      // Logged, not silent: "the agent asked for an MCP it does not have" is
      // exactly what the blocked list exists to show (§4.3).
      log({ kind: 'mcp', id: route.id, decision: 'deny', reason: 'unknown-id', status: 404 })
      deny(res, 404, `no MCP server "${route.id}" in this session's scope`)
      return
    }

    const target = new URL(upstream.url)
    // The upstream's own path wins; a query the client added rides along, which
    // is how a resumable SSE stream keeps its cursor.
    for (const [k, v] of url.searchParams) target.searchParams.set(k, v)

    // `host` is the upstream's, and hop-by-hop fields are this hop's. Everything
    // else — Accept, Content-Type, Mcp-Session-Id, Last-Event-ID — passes
    // through untouched, because the transport is the client's business.
    const headers = forwardable(req.headers, ['host'])
    for (const h of upstream.headers ?? []) setHeader(headers, h.name, h.value)

    const secure = target.protocol === 'https:'
    const dial = secure ? httpsRequest : httpRequest
    const port = target.port || (secure ? 443 : 80)
    const record = {
      kind: 'mcp',
      id: route.id,
      up: normalizeHost(target.hostname),
      host: normalizeHost(target.hostname),
      port: Number(port),
      decision: 'allow'
    }

    // Building the request is where a bad header lands: node validates names and
    // values synchronously and throws (ERR_INVALID_CHAR / ERR_INVALID_HTTP_TOKEN)
    // right here, inside a request listener. The header came from the scope
    // file, so it is one MCP id's problem — answer 502 for that id and say so in
    // the log, rather than letting the throw end the process and take every
    // other route and all egress with it.
    let up
    try {
      // No policy and no address vetting on this path, deliberately (§6.4): an
      // upstream is in the scope file because a human put it in the registry,
      // and `host.docker.internal:<published port>` is where a user's own MCP
      // server usually lives. A registry entry *is* an explicit allow.
      up = dial({
        protocol: target.protocol,
        hostname: target.hostname,
        port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
        lookup
      })
    } catch (e) {
      log({ ...record, decision: 'error', reason: 'bad-header', error: errCode(e), status: 502, ms: Date.now() - started })
      deny(res, 502, `the configured headers for MCP server "${route.id}" cannot be sent — check its credential`)
      return
    }

    // Interactive, chunk-at-a-time traffic in both directions: Nagle would hold
    // an SSE event back waiting for a bigger write that never comes.
    up.on('socket', (socket) => socket.setNoDelay(true))
    up.on('response', (upRes) => {
      // No rewriting of any kind, and no buffering: `pipe` hands each chunk on
      // as it lands, which is what keeps an SSE response an SSE response.
      res.writeHead(upRes.statusCode ?? 502, forwardable(upRes.headers))
      res.socket?.setNoDelay(true)
      log({ ...record, status: upRes.statusCode ?? 0, ms: Date.now() - started })
      upRes.pipe(res)
    })
    up.on('error', (e) => {
      log({ ...record, decision: 'error', error: errCode(e), ms: Date.now() - started })
      if (!res.headersSent) deny(res, 502, `upstream MCP server for "${route.id}" is unreachable`)
      else res.destroy()
    })
    // An agent that walks away mid-stream must take the upstream stream with it,
    // or an abandoned SSE connection outlives every turn that opened one. A
    // reset client raises 'error' on both halves; unhandled, that is a crash.
    res.on('close', () => up.destroy())
    req.on('error', () => up.destroy())
    res.on('error', () => up.destroy())
    req.pipe(up)
  }

  // -- plain-HTTP egress ---------------------------------------------------

  async function handleForward(req, res, url) {
    const started = Date.now()
    const secure = url.protocol === 'https:'
    const host = normalizeHost(url.hostname)
    const port = Number(url.port || (secure ? 443 : 80))
    if (!config) {
      log({ kind: 'http', host, port, decision: 'deny', reason: 'no-scope' })
      deny(res, 403, 'gurt proxy has no session scope yet')
      return
    }
    const verdict = await vetEgress(host, port, config.network.policy)
    if (!verdict.allowed) {
      if (verdict.rule === 'dns') {
        log({ kind: 'http', host, port, decision: 'error', error: verdict.error, ms: Date.now() - started })
        deny(res, 502, `cannot resolve ${host}`)
        return
      }
      log({ kind: 'http', host, port, decision: 'deny', rule: verdict.rule, ...ipOf(verdict) })
      deny(res, 403, forbiddenText(host, port, verdict))
      return
    }
    // The client may have walked away while the name was resolving.
    if (res.writableEnded || res.destroyed) return

    const dial = secure ? httpsRequest : httpRequest
    // `host` stays: on this path it names the origin the client asked for. When
    // the target was vetted by address we dial *that* address and put the name
    // back in `Host` and (for TLS) in the SNI — re-resolving here is exactly the
    // window a rebinding attack needs.
    const headers = forwardable(req.headers)
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'host'))
      setHeader(headers, 'Host', url.host)
    const up = dial({
      protocol: url.protocol,
      hostname: verdict.ip ?? url.hostname,
      port,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers,
      lookup,
      ...(secure ? { servername: host } : {})
    })
    up.on('response', (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, forwardable(upRes.headers))
      log({ kind: 'http', host, port, decision: 'allow', status: upRes.statusCode ?? 0, ms: Date.now() - started })
      upRes.pipe(res)
    })
    up.on('error', (e) => {
      log({ kind: 'http', host, port, decision: 'error', error: errCode(e), ms: Date.now() - started })
      if (!res.headersSent) deny(res, 502, `cannot reach ${host}:${port}`)
      else res.destroy()
    })
    res.on('close', () => up.destroy())
    req.on('error', () => up.destroy())
    res.on('error', () => up.destroy())
    req.pipe(up)
  }

  /**
   * The whole egress decision for one target: {@link vetTarget}, and — when it
   * asks for one — a single resolution whose result is vetted and *pinned*.
   *
   * The address travels back with the verdict because the caller must dial it
   * rather than the name. Resolving twice is resolving under a name whose owner
   * chooses the second answer.
   */
  async function vetEgress(host, port, policy) {
    const verdict = vetTarget(host, port, policy, gateway)
    if (!verdict.resolve) return verdict
    let addresses
    try {
      addresses = await resolve(host)
    } catch (e) {
      // A name that does not resolve is a connection failure, not a refusal:
      // the policy never got to have an opinion.
      return { allowed: false, rule: 'dns', error: errCode(e) }
    }
    return vetAddresses(addresses, gateway)
  }

  /** The vetted address, when there is one worth recording. A refusal that names
   *  the address is the difference between "this host is private" and "this host
   *  answered with a private address", which is the rebinding case. */
  const ipOf = (verdict) => (verdict.ip ? { ip: verdict.ip } : {})

  /** The 403 body. An agent that reads its own error should learn what happened
   *  rather than retry forever — so it names the host and the way out. */
  function forbiddenText(host, port, verdict) {
    if (verdict.rule === BUILTIN_DENY) {
      const where =
        verdict.match === 'unresolvable'
          ? 'did not resolve to any address'
          : BUILTIN_DENIED_NAMES.includes(verdict.match)
            ? 'names this machine'
            : verdict.ip && verdict.ip !== host
              ? `resolves to a ${verdict.match} address (${verdict.ip})`
              : `is a ${verdict.match} address`
      return (
        `${host} ${where}, and gurt refuses proxied egress to this machine's own ` +
        `networks by default (${host}:${port}). If the session is meant to reach ` +
        `it, ask the user to add "${host}:${port}" to the allow list in the ` +
        "session's network settings — note that doing so restricts the session to " +
        'the listed destinations only.'
      )
    }
    const why =
      verdict.rule === 'allowlist'
        ? `${host} is not on this session's allow list`
        : `${host} is refused by this session's network policy`
    return `${why} (${host}:${port}). Ask the user to add it in the session's network settings.`
  }

  // -- CONNECT (HTTPS) -----------------------------------------------------

  // Same last line of defence as the request path, and needed for the same
  // reason: the handler awaits a resolver now, so a throw inside it is an
  // unhandled rejection — which is the process, and with it every tunnel.
  server.on('connect', (req, socket, head) => {
    handleConnect(req, socket, head).catch((e) => {
      log({ kind: 'connect', decision: 'error', error: errCode(e) })
      socket.destroy()
    })
  })

  async function handleConnect(req, rawSocket, head) {
    // The event types its socket as a bare Duplex; it is a net.Socket, and a
    // tunnel needs the socket-level knobs.
    const socket = /** @type {import('node:net').Socket} */ (rawSocket)
    // Attached before anything else can fail: a client that reads a refusal and
    // resets (curl does) would otherwise raise an unhandled 'error' on a socket
    // the http server no longer tracks — and take the session's whole egress
    // down with the process.
    socket.on('error', () => socket.destroy())
    const started = Date.now()
    const authority = parseAuthority(req.url, 443)
    const refuse = (status, text, record) => {
      log(record)
      const body = `${text}\n`
      socket.write(
        `HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Bad Request'}\r\n` +
          'Content-Type: text/plain; charset=utf-8\r\n' +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          'Connection: close\r\n\r\n' +
          body
      )
      socket.end()
    }
    if (!authority) {
      refuse(400, 'malformed CONNECT target', { kind: 'connect', decision: 'deny', reason: 'malformed' })
      return
    }
    const { host, port } = authority
    if (!config) {
      refuse(403, 'gurt proxy has no session scope yet', {
        kind: 'connect',
        host,
        port,
        decision: 'deny',
        reason: 'no-scope'
      })
      return
    }
    const verdict = await vetEgress(host, port, config.network.policy)
    if (!verdict.allowed) {
      if (verdict.rule === 'dns') {
        // Nothing was refused; the name has no address. Same shape as any other
        // failure to reach the far side, before the tunnel exists.
        log({ kind: 'connect', host, port, decision: 'error', error: verdict.error, ms: Date.now() - started })
        socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
        socket.end()
        return
      }
      refuse(403, forbiddenText(host, port, verdict), {
        kind: 'connect',
        host,
        port,
        decision: 'deny',
        rule: verdict.rule,
        ...ipOf(verdict)
      })
      return
    }
    if (socket.destroyed) return

    // The vetted address, not the name: re-resolving between the check and the
    // connect is the rebinding window. TLS is the client's own, end to end, so
    // its SNI and certificate check still name the host it asked for.
    const upstream = net.connect(
      verdict.ip ? { host: verdict.ip, port } : { host, port, lookup }
    )
    tunnels.add(socket)
    tunnels.add(upstream)
    let established = false
    const drop = () => {
      tunnels.delete(socket)
      tunnels.delete(upstream)
    }
    upstream.on('connect', () => {
      established = true
      log({ kind: 'connect', host, port, decision: 'allow', ms: Date.now() - started })
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      // Interactive traffic in both directions: TLS handshakes and MCP-over-SSE
      // are small writes where Nagle costs a round trip each.
      socket.setNoDelay(true)
      upstream.setNoDelay(true)
      if (head?.length) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.on('error', (e) => {
      log({ kind: 'connect', host, port, decision: 'error', error: errCode(e), ms: Date.now() - started })
      // Before the 200 the client is still speaking HTTP and can be told; after
      // it, the only honest signal is a closed tunnel.
      if (socket.destroyed) drop()
      else if (established) {
        socket.destroy()
        drop()
      } else {
        socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
        socket.end()
        drop()
      }
    })
    socket.on('error', () => upstream.destroy())
    socket.on('close', () => {
      upstream.destroy()
      drop()
    })
    upstream.on('close', drop)
  }

  // -- dispatch ------------------------------------------------------------

  // Last line of defence for the whole request path: any throw a listener lets
  // escape — synchronously, or from the forward path's `await` — is an unhandled
  // 'error' on the server or an unhandled rejection, which is the process. One
  // malformed request, or one unsendable header the layers above missed, must
  // cost that request and nothing else.
  server.on('request', (req, res) => {
    const failed = (e) => {
      log({ kind: 'request', decision: 'error', error: errCode(e), status: 502 })
      if (!res.headersSent) deny(res, 502, 'gurt proxy could not process this request')
      else res.destroy()
    }
    try {
      dispatch(req, res)?.catch?.(failed)
    } catch (e) {
      log({ kind: 'request', decision: 'error', error: errCode(e), status: 502 })
      if (!res.headersSent) deny(res, 502, 'gurt proxy could not process this request')
      else res.destroy()
    }
  })

  function dispatch(req, res) {
    const target = req.url ?? '/'
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
      // Absolute-form: a forward-proxy request. Unless it names this proxy, in
      // which case it is an MCP call from a client that ignored NO_PROXY.
      let url
      try {
        url = new URL(target)
      } catch {
        deny(res, 400, 'malformed request URI')
        return
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        deny(res, 400, `unsupported scheme "${url.protocol}"`)
        return
      }
      const route = isSelf(url) ? parseMcpRoute(url.pathname) : null
      if (route) handleMcp(req, res, route, url)
      // The one branch that returns a promise — the forward path resolves the
      // target before it dials it. `server.on('request')` catches what it rejects.
      else return handleForward(req, res, url)
      return
    }
    const url = new URL(target, 'http://proxy.invalid')
    if (url.pathname === '/healthz') {
      // Liveness for the host's ensure/reconcile. Says whether a scope is
      // loaded, never what is in it.
      const body = `${JSON.stringify({ ok: true, scope: !!config })}\n`
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      })
      res.end(body)
      return
    }
    const route = parseMcpRoute(url.pathname)
    if (route) handleMcp(req, res, route, url)
    // The proxy serves nothing of its own: an origin-form request for anything
    // else is neither a route nor a proxy request.
    else deny(res, 404, 'not found')
  }

  let watcher = false
  const startWatch = () => {
    if (watcher || opts.watch === false) return
    fs.watchFile(configPath, { interval: watchMs }, () => reload('watch'))
    watcher = true
  }

  return {
    server,
    /** Re-read the config file now. Returns `{ config } | { error } | { revoked }`. */
    reload,
    /** The live scope, for tests and for the health endpoint. */
    current: () => config,
    listen(port = DEFAULT_PORT, host = '0.0.0.0') {
      reload('start')
      startWatch()
      // Best effort and not awaited: a proxy that cannot name the docker host
      // still serves, and every realistic gateway address is inside a range the
      // built-in list already refuses.
      resolve('host.docker.internal').then(
        (found) => {
          gateway = (found ?? []).filter((a) => net.isIP(String(a)) !== 0)
        },
        () => {}
      )
      return new Promise((settle, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.removeListener('error', reject)
          const address = server.address()
          settle(address && typeof address === 'object' ? address.port : port)
        })
      })
    },
    close() {
      if (watcher) fs.unwatchFile(configPath)
      watcher = false
      for (const socket of tunnels) socket.destroy()
      tunnels.clear()
      /** @type {Promise<void>} */
      const closed = new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
      return closed
    }
  }
}

/** Entry point: env in, proxy up. Kept tiny so everything above stays testable. */
export async function main(env = process.env) {
  const logPath = env.GURT_PROXY_LOG
  const sink = logPath
    ? fs.createWriteStream(logPath, { flags: 'a' })
    : { write: (line) => process.stdout.write(line) }
  const log = jsonLineLogger((line) => sink.write(line))
  const proxy = createProxy({
    configPath: env.GURT_PROXY_CONFIG || DEFAULT_CONFIG,
    log,
    watchMs: Number(env.GURT_PROXY_WATCH_MS) || DEFAULT_WATCH_MS
  })
  // The host can also force a reload without waiting for the poll.
  process.on('SIGHUP', () => proxy.reload('sighup'))
  proxy.server.on('error', (e) => log({ kind: 'server', error: errCode(e) }))
  const port = await proxy.listen(
    Number(env.GURT_PROXY_PORT) || DEFAULT_PORT,
    env.GURT_PROXY_BIND || '0.0.0.0'
  )
  log({ kind: 'server', decision: 'listening', port })
  return proxy
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) await main()
