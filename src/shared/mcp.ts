// MCP registry — pure data + validation, shared by main and renderer.
//
// Two sources, one lookup. **Built-ins** (`MCP_DEFS`) are code: they run on the
// *host* (inside gurt's main process) and are reached by the in-container agent
// over HTTP via the session proxy, which keeps host credentials (git ssh key,
// gh login) out of the container. **Registry entries** (`McpRegistryEntry`) are
// user data, configured per workspace in `workspace.json`
// (docs/requirements-mcp-proxy.md §3.1). Both resolve through
// `mcpEntry`/`mcpEntries` so callers can treat an id as an id.
//
// A registry entry comes in one of three `kind`s
// (docs/requirements-mcp-stdio.md §3):
//
//   - `http`    — a remote endpoint the proxy calls. The original shape, and
//                 the default: an entry with no `kind` field *is* an http one,
//                 so every `workspace.json` written before local servers
//                 existed keeps reading without a migration.
//   - `npm`     — a package gurt installs under `~/.gurt/mcp/<id>/` and runs on
//                 the host with gurt's own node, bridged to HTTP.
//   - `command` — any host executable, same bridge. The escape hatch for
//                 everything `npm` does not cover (`uvx`, `docker`, a script).
//
// `npm` and `command` are the **local** kinds: their process runs on the user's
// machine, unsandboxed, with the user's privileges. Nothing about them reaches
// the session container, which still only ever sees a proxy URL and an opaque
// token — but the trust decision they carry is real, and the UI has to say so
// ({@link LOCAL_MCP_NOTICE}).

export interface McpToolInfo {
  name: string
  /** Mutates the repo or its remote — omitted from the agent in read-only mode. */
  write: boolean
  summary: string
}

export interface McpDef {
  id: string
  label: string
  description: string
  /** Tools exposed to the agent; write tools are dropped in read-only mode. */
  tools: McpToolInfo[]
}

export const MCP_DEFS: McpDef[] = [
  {
    id: 'github',
    label: 'github',
    description: 'Pull, push and open pull requests on the host using your system git/gh auth.',
    tools: [
      { name: 'git_pull', write: false, summary: 'Fast-forward pull the current branch' },
      { name: 'git_push', write: true, summary: 'Push the current branch to origin' },
      { name: 'create_pull_request', write: true, summary: 'Open a pull request via gh' }
    ]
  }
]

/**
 * Ids gurt's own servers own, which a registry entry may not take (§3.3). It is
 * the union of `MCP_DEFS` and `gurt` — the turn-contract server is not
 * user-selectable, so it has no `McpDef`, but it shares the route namespace and
 * is reserved all the same.
 */
export const RESERVED_MCP_IDS: readonly string[] = [...MCP_DEFS.map((d) => d.id), 'gurt']

/**
 * What the UI must show against every local entry, verbatim
 * (docs/requirements-mcp-stdio.md §2). It lives here rather than in the picker
 * because it is a property of the model, not of one screen: any surface that
 * offers a local entry is making the same promise about it.
 */
export const LOCAL_MCP_NOTICE = 'Runs on your machine, unsandboxed, with your privileges.'

/** A static header sent upstream verbatim. Never a secret — `workspace.json` is
 *  a plain file the user edits and shares; secrets link via `credentialId`. */
export interface McpHeader {
  name: string
  value: string
}

/** The transport a registry entry uses. Absent on disk ⇒ `http` (§3.1). */
export type McpEntryKind = 'http' | 'npm' | 'command'

/** A remote HTTP MCP endpoint — the original registry shape. */
export interface McpHttpEntry {
  /** Absent means `http`; the normalizer never writes it, so old files stay
   *  byte-identical and there is one canonical spelling of an http entry. */
  kind?: 'http'
  /** Stable id: the session's `McpSelection.id` and the last path segment of
   *  the proxy route. Unique per workspace, and never a reserved id. */
  id: string
  /** Display name; falls back to the id when blank (see {@link mcpLabel}). */
  label?: string
  /** Absolute http(s) URL of the upstream MCP endpoint. */
  url: string
  headers?: McpHeader[]
  /** Link into credentials.json (a `CredentialEntry.id`), never a secret.
   *  Resolved into a header at the proxy — see `resolveMcpCredential`. */
  credentialId?: string
}

/** What the two local kinds share. */
interface McpLocalBase {
  id: string
  label?: string
  /** Extra argv after the package/command, verbatim. A local server's
   *  read-only mode, if it has one, is a flag in here — gurt does not know an
   *  upstream's tool semantics and never claims to enforce one (§3.3). */
  args?: string[]
  /** Environment for the child process, merged over gurt's own. Plain
   *  `workspace.json` data, so never a secret — those link via
   *  `credentialId`. */
  env?: Record<string, string>
  /** Link into credentials.json. Unlike an http entry, a local one resolves it
   *  into an **environment variable** named by {@link credentialEnvVar} —
   *  a stdio server has no request headers to put it in. */
  credentialId?: string
  /** Which env var the linked credential is injected as (`LINEAR_API_KEY`,
   *  `GITHUB_TOKEN`, …). Required whenever `credentialId` is set: only the
   *  user knows what the server reads, and guessing would silently not work. */
  credentialEnvVar?: string
}

