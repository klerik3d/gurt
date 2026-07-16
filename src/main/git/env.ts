// Host-side git env (§8): the same git-native contract as the container, so
// clone/fetch/push work for a repo whose only credential is a gurt-managed
// token, on a host with no ambient git auth at all. git-host (and any kind
// whose host path isn't implemented yet) → ambient behavior, just with
// GIT_TERMINAL_PROMPT=0 so nothing ever blocks on a prompt.
import type { RepoConfig } from '../../shared/types'
import type { CredentialEntry } from '../../shared/credentials'
import { resolveCredential } from '../../shared/credentials'
import { canonicalRepoId } from '../../shared/repoId'
import { getWorkspace } from '../store'
import { listCredentials } from '../credentials'
import { rewriteRules, gitConfigEnv, type ConfigPair } from './config'
import { ensureHostCredHelper } from './shims'

/** Base host git env: inherit everything, but never prompt. */
const baseEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: '0' })

/** Build the host git env for `repo`, resolving its credential per §3.1. */
export async function hostGitEnv(
  repo: RepoConfig,
  credentials: CredentialEntry[]
): Promise<NodeJS.ProcessEnv> {
  const base = baseEnv()
  const host = canonicalRepoId(repo.url)?.host
  if (!host) return base
  const res = resolveCredential(credentials, repo, host)
  if (!res.entry || res.kind !== 'git-token') return base
  // Point credential.helper at the host helper, run through Electron-in-node
  // (no system node is assumed). The resolved entry id rides in the env; the
  // secret is read from credentials.json by the helper, never placed in env.
  const helper = await ensureHostCredHelper()
  const helperCmd = `!ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${helper}"`
  const pairs: ConfigPair[] = [
    ['credential.helper', ''],
    ['credential.helper', helperCmd],
    ...rewriteRules(host, 'git-token')
  ]
  return { ...base, GURT_CRED_ID: res.entry.id, ...gitConfigEnv(pairs) }
}

/** Load the repo config + credentials and build the host git env for it. */
export async function hostGitEnvForRepo(ws: string, repoName: string): Promise<NodeJS.ProcessEnv> {
  const repo = (await getWorkspace(ws)).repos.find((r) => r.name === repoName)
  if (!repo) return baseEnv()
  return hostGitEnv(repo, await listCredentials())
}
