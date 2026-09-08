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
// Shaped like `git/providers.ts`: one provider per `AgentDef.id`, a lookup by
// kind, and no knowledge of the individual providers anywhere else.
//
// Three rules the whole module exists to hold:
//
//   1. **Three outcomes, not two.** A provider that cannot be reached is not a
//      provider that said no. The probe runs on the *host*, and a session
//      container's route out is its own proxy's — a corporate filter that
//      blocks this machine can sit next to a container that reaches the
//      provider fine. `unreachable` therefore never blocks; it warns.
//   2. **429 is `unreachable`.** `main/planUsage.ts` records that the
//      `/api/oauth/usage` edge answers even an *unauthenticated* request with
//      429 rather than 401. Reading that as acceptance would report a bad
//      token as good, which is the one wrong answer this file must not
//      produce.
//   3. **Nothing here is wired into `setCredentials`.** Adding `agent-token`
//      to `verifyTokens` would make every save of the credential file probe
//      four providers, and would make Settings → Credentials refuse a token on
//      a machine that is merely offline. The probe stays on the path where the
//      user is asking for exactly this check.
import { agentDef } from '../shared/agents'
import type { TokenProbe } from '../shared/doctor'
import { createLogger } from './log'

const log = createLogger('agent-probe')

/** Short: this sits between a click and a container start, and an answer that
 *  takes longer than this is `unreachable` by any useful definition. */
const TIMEOUT_MS = 5_000

/** One provider: a single authenticated GET that creates nothing and consumes
 *  no tokens, plus the label used in the message the user reads. */
interface AgentProvider {
  label: string
  request(token: string): { url: string; headers: Record<string, string> }
}

/** Anthropic's cheapest authenticated read. Used by the API-key branch of
 *  claude-code and by opencode, whose `secretEnv` is `ANTHROPIC_API_KEY`. */
const anthropicApiKey = (token: string): { url: string; headers: Record<string, string> } => ({
  url: 'https://api.anthropic.com/v1/models?limit=1',
  headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01' }
})

const PROVIDERS: Record<string, AgentProvider> = {
  'claude-code': {
    label: 'Anthropic',
    request: (token) =>
      // An OAuth token (`sk-ant-oat…`) is not accepted by the public API and
      // has to go to the surface it belongs to — the exact call planUsage.ts
      // already makes, headers and all, because that path's edge is stricter
      // than the published API's and an anonymous-looking client lands in the
      // 429 lane regardless of its token.
      token.startsWith('sk-ant-oat')
        ? {
            url: 'https://api.anthropic.com/api/oauth/usage',
            headers: {
              Authorization: `Bearer ${token}`,
              'anthropic-beta': 'oauth-2025-04-20',
              'User-Agent': 'claude-cli/2.1.235 (external, cli)'
            }
          }
        : anthropicApiKey(token)
  },
  codex: {
    label: 'OpenAI',
    request: (token) => ({
      url: 'https://api.openai.com/v1/models',
      headers: { Authorization: `Bearer ${token}` }
    })
  },
  gemini: {
    label: 'Google',
    request: (token) => ({
      // Google's generative API takes the key in the query string; the header
      // form (`x-goog-api-key`) is equivalent and kept out of the URL for the
      // same reason a token never rides a log line.
      url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
      headers: { 'x-goog-api-key': token }
    })
  },
  opencode: { label: 'Anthropic', request: anthropicApiKey }
}

/** Whether this build can check a kind's token at all — the welcome screen
 *  says "not checked" rather than implying a pass. */
export const canProbeAgentToken = (kind: string): boolean => kind in PROVIDERS

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
  const provider = PROVIDERS[kind]
  if (!provider || !token.trim())
    return { verdict: 'unreachable', detail: `no token check exists for "${kind}" — not verified` }
  const { url, headers } = provider.request(token)
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

/** The env var name a kind's token lands in, for the field's hint — the string
 *  that tells a user *which* token they are being asked for. */
export const agentSecretEnv = (kind: string): string => agentDef(kind)?.secretEnv ?? ''