/** An npm package gurt installs and runs itself (§4.2). */
export interface McpNpmEntry extends McpLocalBase {
  kind: 'npm'
  /** Bare package name, scope included — never `name@version`. */
  package: string
  /** npm version or dist-tag. Absent ⇒ whatever `npm install <name>` resolves
   *  to at install time, pinned from then on: gurt reinstalls only when this
   *  field changes, so `latest` does not mean "hit the network every start". */
  version?: string
}

/** Any host executable, run the same way (§4.3). */
export interface McpCommandEntry extends McpLocalBase {
  kind: 'command'
  /** A bare name resolved against the host PATH, or an absolute path. Resolved
   *  when the entry is *saved*, not when a session starts. */
  command: string
  cwd?: string
}

/** The kinds whose process runs on the host. */
export type McpLocalEntry = McpNpmEntry | McpCommandEntry

/** One user-configured MCP server (`WorkspaceFile.mcpServers`). */
export type McpRegistryEntry = McpHttpEntry | McpLocalEntry

/** A built-in and a registry entry, in the one shape callers consume. */
export type McpEntry =
  | { source: 'builtin'; id: string; label: string; description: string; def: McpDef }
  | {
      source: 'registry'
      id: string
      label: string
      description: string
      entry: McpRegistryEntry
    }

/** Display name of a registry entry: its label, or its id when unlabelled. */
export const mcpLabel = (entry: McpRegistryEntry): string => entry.label?.trim() || entry.id

/** Which transport an entry (or a half-filled draft) declares. */
export const mcpEntryKind = (entry: { kind?: McpEntryKind | undefined }): McpEntryKind =>
  entry.kind ?? 'http'

/** Whether this entry's process runs on the host — the one predicate the
 *  routing (`planProxy`), the runtime (`mcp/manager.ts`) and the UI all branch
 *  on, so "local" has exactly one definition. */
export const isLocalMcpEntry = (entry: McpRegistryEntry): entry is McpLocalEntry =>
  mcpEntryKind(entry) !== 'http'

/** The narrowing complement, for callers that only handle a remote endpoint. */
export const isHttpMcpEntry = (entry: McpRegistryEntry): entry is McpHttpEntry =>
  mcpEntryKind(entry) === 'http'

/** `name@version` when the entry pins one, else the bare name — the argument
 *  `npm install` is given, and the identity gurt compares against what is
 *  already installed. */
export const npmPackageSpec = (entry: McpNpmEntry): string =>
  entry.version ? `${entry.package}@${entry.version}` : entry.package

/**
 * One line describing what an entry actually points at: the URL for a remote
 * one, the argv for a local one. This is what the picker, the settings list and
 * `McpEntry.description` all show — a local entry whose row said only its
 * label would hide the very thing a user has to judge before selecting it.
 *
 * Never includes `env`: those values are the user's, and a settings list is not
 * where a pasted token should surface.
 */
export function mcpEntryDetail(entry: McpRegistryEntry): string {
  if (isHttpMcpEntry(entry)) return entry.url
  const head = entry.kind === 'npm' ? npmPackageSpec(entry) : entry.command
  return [head, ...(entry.args ?? [])].join(' ')
}

/** Built-in def by id — the host-server path (`mcp/manager.ts`) resolves these
 *  plus the registry's local entries; a remote entry is reached through the
 *  proxy, not a host server. */
export const mcpDef = (id: string): McpDef | undefined => MCP_DEFS.find((m) => m.id === id)

const builtinEntry = (def: McpDef): McpEntry => ({
  source: 'builtin',
  id: def.id,
  label: def.label,
  description: def.description,
  def
})

const registryEntry = (entry: McpRegistryEntry): McpEntry => ({
  source: 'registry',
  id: entry.id,
  label: mcpLabel(entry),
  description: mcpEntryDetail(entry),
  entry
})

/** Every MCP server a workspace can offer: built-ins first, then its registry.
 *  Built-ins win on an id collision — the store rejects one, but a hand-edited
 *  workspace.json must not be able to shadow gurt's own servers.
 *
 *  `defs` is a seam for the renderer, which learns the built-ins over IPC
 *  (`getMcpDefs`) rather than from this module's constant, so a picker built in
 *  the renderer offers exactly what main says it can serve. Main passes nothing
 *  and gets `MCP_DEFS`. Reserved ids stay reserved either way. */
export function mcpEntries(
  registry: readonly McpRegistryEntry[] = [],
  defs: readonly McpDef[] = MCP_DEFS
): McpEntry[] {
  const out = defs.map(builtinEntry)
  const taken = new Set([...RESERVED_MCP_IDS, ...defs.map((d) => d.id)])
  for (const entry of registry) {
    if (taken.has(entry.id)) continue
    taken.add(entry.id)
    out.push(registryEntry(entry))
  }
  return out
}

