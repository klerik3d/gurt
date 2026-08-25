// The host half of the proxy contract: what one session's proxy is allowed to
// do, written as a file the proxy watches (docs/requirements-mcp-proxy.md §4.3,
// §5.3).
//
// One function does the whole job — `planProxy` returns the proxy's scope *and*
// the ACP descriptors the agent receives, from the same pass over the session's
// MCP selection. They are built together on purpose: a descriptor the scope does
// not back is a 404 the agent cannot explain, and a scope entry no descriptor
// names is a credential mounted for nobody. Keeping them in one function makes
// that agreement structural rather than a thing two call sites have to remember.
//
// The secret boundary this module implements: `workspace.json` holds links
// (`credentialId`), `~/.gurt/credentials.json` holds secrets, and the *only*
// place the two meet is the file written here — which is mounted into the proxy
// container and nowhere else. The session container gets a URL and an opaque
// token (§2).
//
// Lifecycle (starting the container, the session network, pushing on a scope
// change) is deliberately not here: this module is pure config, and the
// container/network layer that will call it lands separately.

import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AcpHttpMcpServer, EnvRef, McpSelection } from '../../shared/types'
import type { CredentialEntry } from '../../shared/credentials'
import { resolveMcpCredential } from '../../shared/credentials'
import type { McpRegistryEntry } from '../../shared/mcp'
import { mcpEntries, resolveMcpSelection } from '../../shared/mcp'
import {
  PROXY_CONFIG_VERSION,
  sanitizeDomainPolicy,
  proxyBaseUrl,
  proxyMcpUrl,
  type DomainPolicy,
  type McpUpstream,
  type ProxyConfig
} from '../../shared/proxy'
import { getMcpServers, gurtRoot } from '../store'
import { listCredentials } from '../credentials'

/** The turn-contract server: never user-selectable, always routed, because the
 *  session is over when the agent cannot report that it is (§3.3). */
const ALWAYS_HOST_IDS = ['gurt'] as const

/** 32 random bytes, base64url — a handle to a scope, not a signed claim about
 *  one (§5.2). Minted per session, never logged, and *not* reissued when the
 *  scope changes: the agent already baked it into its environment. */
export const mintProxyToken = (): string => randomBytes(32).toString('base64url')

/** Root of the per-session config directories, on the host. 0700: it is the one
 *  place a resolved MCP credential is at rest outside the credential store. */
export const proxyConfigDir = (): string => path.join(gurtRoot, 'proxy')

/**
 * The directory one session's config lives in — and the thing the proxy
 * container bind-mounts (at `/etc/gurt`), rather than the file itself.
 *
 * A *file* bind mount pins an inode: the host writes the config through a temp
 * file and a rename (so a watcher can never read a half-written scope), which
 * replaces the inode at that path, and a container holding the old one would
 * never see a single scope change again. Mounting the directory makes the
 * rename visible; giving each session its own directory is what keeps one
 * proxy from seeing another session's credentials.
 */
export const proxyConfigMount = (sessionId: string): string =>
  path.join(proxyConfigDir(), sessionId)

/** The file for one session, inside {@link proxyConfigMount}. Its basename is
 *  the proxy's own default (`/etc/gurt/proxy.json`), so the container needs no
 *  configuration to find it. */
export const proxyConfigPath = (sessionId: string): string =>
  path.join(proxyConfigMount(sessionId), 'proxy.json')

/**
 * Create the session's config directory, 0700, without writing a scope into it.
 *
 * The mount source has to exist before `docker run` (docker would otherwise
 * invent it, owned by root); the *scope* deliberately does not, so a proxy that
 * comes up before its scope is pushed answers 503 and refuses egress rather
 * than starting on stale authority (§5.3, "fail closed").
 */
export async function ensureProxyConfigDir(sessionId: string): Promise<string> {
  const dir = proxyConfigMount(sessionId)
  await fs.mkdir(dir, { recursive: true })
  // mkdir's mode is masked by the process umask; chmod is not.
  await fs.chmod(proxyConfigDir(), 0o700).catch(() => {})
  await fs.chmod(dir, 0o700).catch(() => {})
  return dir
}

/** Read back the token of a session's live scope, so a proxy that is reused
 *  keeps the token the agent already baked into its environment. Null when
 *  there is no readable scope — the caller mints a fresh one. */
