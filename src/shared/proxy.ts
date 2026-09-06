// The host↔proxy contract: the shape of the config file the main process writes
// and the session proxy reads (docs/requirements-mcp-proxy.md §4, §5.3).
//
// The proxy itself is `resources/proxy/gurt-proxy.mjs` — plain JavaScript,
// because it runs inside a stock `node:alpine` with nothing installed, so it
// cannot import these types. They are the specification of the file, not a
// shared implementation, and the two sides are pinned against each other by
// `scripts/proxy-config.test.mjs`, which feeds a config built here to the
// proxy's own parser.
//
// Nothing in this file may import from `node:` — the renderer reads it too.

/** Port the session container reaches the proxy on (MCP + egress, §4.2). */
export const PROXY_PORT = 8100

/** Network alias the proxy answers to on the session's user-defined bridge, so
 *  the container can name it in `HTTP_PROXY` and in an MCP descriptor URL. */
export const PROXY_ALIAS = 'gurt-proxy'

/** Bumped only for a breaking change to `ProxyConfig` — a proxy that does not
 *  recognise the version refuses the file rather than guessing at it. */
export const PROXY_CONFIG_VERSION = 1

/** Where the config file is bind-mounted inside the proxy container. */
export const PROXY_CONFIG_TARGET = '/etc/gurt/proxy.json'

/** Where the proxy script itself is bind-mounted (read-only). */
export const PROXY_SCRIPT_TARGET = '/opt/gurt/proxy.mjs'

/**
 * Egress policy, evaluated on the target a `CONNECT` (or an absolute-form HTTP
 * request) names — never on a path, because gurt does not terminate TLS and so
 * has nothing finer to match on (§6.3).
 *
 * One list, and three rules that fall out of whether it is empty:
 *
 *   1. empty      — everything is allowed except the built-in denylist (§6.4).
 *   2. non-empty  — *only* what it names is allowed, and the built-in denylist
 *                   is not consulted at all.
 *   3. an entry is connected exactly as written: dialled by name through the
 *      normal lookup, with no address vetting and no pinning. A user who does
 *      not trust a name writes the IP literal instead.
 *
 * An entry is `host` or `host:port`; a bare host covers every port. The host
 * half matches the host and its subdomains, an IP literal exactly. The matcher
 * lives in the proxy (`matchesAllowEntry`).
 */
export interface DomainPolicy {
  allow: string[]
}

/** The policy's entries, in the one reading the UI and the proxy share. */
export const explicitAllows = (policy?: DomainPolicy): string[] => policy?.allow ?? []

/** Does this policy name destinations — i.e. is it rule 2 rather than rule 1?
 *  The whole of "effective behaviour", derived from the list and nothing else. */
export const isAllowlisted = (policy?: DomainPolicy): boolean => explicitAllows(policy).length > 0

/** The session's network settings, as the proxy sees them. `internal` is
 *  informational here — it is the *daemon* that enforces it, by giving the
 *  session network no route out; the proxy records it so a log reader can tell
 *  an enforced denial from an observed one. */
export interface ProxyNetwork {
  internal: boolean
  policy: DomainPolicy
}

/**
 * Where one MCP id goes, and what the proxy adds on the way.
 *
 * - `host` — gurt's own per-session listener (`github`, `gurt`), reached at
 *   `host.docker.internal`; the URL already carries the host token, which is
 *   exactly why it may not exist in the session container.
 * - `registry` — a user-configured upstream from `workspace.json`, with its
 *   static headers and, when it links a credential, the resolved auth header.
 *
 * `headers` are sent verbatim and override whatever the container sent under
 * the same name. They are the secret-bearing half of this file.
 */
export type McpUpstream =
  | { kind: 'host'; url: string; headers?: { name: string; value: string }[] }
  | { kind: 'registry'; url: string; headers?: { name: string; value: string }[] }

/**
 * The whole authority of one proxy process. Written 0600 by the host, mounted
 * into the proxy, re-read on change — see `src/main/proxy/config.ts`.
 *
 * `token` names the scope; it is not a claim about it (§5.2). It is minted per
 * session, appears in the MCP descriptor URLs the agent receives, and is never
 * logged.
 */
export interface ProxyConfig {
  version: number
  session: string
  token: string
  /** MCP id → upstream. An id not in here is a 404, logged (§4.3). */
  mcp: Record<string, McpUpstream>
  network: ProxyNetwork
  /** Extra names the proxy should recognise as itself, so an absolute-form
   *  request that ignored `NO_PROXY` is still routed rather than forwarded. */
  selfNames?: string[]
}

/** Base URL the session container reaches the proxy on. */
export const proxyBaseUrl = (host: string = PROXY_ALIAS, port: number = PROXY_PORT): string =>
  `http://${host}:${port}`

