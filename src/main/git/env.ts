// Host-side git access (§8): the same git-native contract as the container,
// under one policy — gurt talks to git and forges only through gurt-managed
// credentials inside the app boundary. Ambient host auth is an explicit
// credential kind (`git-host`), never a fallback: when nothing resolves, remote
// operations are blocked with a clear error instead of silently reaching the
// host's ssh keys / keychain / gh login.
//
// Three modes:
//   managed — a git-token entry resolves: helper → credentials.json, ssh→https
//             rewrites, ambient ssh blocked.
//   ambient — an explicit `git-host` entry resolves (linked or host-matched):
//             inherit the host env as-is, just never prompt.
//   blocked — implicit resolution, a resolution error, or an unimplemented
//             kind: credential helpers reset, ambient ssh blocked; local git
//             still works, network auth fails cleanly.
//
// Config rides in `gitArgs` (`-c` argv entries, before the subcommand), NOT in
// GIT_CONFIG_* env: host gits can predate 2.31 and silently ignore the env
// vars — which would silently fall back to ambient auth. Every host git call
// must spread `gitArgs` into its argv and run under `env`.
import type { RepoConfig } from '../../shared/types'
import type { CredentialEntry, CredResolution } from '../../shared/credentials'
import { resolveCredential, credentialIdentity } from '../../shared/credentials'
import { canonicalRepoId } from '../../shared/repoId'
import { getWorkspace } from '../store'
import { listCredentials } from '../credentials'
import {
  rewriteRules,
  gitConfigArgs,
  identityPairs,
  BLOCKED_SSH_COMMAND,
  type ConfigPair
} from './config'
import { ensureHostCredHelper } from './shims'

export type HostGitMode = 'managed' | 'ambient' | 'blocked'

export interface HostGitAccess {
  mode: HostGitMode
  env: NodeJS.ProcessEnv
  /** `-c key=value` entries; spread into argv before the git subcommand. */
  gitArgs: string[]
  /** Repo host the resolution ran against (identity per §2.1), if parseable. */
  host: string | null
  resolution: CredResolution | null
  /** Human-readable cause, set when mode === 'blocked'. */
  reason?: string
}

/** Base host git env: inherit everything (PATH etc.), but never prompt. */
const baseEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: '0' })

/** No credential helpers, no ambient ssh — network auth fails cleanly. */
const blockedPairs: ConfigPair[] = [['credential.helper', '']]

function blocked(
  host: string | null,
  resolution: CredResolution | null,
  reason: string
): HostGitAccess {
  return {
    mode: 'blocked',
    env: { ...baseEnv(), GIT_SSH_COMMAND: BLOCKED_SSH_COMMAND },
    gitArgs: gitConfigArgs(blockedPairs),
    host,
    resolution,
    reason
  }
}

/** Resolve the host git access for `repo` per §3.1 + the no-ambient-fallback rule. */
export async function hostGitAccess(
  repo: RepoConfig,
  credentials: CredentialEntry[]
): Promise<HostGitAccess> {
  const host = canonicalRepoId(repo.url)?.host ?? null
  // Unparseable URL: nothing to resolve against — local ops fine, remote blocked.
  if (!host) return blocked(null, null, `repo URL "${repo.url}" has no recognizable git host`)
  const res = resolveCredential(credentials, repo, host)
  if (res.error) return blocked(host, res, res.error)
  // Explicit git-host entry — the one and only path to ambient behavior.
  if (res.entry && res.kind === 'git-host')
    return { mode: 'ambient', env: baseEnv(), gitArgs: [], host, resolution: res }
  if (res.entry && res.kind === 'git-token') {
    // Point credential.helper at the host helper, run through Electron-in-node
    // (no system node is assumed). The resolved entry id + host ride in the env;
    // the secret is read from credentials.json by the helper (and only for
    // requests to that host), never placed in env. Ambient ssh is blocked —
    // the rewrite rules carry the repo host to https; any other host must
    // resolve its own credential, not fall through to host keys.
    const helper = await ensureHostCredHelper()
    const helperCmd = `!ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${helper}"`
    // Identity is guaranteed by resolution (§3.2: unverified entries error out
    // above) — commits are authored by the token owner, never ambient identity.
    const pairs: ConfigPair[] = [
      ['credential.helper', ''],
      ['credential.helper', helperCmd],
      ...rewriteRules(host, 'git-token'),
      ...identityPairs(credentialIdentity(res.entry))
    ]
    return {
      mode: 'managed',
      env: {
        ...baseEnv(),
        GURT_CRED_ID: res.entry.id,
        GURT_CRED_HOST: host,
        GIT_SSH_COMMAND: BLOCKED_SSH_COMMAND
      },
      gitArgs: gitConfigArgs(pairs),
      host,
      resolution: res
    }
  }
  if (res.entry)
    return blocked(host, res, `credential "${res.entry.label}" (${res.kind}) is not usable yet`)
  return blocked(
    host,
    res,
    `no gurt credential is configured for ${host} — add one in Credentials or explicitly select host credentials`
  )
}

/** Load the repo config + credentials and resolve the host git access for it. */
export async function hostGitAccessForRepo(ws: string, repoName: string): Promise<HostGitAccess> {
  const repo = (await getWorkspace(ws)).repos.find((r) => r.name === repoName)
  if (!repo) return blocked(null, null, `repo "${repoName}" is not registered in "${ws}"`)
  return hostGitAccess(repo, await listCredentials())
}
