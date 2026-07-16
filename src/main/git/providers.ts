// Forge providers: the single extension point for forge-specific behavior
// (forge CLI wrappers + API tokens). Adding a forge (gitlab, gitea, …) is one
// new provider plus optional wrapper shims — the git-native contract in
// config.ts never changes. Providers extend it, they never replace it (§7).
import type { CredentialEntry } from '../../shared/credentials'
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