export async function readProxyToken(sessionId: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await fs.readFile(proxyConfigPath(sessionId), 'utf8')) as {
      token?: unknown
    }
    return typeof raw.token === 'string' && raw.token ? raw.token : null
  } catch {
    return null
  }
}

export interface ProxyPlanInput {
  sessionId: string
  /** From `mintProxyToken()`, kept for the session's lifetime. */
  token: string
  /** The session's `McpSelection` — ids the user picked, in their order. */
  selection?: readonly McpSelection[] | undefined
  /** The workspace registry (`getMcpServers`). */
  registry?: readonly McpRegistryEntry[] | undefined
  /** The credential store (`listCredentials`). */
  credentials?: readonly CredentialEntry[] | undefined
  /**
   * Base URL of gurt's own per-session host MCP listener, *including* its host
   * token — e.g. `http://host.docker.internal:54321/mcp/<hostToken>`. Built-in
   * ids hang off it by id. Absent ⇒ built-ins cannot be routed and are reported
   * as errors rather than silently dropped.
   */
  hostMcpUrl?: string | undefined
  /**
   * Per-id host listener URLs, each already carrying its own token — the shape
   * gurt's built-in servers still have while `mcp/manager.ts` runs one listener
   * per (session, mcp id). Takes precedence over {@link hostMcpUrl}, which is
   * where this collapses once the built-ins are multiplexed behind a single
   * per-session listener (§10.4).
   */
  hostMcpUrls?: Readonly<Record<string, string>> | undefined
  /** Session network settings; defaults to open + an empty allow list. */
  network?: { internal?: boolean; policy?: DomainPolicy } | undefined
  /** Base URL the container reaches the proxy on. Overridden only by tests and
   *  by a future non-default topology. */
  proxyBase?: string | undefined
}

export interface ProxyPlan {
  /** What to write with `writeProxyConfig`. */
  config: ProxyConfig
  /** What `sessions.ts` passes to `session/new` as `mcpServers`. */
  mcpServers: AcpHttpMcpServer[]
  /**
   * Selections that could not be routed, in the caller's words for the session
   * log. Each one dropped its server from *both* lists: a credential that does
   * not resolve blocks, it never falls back to an unauthenticated call
   * (`requirements-git-access.md` §3.1, the same rule as everywhere else).
   */
  errors: string[]
}

/**
 * Build the proxy scope + the agent's MCP descriptors for one session.
 *
 * Pure: the registry and the credential store come in as arrays, so this is
 * testable without a workspace on disk. `resolveProxyPlan` is the version that
 * reads both.
 *
 * `McpSelection.mode` is intentionally not carried into the scope. Read-only is
 * a property of gurt's *own* servers — `buildGithubHttpServer` builds a smaller
 * tool set for it — and the proxy, which knows nothing about an upstream's
 * tools, must not appear to enforce something it cannot (§3.3).
 */