/** Resolve one id against both sources (built-in wins). */
export function mcpEntry(
  id: string,
  registry: readonly McpRegistryEntry[] = [],
  defs: readonly McpDef[] = MCP_DEFS
): McpEntry | undefined {
  return mcpEntries(registry, defs).find((e) => e.id === id)
}

/**
 * Whether the picker offers `read-only`/`full` for this entry (§3.3). Only
 * built-ins: gurt knows statically which of *its* tools write
 * (`McpToolInfo.write`) and knows nothing about an upstream's tools, so
 * offering read-only for a registry entry would claim an enforcement it does
 * not have. That holds for a local entry exactly as it holds for a remote one —
 * gurt spawning the process does not make it understand the process's tools;
 * a local server's own read-only flag lives in `args`, where the user put it.
 * Registry entries are off or on.
 *
 * The probe (§4.6) does not change this. It ends with a real `tools/list`, so
 * gurt does hold an upstream's tool *names* for as long as a dialog is open —
 * and a name is not a semantics. `readOnlyHint` is a hint the server writes
 * about itself, unverifiable and optional; a list of names says nothing about
 * which of them writes. The probe's list is there to be read by a person, not
 * to unlock a mode.
 */
export const mcpHasModes = (entry: McpEntry): boolean => entry.source === 'builtin'

/** One tool a probe saw, in the only two fields a server is obliged to give.
 *  Deliberately not `McpToolInfo`: that shape carries `write`, which gurt knows
 *  for its own built-ins and cannot know for anybody else's server. */
export interface McpProbedTool {
  name: string
  /** The server's own one-line description, trimmed; absent when it gives none. */
  summary?: string
}

/**
 * One line of a probe's transcript (§4.6), in the order it happened.
 *
 * `npm`, `stdout` and `stderr` are the third-party process's own output —
 * external, not gurt's record of anything. `gurt` lines are gurt's account of
 * what it did around them: the argv it spawned, the variable *names* a launch
 * added, the MCP calls it made, how the process ended.
 */
export interface McpProbeLine {
  /** Milliseconds since the probe started. "What preceded what" is the question
   *  a transcript exists to answer, so every line is placed on one clock. */
  at: number
  stream: 'gurt' | 'npm' | 'stdout' | 'stderr'
  line: string
}

/**
 * What "start it and see" found (§4.6) — the result of actually launching an
 * entry, speaking MCP to it and stopping it again.
 *
 * Never carries a secret: the credential is resolved into the child's
 * environment and nothing on this object comes from there.
 */
export interface McpProbeResult {
  /** Whether the server came up and completed the MCP handshake. */
  ok: boolean
  /** Which transport was probed — what the result means differs per kind, and
   *  the UI's caveat with it. */
  kind: McpEntryKind
  /** Why it did not come up, as a sentence written for the user. Set only when
   *  `ok` is false. */
  error?: string
  /** `serverInfo` from the handshake (`name version`), when the server sent one. */
  server?: string
  /** What `tools/list` returned. Absent when the probe did not ask — an `http`
   *  entry is only handshaken (§4.6) — or when the call failed. */
  tools?: McpProbedTool[]
  /** Why there is no tool list although the handshake worked. */
  toolsError?: string
  /**
   * How the launch went, oldest first — what was installed, what was spawned,
   * what the process printed, what MCP was asked and how it ended.
   *
   * Present on success too: "what did it actually run" is worth reading when
   * the answer was yes. It is **displayed and not logged**: the process's own
   * output is external, and gurt keeps no file of it beyond the `mcp.out` DBG
   * lines it already wrote (§4.6).
   */
  transcript?: McpProbeLine[]
}

/** One entry of a session's MCP selection, paired with what its id resolves to
 *  *now*. `entry: undefined` is the id that has gone away — a registry entry
 *  deleted out from under a saved selection, or a built-in this build dropped. */
export interface ResolvedMcpSelection<S extends { id: string }> {
  selection: S
  entry: McpEntry | undefined
}

/**
 * Pair a session's stored selection with the entries it names, in the user's
 * order, first occurrence of an id winning (the same de-duplication `planProxy`
 * applies to the scope it builds).
 *
 * A missing id is *kept*, not dropped: the selection is the session's record of
 * what the user asked for, and a picker that silently swallowed a deleted id
 * would re-save the session without it. Every consumer — the composer's rows,
 * the session chips, the scope builders — decides for itself what to do with an
 * unresolvable one, but they all see it.
 *
 * Takes the offered `entries` rather than the registry, so a caller that
 * already has them (the renderer's `useMcpEntries`) does not rebuild the union
 * per session; `mcpEntries(registry)` is the one for a caller that does not.
 *
 * Generic over the element so this module keeps the domain model
 * (`McpSelection`, src/shared/types.ts) at arm's length; that file imports this
 * one, not the other way round.
 */
