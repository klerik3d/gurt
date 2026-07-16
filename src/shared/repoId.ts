// Canonical git repo identity, shared by main and renderer.
//
// A repo is identified by `(host, path)` with `.git` stripped, so
// `git@github.com:me/app.git`, `ssh://git@github.com/me/app`, and
// `https://github.com/me/app.git` all denote the same repo `github.com/me/app`.
// Auth, host-matching, and transport rewriting operate on this identity — never
// on the stored clone URL, so editing the URL scheme in repo settings does not
// create a "different repo".

export interface RepoId {
  /** Lower-cased git host (may be an ssh alias like `github.com-work`). */
  host: string
  /** owner/repo (or deeper), leading slashes and a trailing `.git` stripped. */
  path: string
}

/** Parse an origin URL (scheme or scp-like `git@host:path`) into its identity. */
export function canonicalRepoId(url: string): RepoId | null {
  const s = url.trim()
  let host: string
  let p: string
  if (/^[a-z][\w+.-]*:\/\//i.test(s)) {
    try {
      const u = new URL(s)
      host = u.hostname
      p = u.pathname
    } catch {
      return null
    }
  } else {
    // scp-like: [user@]host:path
    const m = s.match(/^(?:[^@/]+@)?([\w.-]+):(.+)$/)
    if (!m) return null
    host = m[1]
    p = m[2]
  }
  const path = p.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '')
  if (!host || !path) return null
  return { host: host.toLowerCase(), path }
}

export const repoIdString = (id: RepoId): string => `${id.host}/${id.path}`

/** Just the git host of an origin URL, or null when it cannot be parsed. */
export const repoHost = (url: string): string | null => canonicalRepoId(url)?.host ?? null
