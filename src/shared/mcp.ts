// MCP registry — pure data + validation, shared by main and renderer.
//
// Two sources, one lookup. **Built-ins** (`MCP_DEFS`) are code: they run on the
// *host* (inside gurt's main process) and are reached by the in-container agent
// over HTTP via `host.docker.internal`, which keeps host credentials (git ssh
// key, gh login) out of the container. **Registry entries**
// (`McpRegistryEntry`) are user data: remote HTTP MCP endpoints configured per
// workspace in `workspace.json` (docs/requirements-mcp-proxy.md §3.1). Both
// resolve through `mcpEntry`/`mcpEntries` so callers can treat an id as an id.
//
// HTTP transport only: no stdio, no local process (§14).

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

/** A static header sent upstream verbatim. Never a secret — `workspace.json` is
 *  a plain file the user edits and shares; secrets link via `credentialId`. */
export interface McpHeader {
  name: string
  value: string
}

/** One user-configured HTTP MCP server (`WorkspaceFile.mcpServers`). */
export interface McpRegistryEntry {
  /** Stable id: the session's `McpSelection.id` and the last path segment of
   *  the proxy route. Unique per workspace, and never a reserved id. */
  id: string
  /** Display name; falls back to the id when blank (see {@link mcpLabel}). */
  label?: string
  /** Absolute http(s) URL of the upstream MCP endpoint. */
  url: string
  headers?: McpHeader[]
  /** Link into credentials.json (a `CredentialEntry.id`), never a secret.
   *  Resolved and injected at the proxy — see `resolveMcpCredential`. */
  credentialId?: string
}

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

/** Built-in def by id — the host-server path (`mcp/manager.ts`) resolves only
 *  these; registry entries are reached through the proxy, not a host server. */
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
  description: entry.url,
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
 * not have. Registry entries are off or on.
 */
export const mcpHasModes = (entry: McpEntry): boolean => entry.source === 'builtin'

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

/** Whether a string may be sent as a header name. Node throws
 *  `ERR_INVALID_HTTP_TOKEN` on anything else, synchronously, at the moment the
 *  request is built. */
export const isHeaderName = (name: string): boolean => HEADER_NAME_RE.test(name)

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

/**
 * null = ok. Everything checkable without the credential store: id shape,
 * reserved and taken ids, an http(s) URL, and header well-formedness. The
 * credential link is checked separately (`resolveMcpCredential`) because only
 * main holds the secrets store.
 *
 * `takenIds` are the *other* entries' ids — an update passes the registry minus
 * the entry being saved.
 */
export function validateMcpEntry(
  entry: McpEntryDraft,
  { takenIds = [] }: { takenIds?: readonly string[] } = {}
): string | null {
  const id = entry.id?.trim() ?? ''
  if (!id) return 'id must not be empty'
  if (!ID_RE.test(id))
    return `id "${id}" must be lowercase letters, digits, ".", "-" or "_", starting alphanumeric`
  if (RESERVED_MCP_IDS.includes(id)) return `id "${id}" is reserved by a built-in MCP server`
  if (takenIds.includes(id)) return `id "${id}" is already used by another MCP server`

  const raw = entry.url?.trim() ?? ''
  if (!raw) return 'url must not be empty'
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return `url "${raw}" is not a valid URL`
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return `url must be http(s) — "${url.protocol}//" is not supported (HTTP transport only)`
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

/** What a caller may hand `normalizeMcpEntry`: a parsed on-disk record or a
 *  half-filled editor draft, where an optional field may be explicitly
 *  `undefined` rather than absent. */
export interface McpEntryDraft {
  id: string
  label?: string | undefined
  url: string
  headers?: readonly McpHeader[] | undefined
  credentialId?: string | undefined
}

/** Normal form for the store: trimmed, empty optionals dropped. */
export function normalizeMcpEntry(entry: McpEntryDraft): McpRegistryEntry {
  const label = entry.label?.trim() ?? ''
  const headers = (entry.headers ?? [])
    .map((h) => ({ name: h.name.trim(), value: h.value ?? '' }))
    .filter((h) => h.name)
  return {
    id: entry.id.trim(),
    ...(label ? { label } : {}),
    url: entry.url.trim(),
    ...(headers.length ? { headers } : {}),
    ...(entry.credentialId ? { credentialId: entry.credentialId } : {})
  }
}