export function resolveMcpSelection<S extends { id: string }>(
  selection: readonly S[] | undefined,
  entries: readonly McpEntry[]
): ResolvedMcpSelection<S>[] {
  const seen = new Set<string>()
  const out: ResolvedMcpSelection<S>[] = []
  for (const sel of selection ?? []) {
    if (seen.has(sel.id)) continue
    seen.add(sel.id)
    out.push({ selection: sel, entry: entries.find((e) => e.id === sel.id) })
  }
  return out
}

/** Ids are route segments and selection keys: lowercase, no separators. */
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/
/** RFC 9110 field-name (`token`). */
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
/** POSIX-portable environment variable name — what a shell, and `execve`, will
 *  carry without argument. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Whether a string may be sent as a header name. Node throws
 *  `ERR_INVALID_HTTP_TOKEN` on anything else, synchronously, at the moment the
 *  request is built. */
export const isHeaderName = (name: string): boolean => HEADER_NAME_RE.test(name)

/** Whether a string may name an environment variable — the local kinds' answer
 *  to {@link isHeaderName}. */
export const isEnvName = (name: string): boolean => ENV_NAME_RE.test(name)

/** What node's http layer accepts in a header value: tab plus printable, high
 *  bytes included. Anything else raises `ERR_INVALID_CHAR` when the request is
 *  constructed — inside a request listener, where an unhandled throw is the
 *  whole proxy process. */
const HEADER_VALUE_BAD_RE = /[^\t\x20-\x7e\x80-\xff]/

/**
 * null = the value can be sent as a header. Otherwise a phrase naming the
 * problem, for a caller to prefix with whatever it is validating — `header
 * "X-Api-Key" contains a newline`, `credential "linear" contains a newline`.
 *
 * A newline is the one that matters twice over: it is what a paste carries, and
 * it is what would inject a second header at the proxy rather than merely fail.
 */
export function headerValueProblem(value: string): string | null {
  if (/[\r\n]/.test(value)) return 'contains a newline'
  if (value.includes('\0')) return 'contains a NUL byte'
  if (HEADER_VALUE_BAD_RE.test(value)) return 'contains a control character'
  return null
}

/** The id half of the validator, shared by every kind — an id is a route
 *  segment and a selection key whatever transport sits behind it. */
function idProblem(rawId: string | undefined, takenIds: readonly string[]): string | null {
  const id = rawId?.trim() ?? ''
  if (!id) return 'id must not be empty'
  if (!ID_RE.test(id))
    return `id "${id}" must be lowercase letters, digits, ".", "-" or "_", starting alphanumeric`
  if (RESERVED_MCP_IDS.includes(id)) return `id "${id}" is reserved by a built-in MCP server`
  if (takenIds.includes(id)) return `id "${id}" is already used by another MCP server`
  return null
}

/** The http half: an http(s) URL and well-formed headers. */
function httpProblem(entry: McpHttpEntryDraft): string | null {
  const raw = entry.url?.trim() ?? ''
  if (!raw) return 'url must not be empty'
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return `url "${raw}" is not a valid URL`
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return `url must be http(s) — "${url.protocol}//" is not supported for a remote server; a local process is a "npm" or "command" entry`
  if (!url.hostname) return 'url must have a host'

  const seen = new Set<string>()
  for (const header of entry.headers ?? []) {
    const name = header?.name?.trim() ?? ''
    if (!name) return 'header name must not be empty'
    if (!isHeaderName(name)) return `"${name}" is not a valid header name`
    const key = name.toLowerCase()
    if (seen.has(key)) return `duplicate header "${name}"`
    seen.add(key)
    // A newline in either half would inject a second header at the proxy.
    const bad = headerValueProblem(header.value ?? '')
    if (bad) return `header "${name}" ${bad}`
  }
  return null
}

/** argv is `execve`'s, so the one thing it cannot carry is a NUL. Typed as
 *  `unknown` because a hand-edited workspace.json and an IPC caller both reach
 *  this before any parser has vouched for the shape. */
function argsProblem(args: unknown): string | null {
  if (args === undefined) return null
  if (!Array.isArray(args)) return 'args must be an array of strings'
  for (const arg of args as unknown[]) {
    if (typeof arg !== 'string') return 'args must be an array of strings'
    if (arg.includes('\0')) return 'an argument contains a NUL byte'
  }
  return null
}

function envProblem(env: unknown): string | null {
  if (env === undefined) return null
  if (typeof env !== 'object' || env === null || Array.isArray(env))
    return 'env must be an object of NAME to value'
  for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
    if (!isEnvName(name)) return `"${name}" is not a valid environment variable name`
    if (typeof value !== 'string') return `env "${name}" must be a string`
    if (value.includes('\0')) return `env "${name}" contains a NUL byte`
  }
  return null
}

/** The local half: what the two process-spawning kinds need, and the credential
 *  link's extra obligation (an env var name, since there is no header). */
