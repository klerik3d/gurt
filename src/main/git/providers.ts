// Forge providers: the single extension point for forge-specific behavior
// (forge API tokens + save-time verification). Adding a forge (gitlab, gitea,
// …) is one new provider — the git-native contract in config.ts never changes.
// Providers extend it, they never replace it (§7).
//
// Everything here is host-side. The container-side halves this used to have —
// wrapper shims and devcontainer features guaranteeing the wrapped CLI exists —
// went with the container's credentials (docs/requirements-mcp-proxy.md §10.2):
// a `gh` in the container has nothing to authenticate with.
import { z } from 'zod'
import type { CredentialEntry, GitIdentity } from '../../shared/credentials'

/**
 * The slice of GitHub's `/user` this reads. It is a network response and the
 * name/email end up stamped on the credential as its commit identity, so it is
 * parsed, not asserted — a body that does not carry a login and a numeric id is
 * rejected by the caller below as "not a verifiable token".
 */
const GITHUB_USER = z.looseObject({
  login: z.string().optional().catch(undefined),
  id: z.number().optional().catch(undefined),
  name: z.string().nullish().catch(undefined),
  email: z.string().nullish().catch(undefined)
})

export interface ForgeProvider {
  id: string
  matches(host: string): boolean
  /**
   * Env map for the forge CLI, or null when the credential cannot serve the
   * forge API (git-host → null). git-token returns the stored secret; git-app
   * (phase 3) mints a short-lived scoped token — the host `gh` in
   * `mcp/githubServer.ts` benefits without changes.
   */
  forgeEnv(cred: CredentialEntry, host: string): Promise<Record<string, string> | null>
  /**
   * Verify the credential against the forge API and return the token owner's
   * commit identity (§3.2). Throws with a readable message when the forge
   * rejects the token or the kind cannot be verified — the save is then
   * rejected, so an unverified credential is never stored.
   */
  identity(cred: CredentialEntry, host: string): Promise<GitIdentity>
  /**
   * Create an empty repository on the forge as the credential's owner (or in
   * `owner`, an organization it can create in) — the forge half of publishing a
   * local repo (docs/requirements-new-projects.md §6). Throws with a readable
   * message on any refusal; nothing is retried.
   */
  createRepo(
    cred: CredentialEntry,
    host: string,
    spec: { name: string; owner?: string | undefined; private: boolean }
  ): Promise<{ cloneUrl: string; webUrl: string }>
}

/** The slice of GitHub's create-repository response this reads. */
const GITHUB_REPO = z.looseObject({
  clone_url: z.string(),
  html_url: z.string()
})

const githubApi = (host: string): string =>
  host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`

const github: ForgeProvider = {
  id: 'github',
  // SSH host aliases like github.com-work count.
  matches: (host) => host.includes('github'),
  async forgeEnv(cred, host) {
    if (cred.kind === 'git-token') {
      const env: Record<string, string> = { GH_TOKEN: cred.data['secret'] ?? '' }
      // gh defaults to github.com; only GitHub Enterprise hosts need GH_HOST.
      if (host !== 'github.com') env['GH_HOST'] = host
      return env['GH_TOKEN'] ? env : null
    }
    // git-app minting lands in phase 3 behind this same seam.
    return null
  },
  async identity(cred, host) {
    if (cred.kind !== 'git-token')
      throw new Error(`cannot verify a ${cred.kind} credential against github`)
    if (!cred.data['secret']) throw new Error(`credential "${cred.label}": token is empty`)
    const url = `${githubApi(host)}/user`
    let res: Response
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${cred.data['secret']}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'gurt'
        }
      })
    } catch (e) {
      throw new Error(
        `credential "${cred.label}": could not reach ${url} — ${e instanceof Error ? e.message : String(e)}`,
        { cause: e }
      )
    }
    if (!res.ok)
      throw new Error(`credential "${cred.label}": github rejected the token (HTTP ${res.status})`)
    const u = GITHUB_USER.parse(await res.json())
    if (!u.login || typeof u.id !== 'number')
      throw new Error(`credential "${cred.label}": github returned no user for the token`)
    // The noreply form github attributes to the account regardless of the
    // profile email's visibility setting.
    return { name: u.name || u.login, email: u.email || `${u.id}+${u.login}@users.noreply.github.com` }
  },
  async createRepo(cred, host, spec) {
    if (cred.kind !== 'git-token' || !cred.data['secret'])
      throw new Error(`credential "${cred.label}" cannot create repositories on github`)
    const url = spec.owner
      ? `${githubApi(host)}/orgs/${encodeURIComponent(spec.owner)}/repos`
      : `${githubApi(host)}/user/repos`
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cred.data['secret']}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'gurt'
        },
        // Empty on purpose: no README, no license — the local history is what
        // gets pushed into it, and an initial commit there would diverge.
        body: JSON.stringify({ name: spec.name, private: spec.private, auto_init: false })
      })
    } catch (e) {
      throw new Error(
        `could not reach ${url} — ${e instanceof Error ? e.message : String(e)}`,
        { cause: e }
      )
    }
    if (!res.ok) {
      // GitHub explains a refusal (name taken, no org permission, token scope)
      // in `message` + `errors[].message`; the status alone says little.
      const body = (await res.json().catch(() => null)) as {
        message?: unknown
        errors?: { message?: unknown }[]
      } | null
      const detail = [body?.message, ...(body?.errors ?? []).map((e) => e.message)]
        .filter((m): m is string => typeof m === 'string' && !!m)
        .join(' — ')
      throw new Error(
        `github refused to create "${spec.owner ? `${spec.owner}/` : ''}${spec.name}" ` +
          `(HTTP ${res.status})${detail ? `: ${detail}` : ''}`
      )
    }
    const repo = GITHUB_REPO.parse(await res.json())
    return { cloneUrl: repo.clone_url, webUrl: repo.html_url }
  }
}

const PROVIDERS: ForgeProvider[] = [github]

/** The provider serving `host`, or null when none matches. */
export const providerForHost = (host: string): ForgeProvider | null =>
  PROVIDERS.find((p) => p.matches(host)) ?? null

/** Kept for the (unused today) case of stacked providers; returns 0 or 1 today. */
export const providersForHost = (host: string): ForgeProvider[] =>
  PROVIDERS.filter((p) => p.matches(host))
