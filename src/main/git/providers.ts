// Forge providers: the single extension point for forge-specific behavior
// (forge CLI wrappers + API tokens). Adding a forge (gitlab, gitea, …) is one
// new provider plus optional wrapper shims — the git-native contract in
// config.ts never changes. Providers extend it, they never replace it (§7).
import type { CredentialEntry, GitIdentity } from '../../shared/credentials'
import { DEFAULT_TOKEN_USER } from '../../shared/credentials'

export interface ForgeProvider {
  id: string
  matches(host: string): boolean
  /**
   * Env map for the forge CLI, or null when the credential cannot serve the
   * forge API (git-ssh-key, git-host → null). git-token returns the stored
   * secret; git-app (phase 3) mints a short-lived scoped token — wrappers
   * benefit without changes.
   */
  forgeEnv(cred: CredentialEntry, host: string): Promise<Record<string, string> | null>
  /**
   * Verify the credential against the forge API and return the token owner's
   * commit identity (§3.2). Throws with a readable message when the forge
   * rejects the token or the kind cannot be verified — the save is then
   * rejected, so an unverified credential is never stored.
   */
  identity(cred: CredentialEntry, host: string): Promise<GitIdentity>
  /** Shim names to install into the container (e.g. ['gh']). */
  wrappers: string[]
  /**
   * devcontainer features guaranteeing the wrapped CLIs exist, merged into
   * --additional-features at env-up (next to BASE_FEATURES' node).
   */
  features: Record<string, object>
}

const github: ForgeProvider = {
  id: 'github',
  // SSH host aliases like github.com-work count.
  matches: (host) => host.includes('github'),
  async forgeEnv(cred, host) {
    if (cred.kind === 'git-token') {
      const env: Record<string, string> = { GH_TOKEN: cred.data.secret ?? '' }
      // gh defaults to github.com; only GitHub Enterprise hosts need GH_HOST.
      if (host !== 'github.com') env.GH_HOST = host
      return env.GH_TOKEN ? env : null
    }
    // git-app minting lands in phase 3 behind this same seam.
    return null
  },
  async identity(cred, host) {
    if (cred.kind !== 'git-token')
      throw new Error(`cannot verify a ${cred.kind} credential against github`)
    if (!cred.data.secret) throw new Error(`credential "${cred.label}": token is empty`)
    const url =
      host === 'github.com' ? 'https://api.github.com/user' : `https://${host}/api/v3/user`
    let res: Response
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${cred.data.secret}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'gurt'
        }
      })
    } catch (e) {
      throw new Error(
        `credential "${cred.label}": could not reach ${url} — ${e instanceof Error ? e.message : String(e)}`
      )
    }
    if (!res.ok)
      throw new Error(`credential "${cred.label}": github rejected the token (HTTP ${res.status})`)
    const u = (await res.json()) as { login?: string; id?: number; name?: string; email?: string }
    if (!u.login || typeof u.id !== 'number')
      throw new Error(`credential "${cred.label}": github returned no user for the token`)
    // The noreply form github attributes to the account regardless of the
    // profile email's visibility setting.
    return { name: u.name || u.login, email: u.email || `${u.id}+${u.login}@users.noreply.github.com` }
  },
  wrappers: ['gh'],
  features: { 'ghcr.io/devcontainers/features/github-cli:1': {} }
}

const PROVIDERS: ForgeProvider[] = [github]

/** The provider serving `host`, or null when none matches. */
export const providerForHost = (host: string): ForgeProvider | null =>
  PROVIDERS.find((p) => p.matches(host)) ?? null

/** Kept for the (unused today) case of stacked providers; returns 0 or 1 today. */
export const providersForHost = (host: string): ForgeProvider[] =>
  PROVIDERS.filter((p) => p.matches(host))

/**
 * devcontainer features contributed by the provider for `host`, computed from
 * the env repo's host only (not credentials or the session toggle) so the set
 * is stable for the env's lifetime — image-level features must not change
 * between ups (§7). Empty when no provider matches or the host is unknown.
 */
export function forgeFeatures(host: string | null): Record<string, object> {
  if (!host) return {}
  const p = providerForHost(host)
  return p ? p.features : {}
}

/** Wrapper shim names to install for `host` (e.g. ['gh']). */
export function forgeWrappers(host: string | null): string[] {
  if (!host) return []
  const p = providerForHost(host)
  return p ? p.wrappers : []
}