function localProblem(entry: McpLocalEntryDraft, kind: 'npm' | 'command'): string | null {
  if (kind === 'npm') {
    const pkg = (entry as McpNpmEntryDraft).package?.trim() ?? ''
    if (!pkg) return 'package must not be empty'
    if (/\s/.test(pkg)) return `package "${pkg}" must not contain whitespace`
    const version = (entry as McpNpmEntryDraft).version?.trim()
    // A scope's leading "@" is part of the name; any later one is a version,
    // and a version belongs in its own field or the reinstall check cannot see
    // it change. None of that applies to a `github:`/`git+`/`file:` spec, whose
    // `@` is part of a URL and whose ref rides in the spec itself.
    if (isPlainPackageName(pkg)) {
      if (pkg.lastIndexOf('@') > 0)
        return `package "${pkg}" must not carry a version — put it in the version field`
    } else if (version) {
      return `package "${pkg}" already says which revision to install — leave the version field empty`
    }
    if (version !== undefined && version !== '' && /\s/.test(version))
      return `version "${version}" must not contain whitespace`
  } else {
    const command = (entry as McpCommandEntryDraft).command?.trim() ?? ''
    if (!command) return 'command must not be empty'
    if (command.includes('\0')) return 'command contains a NUL byte'
    const cwd = (entry as McpCommandEntryDraft).cwd
    if (cwd !== undefined && typeof cwd !== 'string') return 'cwd must be a string'
  }
  const args = argsProblem(entry.args)
  if (args) return args
  const env = envProblem(entry.env)
  if (env) return env

  const envVar = entry.credentialEnvVar?.trim() ?? ''
  if (envVar && !isEnvName(envVar))
    return `"${envVar}" is not a valid environment variable name`
  // A stdio server reads its token from the environment, and only the server's
  // own docs say which variable. Linking a credential without naming one would
  // resolve the secret and then drop it.
  if (entry.credentialId && !envVar)
    return 'a linked credential needs credentialEnvVar — the environment variable the server reads it from'
  return null
}

/**
 * null = ok. Everything checkable without the credential store: id shape,
 * reserved and taken ids, and then whatever the entry's `kind` requires — an
 * http(s) URL and well-formed headers, or a package/command with argv and
 * environment gurt can actually spawn. The credential link is checked
 * separately (`resolveMcpCredential` / `resolveMcpEnvSecret`) because only main
 * holds the secrets store, and a `command` entry's *resolvability* is checked
 * in main too (only main knows the host PATH).
 *
 * `takenIds` are the *other* entries' ids — an update passes the registry minus
 * the entry being saved.
 */
export function validateMcpEntry(
  entry: McpEntryDraft,
  { takenIds = [] }: { takenIds?: readonly string[] } = {}
): string | null {
  const bad = idProblem(entry.id, takenIds)
  if (bad) return bad
  const kind: unknown = (entry as { kind?: unknown }).kind ?? 'http'
  if (kind === 'http') return httpProblem(entry as McpHttpEntryDraft)
  if (kind === 'npm' || kind === 'command')
    return localProblem(entry as McpLocalEntryDraft, kind)
  return `kind ${JSON.stringify(kind)} is not one of http, npm, command`
}

/** What a caller may hand `normalizeMcpEntry`: a parsed on-disk record or a
 *  half-filled editor draft, where an optional field may be explicitly
 *  `undefined` rather than absent. */
export interface McpHttpEntryDraft {
  kind?: 'http' | undefined
  id: string
  label?: string | undefined
  url: string
  headers?: readonly McpHeader[] | undefined
  credentialId?: string | undefined
}

interface McpLocalDraftBase {
  id: string
  label?: string | undefined
  args?: readonly string[] | undefined
  env?: Readonly<Record<string, string>> | undefined
  credentialId?: string | undefined
  credentialEnvVar?: string | undefined
}

export interface McpNpmEntryDraft extends McpLocalDraftBase {
  kind: 'npm'
  package: string
  version?: string | undefined
}

export interface McpCommandEntryDraft extends McpLocalDraftBase {
  kind: 'command'
  command: string
  cwd?: string | undefined
}

export type McpLocalEntryDraft = McpNpmEntryDraft | McpCommandEntryDraft
export type McpEntryDraft = McpHttpEntryDraft | McpLocalEntryDraft

/** Trimmed names, non-string values dropped, absent when nothing survives. */
function normalizeEnv(
  env: Readonly<Record<string, string>> | undefined
): Record<string, string> | undefined {
  if (!env) return undefined
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    const key = name.trim()
    if (!key || typeof value !== 'string') continue
    out[key] = value
  }
  return Object.keys(out).length ? out : undefined
}

/** Normal form for the store: trimmed, empty optionals dropped, and — for an
 *  http entry — no `kind` field at all, so the canonical spelling on disk is
 *  the one every pre-existing `workspace.json` already uses. */
