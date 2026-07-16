// The git-native contract, shared by the container and host paths: transport
// rewrite rules and the GIT_CONFIG_* / env assembly. Nothing here is written
// into a clone or a container's global config — everything rides on env vars
// (git >= 2.31), scoped to the agent process tree (§2, §6, §8).
import type { CredentialKind } from '../../shared/credentials'

/** Dedicated dir for container shims; on PATH via gurt-launch for the agent only. */
export const SHIM_DIR = '/opt/gurt/bin'
export const LAUNCH_BIN = `${SHIM_DIR}/gurt-launch`
export const CRED_HELPER_BIN = `${SHIM_DIR}/gurt-git-credential`
export const SSH_AGENT_PROXY_BIN = `${SHIM_DIR}/gurt-ssh-agent-proxy`

/** In-container path the ssh-agent proxy shim listens on (phase 2). */
export const SSH_SOCK = '/tmp/gurt-ssh-agent.sock'

/** One `git config` key/value the injection sets, in order. */
export type ConfigPair = [key: string, value: string]

/**
 * Transport-independence rewrites for host `host` by resolved credential kind
 * (§6.1). The transport follows the credential, not the stored clone URL: a
 * token repo pushes over https regardless of how it was cloned, and vice versa.
 * Both directions use plain `insteadOf` (fetch + push).
 */
export function rewriteRules(host: string, kind: CredentialKind): ConfigPair[] {
  switch (kind) {
    case 'git-token':
    case 'git-app':
      return [
        [`url.https://${host}/.insteadOf`, `git@${host}:`],
        [`url.https://${host}/.insteadOf`, `ssh://git@${host}/`]
      ]
    case 'git-ssh-key':
      return [[`url.ssh://git@${host}/.insteadOf`, `https://${host}/`]]
    case 'git-host':
      return []
  }
}

/** Fold ConfigPairs into GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n. */
export function gitConfigEnv(pairs: ConfigPair[]): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) }
  pairs.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k
    env[`GIT_CONFIG_VALUE_${i}`] = v
  })
  return env
}

/**
 * The env injected into the in-container agent process (§6). Secrets are never
 * here — only the broker URL+token; the shim fetches the actual credential from
 * the broker per request. The empty first helper resets any inherited helper.
 */
export function containerGitEnv(
  brokerUrl: string,
  host: string | null,
  kind: CredentialKind
): Record<string, string> {
  const pairs: ConfigPair[] = [
    ['credential.helper', ''],
    ['credential.helper', CRED_HELPER_BIN]
  ]
  if (host) pairs.push(...rewriteRules(host, kind))
  return {
    GURT_GIT_BROKER: brokerUrl,
    GIT_TERMINAL_PROMPT: '0',
    ...gitConfigEnv(pairs)
  }
}
