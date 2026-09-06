// The git-native contract for the *host* path: transport rewrite rules and the
// config delivery. Nothing here is written into a clone or a global git config
// — the host rides on `-c` argv entries (works on any git; hosts can run
// pre-2.31 gits that silently ignore GIT_CONFIG_* env vars, which would leak to
// ambient auth), the container on GIT_CONFIG_* env vars (git >= 2.31, scoped to
// the agent process tree) for the one thing it still injects: commit identity.
//
// The container holds no credentials at all (docs/requirements-mcp-proxy.md
// §10): there is no credential helper, no broker URL and no ssh in it, and
// authenticated git is exclusively the host-side github MCP. What the container
// keeps is unauthenticated local git — status, diff, add, commit, branch, log.
import type { CredentialKind, GitIdentity } from '../../shared/credentials'

/** One `git config` key/value the injection sets, in order. */
export type ConfigPair = [key: string, value: string]

/**
 * GIT_SSH_COMMAND that fails fast with a clear message. Set on every host git
 * call that is not explicitly ambient (managed and blocked modes): gurt talks
 * to forges only through gurt-managed credentials, so a fetch that would
 * otherwise reach the user's own ssh keys must fail loudly instead. Git appends
 * `host command` as extra args; the `sh -c` script ignores its positional
 * params, so they are inert.
 *
 * This is the *blocking* of ssh, not support for it — gurt has no ssh
 * credential kind and mounts no agent socket anywhere (§10.1).
 */
export const BLOCKED_SSH_COMMAND = `sh -c 'echo "gurt: ssh blocked - no gurt credential is configured for this host (add one in Credentials or explicitly select host credentials)" >&2; exit 128' gurt-ssh-blocked`

/**
 * Transport-independence rewrites for host `host` by resolved credential kind
 * (§6.1). The transport follows the credential, not the stored clone URL: a
 * token repo pushes over https regardless of how it was cloned. Both directions
 * use plain `insteadOf` (fetch + push).
 */
export function rewriteRules(host: string, kind: CredentialKind): ConfigPair[] {
  switch (kind) {
    case 'git-token':
    case 'git-app':
      return [
        [`url.https://${host}/.insteadOf`, `git@${host}:`],
        [`url.https://${host}/.insteadOf`, `ssh://git@${host}/`]
      ]
    case 'git-host':
    case 'agent-token':
    case 'mcp-token':
      // Not a gurt-managed git transport — nothing to rewrite (§6.1).
      return []
  }
}

/**
 * Fold ConfigPairs into GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n.
 * Container-only delivery: requires git >= 2.31, which the devcontainer images
 * provide. An older container git ignores these and fails cleanly (there are no
 * credentials inside to leak to, and the pairs carry none anyway).
 */
export function gitConfigEnv(pairs: ConfigPair[]): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) }
  pairs.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k
    env[`GIT_CONFIG_VALUE_${i}`] = v
  })
  return env
}

/**
 * Fold ConfigPairs into `-c key=value` argv entries. Host-side delivery: the
 * host git can be old (e.g. 2.19 from a standalone installer) and silently
 * ignore GIT_CONFIG_* env — which would fall back to ambient auth. `-c` has
 * worked forever and fails loudly if malformed. Must precede the subcommand.
 */
export function gitConfigArgs(pairs: ConfigPair[]): string[] {
  return pairs.flatMap(([k, v]) => ['-c', `${k}=${v}`])
}

/** §3.2 commit identity as config pairs — managed kinds only, ambient injects none. */
export const identityPairs = (identity: GitIdentity | null | undefined): ConfigPair[] =>
  identity ? [['user.name', identity.name], ['user.email', identity.email]] : []

/**
 * The env injected into the in-container agent process: commit identity, and
 * nothing else (§10.3). No credential helper, no broker URL, no rewrite rules,
 * no secret — the container authenticates to nothing. Unconditional, because
 * without it a local commit the agent does make is authored by whatever the
 * image happens to contain rather than by the credential's owner.
 *
 * `GIT_TERMINAL_PROMPT=0` stays: a remote operation the agent tries anyway
 * should fail immediately instead of blocking on a prompt no one can answer.
 */
export function containerGitEnv(identity?: GitIdentity | null): Record<string, string> {
  return {
    GIT_TERMINAL_PROMPT: '0',
    ...gitConfigEnv(identityPairs(identity))
  }
}