export function normalizeMcpEntry(entry: McpEntryDraft): McpRegistryEntry {
  const label = entry.label?.trim() ?? ''
  const base = { id: entry.id.trim(), ...(label ? { label } : {}) }
  const kind = mcpEntryKind(entry)

  if (kind === 'http') {
    const http = entry as McpHttpEntryDraft
    const headers = (http.headers ?? [])
      .map((h) => ({ name: h.name.trim(), value: h.value ?? '' }))
      .filter((h) => h.name)
    return {
      ...base,
      url: http.url?.trim() ?? '',
      ...(headers.length ? { headers } : {}),
      ...(http.credentialId ? { credentialId: http.credentialId } : {})
    }
  }

  const local = entry as McpLocalEntryDraft
  const args = (local.args ?? []).filter((a) => typeof a === 'string')
  const env = normalizeEnv(local.env)
  const credentialEnvVar = local.credentialEnvVar?.trim() ?? ''
  const tail = {
    ...(args.length ? { args: [...args] } : {}),
    ...(env ? { env } : {}),
    ...(local.credentialId ? { credentialId: local.credentialId } : {}),
    ...(credentialEnvVar ? { credentialEnvVar } : {})
  }

  if (local.kind === 'npm') {
    const version = local.version?.trim() ?? ''
    return {
      kind: 'npm',
      ...base,
      package: local.package?.trim() ?? '',
      ...(version ? { version } : {}),
      ...tail
    }
  }
  const cwd = local.cwd?.trim() ?? ''
  return {
    kind: 'command',
    ...base,
    command: local.command?.trim() ?? '',
    ...(cwd ? { cwd } : {}),
    ...tail
  }
}

// --- pasting a snippet (docs/requirements-mcp-stdio.md §5) -------------------

/**
 * The whole MCP ecosystem publishes itself as the same JSON blob, and a user
 * who has one in the clipboard should not have to retype it into six fields.
 * {@link parseMcpSnippet} is the pure half of that: snippet in, registry entry
 * out, and the UI (phase 2) does nothing but call it and show the result.
 *
 * `{ entry }` or `{ error }`, in the style of `resolveMcpCredential` — never a
 * throw, because the caller is a keystroke handler.
 */
export interface McpSnippetResult {
  entry?: McpRegistryEntry
  error?: string
}

/** npx flags that take no value of their own, so the package spec is whatever
 *  follows them. Anything else before the spec means gurt cannot read the
 *  invocation, and it says so rather than guessing (see {@link parseMcpSnippet}). */
const NPX_VALUELESS_FLAGS = new Set(['-y', '--yes', '-q', '--quiet', '--silent', '--no-install'])

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Squeeze any name into an id: lowercased, an npm scope's leading `@` dropped,
 * every character `ID_RE` refuses collapsed to `-`. Exported because the same
 * derivation has to run on the snippet's key *and* on a fallback name, and a
 * caller that wants to pre-fill an id field needs it too.
 */
export function mcpIdFromName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[-._]+$/, '')
}

/**
 * Whether this is a *plain* npm name (`pkg`, `@scope/pkg`) rather than one of
 * the other things `npm install` accepts in the same position —
 * `github:user/repo`, `git+ssh://git@host/repo.git`, `file:../x`, a tarball
 * URL. The `:` is what all of those have and no package name may have.
 *
 * The difference matters three times, and every one of them was a bug before
 * this predicate existed: `git+ssh://git@host/...` must not be split on its
 * `@` into a bogus version; the validator's "no version in the name" rule is
 * about that same `@`; and — the one that actually bites — **the spec is not
 * the installed name**. `npm install github:user/repo` puts the tree under the
 * package's own name from its `package.json`, so nothing may look for it under
 * the spec afterwards (see `ensureNpmPackage`).
 */
export const isPlainPackageName = (pkg: string): boolean => !pkg.includes(':')

/** `@scope/pkg@1.2.3` → name + version; `@scope/pkg` and `pkg` → name only.
 *  The scope's `@` is at index 0, so only a later one separates a version —
 *  and a spec that is not a plain name has no version half at all, however
 *  many `@` it carries. */
export function splitPackageSpec(spec: string): { name: string; version: string } {
  if (!isPlainPackageName(spec)) return { name: spec, version: '' }
  const at = spec.lastIndexOf('@')
  if (at > 0) return { name: spec.slice(0, at), version: spec.slice(at + 1) }
  return { name: spec, version: '' }
}

/** Something id-shaped out of a repo or URL spec: its last path segment, minus
 *  a `#ref`, a `.git` and a tarball extension. The package's real name is
 *  inside the package, and gurt cannot read it without installing — but
 *  `github-user-jenkins-mcp` as an id is worse than the segment that is right
 *  nearly every time and sits in an editable field. */
function packageSpecTail(spec: string): string {
  const bare = spec.split('#')[0]!.replace(/\.(tgz|tar\.gz)$/i, '').replace(/\.git$/i, '')
  return bare.split('/').filter(Boolean).pop() || spec
}

/** `/usr/local/bin/npx`, `npx.cmd` and `npx` are all npx. */
const commandName = (command: string): string =>
  command
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(cmd|exe|bat)$/i, '')

/** The package spec an `npx` invocation runs, plus the args that follow it. */
function npxPackage(args: readonly string[]): { spec?: string; rest?: string[]; error?: string } {
  const rest = [...args]
  while (rest.length && NPX_VALUELESS_FLAGS.has(rest[0]!)) rest.shift()
  const spec = rest.shift()
  if (!spec || spec.startsWith('-'))
    return {
      error:
        'could not tell which package this npx command runs — save it as a "command" entry instead'
    }
  return { spec, rest }
}