/** The MCP route for one id. The token is a path segment, not a header, because
 *  ACP's http descriptor is a URL and the agent must not hold a credential it
 *  could send anywhere else. base64url is URL-safe, so no escaping. */
export const proxyMcpUrl = (token: string, id: string, base: string = proxyBaseUrl()): string =>
  `${base}/mcp/${encodeURIComponent(token)}/${encodeURIComponent(id)}`

/** The default policy: an empty allow list, which is rule 1 — everything
 *  outward permitted and recorded (§6.3). You cannot write an allow list for a
 *  toolchain you have not watched yet.
 *
 *  "Everything" is everything *outward*: the built-in denylist (§6.4) is under
 *  rule 1 and is not part of what the user edits. */
export const DEFAULT_DOMAIN_POLICY: DomainPolicy = { allow: [] }

/**
 * The rule name the proxy logs when the built-in denylist refused an attempt —
 * loopback, link-local (the cloud metadata service lives at 169.254.169.254),
 * the docker host, or an RFC1918 address, whether the agent named it directly
 * or a hostname resolved to it (§6.4).
 *
 * Distinct from `allowlist` on purpose: that one means "your allow list does not
 * name this" and this one means "gurt says no by default, and here is the one
 * way to say yes" — a different sentence in the UI and a different fix.
 */
export const BUILTIN_DENY_REASON = 'builtin-denylist'

/** What the built-in denylist covers, for the UI to say in one line. Kept here
 *  rather than in the picker because the proxy's `BUILTIN_DENIED_*` tables are
 *  what it describes, and the two drift together or not at all. */
export const BUILTIN_DENY_SUMMARY =
  'loopback, link-local (169.254.x, the cloud metadata service), the docker host and private ranges (10.x, 172.16–31.x, 192.168.x)'

/**
 * The same list, itemised, for the UI to *show* rather than summarise: under
 * rule 1 this is the whole of what a session cannot reach, and a user who
 * cannot see it has no way to tell "gurt refused this" from "the network is
 * broken".
 *
 * Read-only for now — a future task adds per-session editing of this list
 * (§6.4, "future work"), which is also the only thing that would let a session
 * keep the open internet *and* reach one of these destinations.
 */
export const BUILTIN_DENY_ENTRIES: readonly { label: string; detail: string }[] = [
  { label: 'loopback', detail: '127.0.0.0/8, 0.0.0.0/8, ::1, ::, localhost (and *.localhost)' },
  { label: 'link-local', detail: '169.254.0.0/16 (the cloud metadata service at 169.254.169.254), fe80::/10' },
  { label: 'the docker host', detail: 'host.docker.internal, gateway.docker.internal, and the host-gateway address' },
  { label: 'private ranges', detail: '10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7' }
]

/** Hosts the agent must reach directly: its own loopback (a proxied request to
 *  127.0.0.1 would arrive at the *proxy's* loopback) and the proxy itself. */
export const NO_PROXY_HOSTS = ['localhost', '127.0.0.1', '::1', PROXY_ALIAS]

/**
 * The proxy variables the agent process is launched with (§4.5).
 *
 * Both spellings of each, because curl and Node disagree about which one they
 * read. `gurt-proxy` resolves through the session network's embedded DNS, which
 * exists only on user-defined networks — one more reason the session container
 * never sits on the default bridge.
 *
 * In the default (non-internal) mode this is **visibility, not enforcement**:
 * the container has its own route out, so a process that ignores these goes
 * straight past the proxy. Only `internal: true` makes the proxy the only way.
 */
export function proxyEnv(base: string = proxyBaseUrl()): Record<string, string> {
  const no = NO_PROXY_HOSTS.join(',')
  return {
    HTTP_PROXY: base,
    http_proxy: base,
    HTTPS_PROXY: base,
    https_proxy: base,
    NO_PROXY: no,
    no_proxy: no
  }
}

/** Most entries an allow list may carry. A policy is a coarse instrument
 *  (§6.3); a list past this length is a mistake, and it rides in the scope file
 *  the proxy re-reads on every change. */
export const MAX_POLICY_DOMAINS = 200

/**
 * One allow-list entry, in the form every comparison is made in: lowercased,
 * de-bracketed, trailing root dot stripped, and — for an entry that carries
 * one — its `:port` kept on the end.
 *
 * The proxy normalizes again on its own side (`parseAllowEntry`), so this is
 * presentation: it makes the session record show what the proxy will match on.
 * `[::1]:8443` keeps its brackets, because that is the only spelling in which a
 * v6 literal and a port can both be read.
 */