export function planProxy(input: ProxyPlanInput): ProxyPlan {
  const registry = input.registry ?? []
  const credentials = input.credentials ?? []
  const base = input.proxyBase ?? proxyBaseUrl()
  const errors: string[] = []
  const mcp: Record<string, McpUpstream> = {}
  const mcpServers: AcpHttpMcpServer[] = []

  const hostUpstream = (id: string): McpUpstream | null => {
    const direct = input.hostMcpUrls?.[id]
    if (!direct && !input.hostMcpUrl) {
      errors.push(`MCP server "${id}" is built in but gurt's host listener is not running`)
      return null
    }
    // The host token is already in the URL, either way. It is injected here and
    // exists nowhere in the session container — which is what keeps the
    // built-in servers working when the session network has no route to the
    // host at all.
    return {
      kind: 'host',
      url: direct ?? `${(input.hostMcpUrl ?? '').replace(/\/+$/, '')}/${id}`
    }
  }

  const registryUpstream = (entry: McpRegistryEntry): McpUpstream | null => {
    const headers = [...(entry.headers ?? []).map((h) => ({ name: h.name, value: h.value }))]
    const { header, error } = resolveMcpCredential(credentials, entry.credentialId)
    if (error) {
      errors.push(`MCP server "${entry.id}": ${error}`)
      return null
    }
    if (header) {
      // The credential wins over a static header of the same name, whatever its
      // spelling — one `Authorization` goes upstream, and it is the resolved one.
      const at = headers.findIndex((h) => h.name.toLowerCase() === header.name.toLowerCase())
      if (at >= 0) headers.splice(at, 1)
      headers.push(header)
    }
    return { kind: 'registry', url: entry.url, ...(headers.length ? { headers } : {}) }
  }

  const add = (id: string, upstream: McpUpstream | null): void => {
    if (!upstream || mcp[id]) return
    mcp[id] = upstream
    mcpServers.push({ type: 'http', name: id, url: proxyMcpUrl(input.token, id, base), headers: [] })
  }

  // The selection is the scope: what the user picked, resolved against what the
  // workspace offers *now*. An id that no longer resolves — a registry entry
  // deleted behind a saved session — is reported, not guessed at.
  for (const { selection: sel, entry } of resolveMcpSelection(
    input.selection,
    mcpEntries(registry)
  )) {
    if (!entry) {
      errors.push(`MCP server "${sel.id}" is not a built-in and is not in this workspace's registry`)
      continue
    }
    add(sel.id, entry.source === 'builtin' ? hostUpstream(sel.id) : registryUpstream(entry.entry))
  }
  for (const id of ALWAYS_HOST_IDS) if (!mcp[id]) add(id, hostUpstream(id))

  return {
    config: {
      version: PROXY_CONFIG_VERSION,
      session: input.sessionId,
      token: input.token,
      mcp,
      network: {
        internal: input.network?.internal === true,
        // Sanitized here as well as at the IPC boundary, and for a different
        // reason: this is the last point before the file the *proxy* parses, and
        // that parser refuses a policy it cannot fully read (an unparseable
        // allow entry is a refused scope, not a dropped one). It is also where a
        // session stored under the old three-mode policy is migrated, and a
        // copy, so the returned config is a caller's to hold on to.
        policy: sanitizeDomainPolicy(input.network?.policy)
      }
    },
    mcpServers,
    errors
  }
}

/**
 * `planProxy` with the workspace registry and the credential store read for
 * you — the shape a session start actually has.
 */
export async function resolveProxyPlan(
  ref: EnvRef,
  sessionId: string,
  token: string,
  selection: McpSelection[] | undefined,
  opts: Omit<ProxyPlanInput, 'sessionId' | 'token' | 'selection' | 'registry' | 'credentials'> = {}
): Promise<ProxyPlan> {
  const [registry, credentials] = await Promise.all([
    getMcpServers(ref.workspace),
    listCredentials()
  ])
  return planProxy({ sessionId, token, selection, registry, credentials, ...opts })
}

/**
 * Write the config the session's proxy reads.
 *
 * Written through a temp file and renamed: the proxy watches this path and a
 * half-written scope must never be readable, whatever the watcher's timing.
 * 0600 on the file and 0700 on the directory because this is the one place a
 * resolved MCP credential is at rest outside the credential store.
 *
 * Returns the path, which is what the container layer bind-mounts.
 */
export async function writeProxyConfig(sessionId: string, config: ProxyConfig): Promise<string> {
  const file = proxyConfigPath(sessionId)
  await ensureProxyConfigDir(sessionId)
  // Same directory as the target, because the rename has to be atomic — and
  // that directory is the proxy's bind-mount source, so the temp file is
  // momentarily visible inside the container. It is 0600 from birth and the
  // proxy only ever opens `proxy.json`.
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await fs.chmod(tmp, 0o600).catch(() => {})
  await fs.rename(tmp, file)
  return file
}

/** Remove a session's scope. The proxy reads this as a revocation and fails
 *  closed on the next poll, so it is also the cheap half of teardown. The
 *  directory stays: it is a live bind-mount source while the container exists,
 *  and {@link removeProxyConfigDir} is what retires it. */
export async function removeProxyConfig(sessionId: string): Promise<void> {
  await fs.rm(proxyConfigPath(sessionId), { force: true })
}

/** Retire the session's config directory once its proxy is gone. */
export async function removeProxyConfigDir(sessionId: string): Promise<void> {
  await fs.rm(proxyConfigMount(sessionId), { recursive: true, force: true })
}