/** `{"Authorization": "Bearer x"}` → the registry's name/value rows. */
function snippetHeaders(raw: unknown): { list?: McpHeader[]; error?: string } {
  if (raw === undefined) return { list: [] }
  if (!isRecord(raw)) return { error: '"headers" must be an object of name to value' }
  const list: McpHeader[] = []
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'string') return { error: `header "${name}" must be a string` }
    list.push({ name, value })
  }
  return { list }
}

function snippetStrings(raw: unknown, field: string): { list?: string[]; error?: string } {
  if (raw === undefined) return { list: [] }
  if (!Array.isArray(raw)) return { error: `"${field}" must be an array of strings` }
  for (const item of raw as unknown[])
    if (typeof item !== 'string') return { error: `"${field}" must be an array of strings` }
  return { list: [...(raw as string[])] }
}

function snippetEnv(raw: unknown): { env?: Record<string, string>; error?: string } {
  if (raw === undefined) return {}
  if (!isRecord(raw)) return { error: '"env" must be an object of NAME to value' }
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'string') return { error: `env "${name}" must be a string` }
    env[name] = value
  }
  return { env }
}

/** One server body (the value under its id) → a registry entry. */
function entryFromSnippetBody(rawId: string, body: Record<string, unknown>): McpSnippetResult {
  const url = typeof body['url'] === 'string' ? body['url'].trim() : ''
  const command = typeof body['command'] === 'string' ? body['command'].trim() : ''
  if (url && command) return { error: 'a server has "url" or "command", never both' }

  if (url) {
    const headers = snippetHeaders(body['headers'])
    if (headers.error) return { error: headers.error }
    // A bare body carries no id, so fall back to the endpoint's host — a name
    // the user recognises, and one `ID_RE` already accepts as written.
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {
      /* validateMcpEntry reports the bad URL below, with the URL in it */
    }
    const id = mcpIdFromName(rawId || host)
    if (!id) return { error: `could not derive an id from "${rawId || url}"` }
    return finish(normalizeMcpEntry({ id, url, headers: headers.list! }))
  }

  if (!command)
    return { error: 'a server needs "url" (a remote endpoint) or "command" (a local process)' }

  const args = snippetStrings(body['args'], 'args')
  if (args.error) return { error: args.error }
  const env = snippetEnv(body['env'])
  if (env.error) return { error: env.error }
  const cwd = typeof body['cwd'] === 'string' ? body['cwd'] : undefined

  if (commandName(command) === 'npx') {
    const pkg = npxPackage(args.list!)
    if (pkg.error) return { error: pkg.error }
    const { name, version } = splitPackageSpec(pkg.spec!)
    // `npx -y github:user/jenkins-mcp` is a real snippet shape, and squeezing
    // the whole spec into an id gives `github-user-jenkins-mcp`. The tail is
    // what the user would have typed.
    const from = rawId || (isPlainPackageName(name) ? name : packageSpecTail(name))
    const id = mcpIdFromName(from)
    if (!id) return { error: `could not derive an id from "${from}"` }
    return finish(
      normalizeMcpEntry({
        kind: 'npm',
        id,
        package: name,
        ...(version ? { version } : {}),
        args: pkg.rest!,
        ...(env.env ? { env: env.env } : {})
      })
    )
  }

  const id = mcpIdFromName(rawId || commandName(command))
  if (!id) return { error: `could not derive an id from "${rawId || command}"` }
  return finish(
    normalizeMcpEntry({
      kind: 'command',
      id,
      command,
      args: args.list!,
      ...(env.env ? { env: env.env } : {}),
      ...(cwd ? { cwd } : {})
    })
  )
}

/** Run the entry past the same validator the store runs, so a snippet that
 *  parsed but cannot be saved fails at the paste rather than at the save. */
function finish(entry: McpRegistryEntry): McpSnippetResult {
  const invalid = validateMcpEntry(entry)
  return invalid ? { error: invalid } : { entry }
}

/**
 * Turn a published MCP snippet into a registry entry.
 *
 * Accepts, in the shapes the ecosystem actually ships:
 *
 *   - `{"mcpServers": {"<id>": {…}}}` — Claude Desktop, Cursor, most READMEs;
 *   - `{"servers": {"<id>": {…}}}` — VS Code's `mcp.json`;
 *   - `{"<id>": {…}}` — the inner object on its own;
 *   - `{"command": …}` / `{"url": …}` — one server body with no id at all, in
 *     which case the id is derived from the package, command or host.
 *
 * A body with `url` is an `http` entry. A body with `command` is `npm` when the
 * command is npx and gurt can see which package it runs — `npx -y pkg@1.2 --ro`
 * becomes `{kind:'npm', package:'pkg', version:'1.2', args:['--ro']}`, because
 * that is the form gurt can install once and run with its own node (§4.2).
 * Everything else (`uvx`, `docker`, `node`, a script) becomes `command`, which
 * runs the same way it would have anywhere else.
 *
 * `env` rides through verbatim: it is the snippet's, and workspace.json is a
 * plain file. A snippet whose `env` carries a real token should have it moved
 * to a credential link afterwards — the UI's job, not this function's.
 *
 * A string input is JSON-parsed; anything else is taken as already parsed.
 * Multiple servers in one snippet is an error rather than a silent first-wins:
 * they have separate ids, separate credentials and separate trust decisions.
 */