export function normalizePolicyEntry(raw: string): string {
  const text = raw.trim().toLowerCase()
  if (!text) return ''
  const bracket = text.startsWith('[') ? text.indexOf(']') + 1 : 0
  const cut = bracket > 0 ? bracket : text.lastIndexOf(':')
  const head = text.slice(0, cut)
  // A bare v6 literal is all colons and carries no port: only a bracketed host,
  // or a colonless one, splits. `::1` is a host, `[::1]:8443` is host and port.
  const splittable = bracket > 0 || (cut > 0 && !head.includes(':'))
  const port = splittable && /^:\d+$/.test(text.slice(cut)) ? text.slice(cut) : ''
  const host = (port ? head : text).replace(/\.+$/, '')
  return host ? `${host}${port}` : ''
}

const entryList = (raw: unknown): string[] => [
  ...new Set(
    (Array.isArray(raw) ? raw : [])
      .filter((d): d is string => typeof d === 'string')
      .map(normalizePolicyEntry)
      .filter(Boolean)
  )
]

/**
 * A domain policy as it arrives from outside the main process — the renderer's
 * form, a stored session record, or (through a drafted session) an agent.
 * Anything unrecognised becomes the default rather than an error: this runs at
 * the IPC boundary, where the safe reading of a policy nobody can parse is "no
 * policy was chosen".
 *
 * Entries are lowercased, deduped and capped here so the session record shows
 * what the proxy will actually match on; the matcher normalizes again on its
 * own side, so this is presentation, not enforcement.
 *
 * **Migration from the three-mode policy.** Sessions stored before the model
 * collapsed to one list carry `{ mode, domains?, alwaysAllow? }`:
 *
 *   - `allowlist` → its `domains` become the allow list, which says the same
 *     thing under rule 2. An *empty* allowlist used to mean deny-all; there is
 *     no state for that any more, so it becomes an empty allow list — i.e.
 *     open, under rule 1. That is a widening, and it is the only reading left:
 *     the new model has no way to spell "nothing at all".
 *   - `allow` / `denylist` → an empty allow list (rule 1, which is what `allow`
 *     already was, and the widest reading of a denylist). **The custom deny
 *     entries are dropped**: the built-in denylist is not user-editable yet, so
 *     there is nowhere to put them, and keeping them would have meant keeping
 *     the mode that gave them meaning.
 *   - `alwaysAllow`, in every mode, is folded into the allow list. It was
 *     already the "connect this exactly as written" list, which is rule 3.
 *
 * Folding `alwaysAllow` into the list is not a no-op for a session that had
 * one under `allow`/`denylist`: it flips that session from rule 1 to rule 2,
 * and it is the only reading that keeps the entries the user wrote.
 */
export function sanitizeDomainPolicy(raw: unknown): DomainPolicy {
  if (!raw || typeof raw !== 'object') return { allow: [] }
  const it = raw as { allow?: unknown; mode?: unknown; domains?: unknown; alwaysAllow?: unknown }
  const listed = it.mode === 'allowlist' ? entryList(it.domains) : []
  const allow = [...new Set([...entryList(it.allow), ...listed, ...entryList(it.alwaysAllow)])]
  return { allow: allow.slice(0, MAX_POLICY_DOMAINS) }
}

// ---------------------------------------------------------------------------
// Observed traffic (§8)
// ---------------------------------------------------------------------------

/**
 * One `host:port` the session's proxy has seen, folded across every attempt at
 * it. The host is the name the container asked for — the proxy resolves it only
 * to vet the address against the built-in denylist (§6.4), and never records a
 * path, a header or a body, so this is the whole of what gurt knows about a
 * connection.
 */
export interface TrafficHost {
  host: string
  port: number
  /** How many times this host:port was seen (allowed or refused, per list). */
  attempts: number
  /** ISO timestamp of the most recent one. */
  last: string
  /** Blocked entries only: which rule refused it (`allowlist`, `denylist`,
   *  {@link BUILTIN_DENY_REASON}) or why there was no rule to consult
   *  (`no-scope`). */
  reason?: string
}

/**
 * What a session's proxy has been seen doing, as the UI reads it.
 *
 * Bounded on both lists and kept for the session's lifetime, not the
 * container's: a session that went idle keeps the blocked hosts that explain
 * why something did not work. `internal` rides along because the same refusal
 * means different things in the two modes — enforced in one, merely recorded in
 * the other (§6.2).
 */
export interface SessionTraffic {
  session: string
  internal: boolean
  /** Refused hosts, most recently seen first — the panel's first surface. */
  blocked: TrafficHost[]
  /** Permitted hosts, most recently seen first. Collapsed in the UI. */
  allowed: TrafficHost[]
  /** Records observed since the app attached to this proxy, including the ones
   *  the two lists dropped when they hit their cap. */
  seen: number
}

/** Empty traffic for a session nothing has been observed for yet — what the
 *  renderer renders before (and instead of) a first record. */
export const emptyTraffic = (session: string, internal = false): SessionTraffic => ({
  session,
  internal,
  blocked: [],
  allowed: [],
  seen: 0
})
