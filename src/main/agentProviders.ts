// Does this agent token work? — one probe per agent kind
// (docs/requirements-first-run.md §7.3).
//
// `verifyTokens` in credentials.ts verifies a `git-token` against its forge at
// save time and stamps the owner's identity; it `continue`s past every other
// kind, so an `agent-token` has always been stored unverified. That is the one
// remaining way the welcome screen's promise breaks: a green checklist plus a
// mistyped token gives a session that starts, connects, and answers with the
// provider's auth error minutes later, in a chat the user has not learned to
// read yet.
//
// Shaped like `git/providers.ts`: each kind's plugin builds its own request
// (`AgentMainPlugin.probeToken`) and the verdict is read here, with no
// knowledge of the individual providers anywhere else.
//
// Three rules the whole module exists to hold:
//
//   1. **Three outcomes, not two.** A provider that cannot be reached is not a
//      provider that said no. The probe runs on the *host*, and a session
//      container's route out is its own proxy's — a corporate filter that
//      blocks this machine can sit next to a container that reaches the
//      provider fine. `unreachable` therefore never blocks; it warns.
//   2. **429 is `unreachable`.** A provider edge can answer even an
//      *unauthenticated* request with 429 rather than 401 (Anthropic's
//      `/api/oauth/usage` does — see the claude-code plugin). Reading that as
//      acceptance would report a bad token as good, which is the one wrong
//      answer this file must not produce.
//   3. **Nothing here is wired into `setCredentials`.** Adding `agent-token`
//      to `verifyTokens` would make every save of the credential file probe
//      every provider, and would make Settings → Credentials refuse a token on
//      a machine that is merely offline. The probe stays on the path where the
//      user is asking for exactly this check.
import type { TokenProbe } from '../shared/doctor'
import { agentMain } from './agentPlugins'
import { createLogger } from './log'

const log = createLogger('agent-probe')

/** Short: this sits between a click and a container start, and an answer that
 *  takes longer than this is `unreachable` by any useful definition. */
const TIMEOUT_MS = 5_000

/** Whether this build can check a kind's token at all — the welcome screen
 *  says "not checked" rather than implying a pass. */
export const canProbeAgentToken = (kind: string): boolean => !!agentMain(kind)?.probeToken

/**
 * Ask the provider whether it accepts this token.
 *
 * Never throws: every failure is one of the three verdicts. `doFetch` is a
 * parameter for the same reason `planUsage.ts` takes one — the tests drive a
 * local stub, not the internet.
 */
export async function probeAgentToken(
  kind: string,
  token: string,
  doFetch: typeof fetch = fetch
): Promise<TokenProbe> {
  const probe = agentMain(kind)?.probeToken
  if (!probe || !token.trim())
    return { verdict: 'unreachable', detail: `no token check exists for "${kind}" — not verified` }
  const provider = probe(token)
  const { url, headers } = provider
  let status: number
  try {
    const res = await doFetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    status = res.status
  } catch (e) {
    // DNS, TLS, timeout, offline. The error is logged as a reason, never with
    // the request that carried the token.
    log.info('token.probe.unreachable', { kind, err: e instanceof Error ? e.message : String(e) })
    return {
      verdict: 'unreachable',
      detail: `could not reach ${provider.label} to check the token — continuing without checking`
    }
  }
  // Only the status is logged. The request that carried the token is not.
  log.info('token.probe', { kind, status })
  if (status === 401 || status === 403)
    return {
      verdict: 'rejected',
      detail: `${provider.label} rejected this token (HTTP ${status}) — check it and paste it again`
    }
  // Rule 2. Also covers the API proper's own rate limit, where "we could not
  // ask" is exactly what a 429 means.
  if (status === 429)
    return {
      verdict: 'unreachable',
      detail: `${provider.label} is rate limiting this check — continuing without checking`
    }
  if (status >= 500)
    return {
      verdict: 'unreachable',
      detail: `${provider.label} answered ${status} — continuing without checking`
    }
  if (status >= 200 && status < 300) return { verdict: 'ok', detail: '' }
  // Anything else is a shape this code did not anticipate. It is not an
  // acceptance, and it is not a refusal either.
  return {
    verdict: 'unreachable',
    detail: `${provider.label} answered ${status} — continuing without checking`
  }
}