export function parseMcpSnippet(input: unknown): McpSnippetResult {
  let value = input
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return { error: 'paste a server snippet first' }
    try {
      value = JSON.parse(text)
    } catch (e) {
      return { error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  if (!isRecord(value)) return { error: 'a snippet is a JSON object' }

  const wrapper = isRecord(value['mcpServers'])
    ? value['mcpServers']
    : isRecord(value['servers'])
      ? value['servers']
      : null
  const map = wrapper ?? value

  // A body on its own: no id to key it by, and its own fields say what it is.
  if (!wrapper && (typeof map['command'] === 'string' || typeof map['url'] === 'string'))
    return entryFromSnippetBody('', map)

  const ids = Object.keys(map)
  if (!ids.length) return { error: 'the snippet names no server' }
  if (ids.length > 1)
    return {
      error: `the snippet names ${ids.length} servers (${ids.join(', ')}) — add them one at a time`
    }
  const id = ids[0]!
  const body = map[id]
  if (!isRecord(body))
    return {
      error: wrapper
        ? `server "${id}" is not an object`
        : 'expected {"<id>": {…}} or {"mcpServers": {"<id>": {…}}}'
    }
  return entryFromSnippetBody(id, body)
}

// --- a local server that did not start (docs/requirements-mcp-stdio.md §8.2) -

/**
 * One local server a session selected and did not get. Produced by
 * `mcp/manager.ts`, carried on the bus as `mcp.fail`, rendered in the session
 * pane — which is why it lives here rather than in either end.
 *
 * `err` is the reason and nothing else. The child's environment is where a
 * local entry's credential lands (§3.4) and is never logged, never carried and
 * never shown (§7).
 */
export interface McpFailure {
  id: string
  kind: McpEntryKind
  err: string
}

/** Every local server one session asked for and did not get — the whole set,
 *  not a delta, so an empty `failures` is how a session that has recovered
 *  clears the last one (the shape `proxy.traffic` uses, for the same reason). */
export interface SessionMcpFailures {
  sessionId: string
  failures: McpFailure[]
}

// --- what the editor needs, kept pure (docs/requirements-mcp-stdio.md §8.2) --

/** One environment entry as the editor holds it: ordered, and editable while
 *  its name is still blank. `env` on disk is a record, which has neither
 *  property. */
export interface McpEnvRow {
  name: string
  value: string
}

/** A local entry's `env` as rows to edit, in insertion order — which is the
 *  order a pasted snippet listed them in. */
export const mcpEnvRows = (env: Readonly<Record<string, string>> | undefined): McpEnvRow[] =>
  Object.entries(env ?? {}).map(([name, value]) => ({ name, value }))

/** Rows back to a record: names trimmed, blank rows dropped, the last of a
 *  repeated name winning — the same collapse `normalizeMcpEntry` would do,
 *  done early so what the editor validates is what it saves. */
export function mcpEnvRecord(rows: readonly McpEnvRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const name = row.name.trim()
    if (name) out[name] = row.value
  }
  return out
}

/** Names a README fills in with a real secret. Substring, not exact: the
 *  ecosystem spells it `GITHUB_TOKEN`, `API_KEY`, `SLACK_BOT_TOKEN`,
 *  `NOTION_API_SECRET`, `DB_PASSWORD`. */
const SECRET_ENV_NAME_RE = /TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|_KEY$|^KEY$|CREDENTIAL/i
/** The value a README puts there *instead* of a secret: `<your token>`,
 *  `YOUR_API_KEY_HERE`, `xxxxxxxx`, `…`. Storing one of those in the credential
 *  store would be storing a placeholder as if it were a key. */
const PLACEHOLDER_VALUE_RE = /^(<.*>|\{.*\}|\[.*\]|x+|\.+|…+|-+|your[-_ ].*|.*[-_ ]here)$/i

/**
 * Whether this `env` pair looks like a secret a user pasted out of a README, and
 * so should be offered a credential link rather than a resting place in
 * `workspace.json` (§5). A heuristic, and deliberately a loud one: a false
 * positive costs one dismissed suggestion, a false negative is a token in a file
 * meant to be shared and committed.
 *
 * A placeholder value is *not* a secret — there is nothing to store, and "keep
 * `<your token>` in the credential store" is worse advice than none.
 */
export function looksLikeSecretEnv(name: string, value: string): boolean {
  const v = value.trim()
  if (v.length < 8) return false
  if (PLACEHOLDER_VALUE_RE.test(v)) return false
  return SECRET_ENV_NAME_RE.test(name)
}
