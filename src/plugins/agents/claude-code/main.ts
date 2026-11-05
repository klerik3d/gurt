// claude-code, main half: everything about Claude Code the main process has to
// run as code — the sign-in it borrows, the token probe, the `_meta` its
// adapter reads and writes, and the plan usage only Anthropic reports.
import { z } from 'zod'
import type {
  AgentLink,
  AgentMainPlugin,
  ConfigSelectOption,
  LivePlanState,
  PlanWindow,
  SessionConfigOption
} from '../../../shared/agentPlugin'
import { manifest } from './manifest'

const LABELS = manifest.planWindows?.labels ?? {}
const labelOf = (id: string): string => LABELS[id] ?? id.replace(/_/g, ' ')

// --- sign-in -------------------------------------------------------------------
//
// Anthropic sign-in — Claude subscription plans (claude.ai accounts).
//
// BORROWED CLIENT_ID (docs/requirements-oauth-credentials.md §3): this is the
// public OAuth client of Anthropic's own Claude Code CLI. gurt launches that
// exact CLI (./manifest.ts), so the token this flow mints is consumed by the
// client the id names. The registration is NOT ours: Anthropic can rotate,
// restrict or revoke it without notice, and this flow then breaks with no
// action on our side. That risk is accepted knowingly — if Claude sign-in
// suddenly fails, start here.

/** Anthropic's token response carries the account inline. */
const accountOf = (tokens: Record<string, unknown>): string => {
  const account = tokens['account']
  if (account && typeof account === 'object') {
    const email = (account as Record<string, unknown>)['email_address']
    if (typeof email === 'string') return email
  }
  return ''
}

// --- token probe ---------------------------------------------------------------

/** Anthropic's cheapest authenticated read — the API-key branch of the probe. */
const apiKeyProbe = (token: string): { url: string; headers: Record<string, string> } => ({
  url: 'https://api.anthropic.com/v1/models?limit=1',
  headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01' }
})

/** `sk-ant-oat…` — the usage endpoint authenticates a subscription's OAuth
 *  token, and an API key gets a 401 from it. Checked so a console-key agent is
 *  skipped with a reason instead of failing on every poll. */
export const isOauthToken = (secret: string): boolean => /^sk-ant-oat/.test(secret)

// --- config options ------------------------------------------------------------

const FABLE_OPTION: ConfigSelectOption = { value: 'fable', name: 'Fable' }
const isFable = (o: ConfigSelectOption): boolean =>
  o.value === FABLE_OPTION.value || /\bfable\b/i.test(o.name)

/** Force `fable` into a live-reported model select's options wherever the
 *  account's own report leaves it out — accounts have shipped `session/new`
 *  reports that silently drop it (see the manifest's `seedConfig`). */
export function withFable(options: ConfigSelectOption[]): ConfigSelectOption[] {
  return options.some(isFable) ? options : [FABLE_OPTION, ...options]
}

// --- plan usage ----------------------------------------------------------------
//
// Two sources. Live Claude SDK rate_limit_event snapshots are the primary one
// for token credentials: ACP forwards them as `usage_update._meta
// ['_claude/rateLimit']`, unifiedWindows utilization a fraction (0.7 means
// 70%). No profile scope or additional model request is needed; values update
// after normal responses. Browser OAuth credentials can also poll the usage
// endpoint.
//
// Provenance. `GET /api/oauth/usage` on api.anthropic.com is the call Claude
// Code's own `/usage` makes to draw its plan bars; it is not part of the
// published API. Everything here (the path, the window keys, the field names,
// the labels) was read out of the CLI binary the ACP adapter ships, not
// guessed — last re-verified against CLI 2.1.235, whose response schema is
// what `parsePlanWindows` documents. An unpublished endpoint can still change
// without notice, so a shape this does not recognize is "no data", never zero.
//
// It is worth the fragility because a plan's windows are pooled across every
// Claude surface and machine, while gurt's own ledger only counts the turns
// gurt ran.

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'

/** The usage endpoint's request, headers and all — shared by the poll and the
 *  OAuth-token probe. An OAuth token rides `Authorization`, never `x-api-key`,
 *  and the endpoint sits behind the same oauth beta gate as the rest of that
 *  surface. */
const usageHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  'anthropic-beta': 'oauth-2025-04-20',
  'Content-Type': 'application/json',
  // The CLI's own UA, verbatim. This path is unpublished and its edge is
  // stricter than the API proper — an anonymous client risks the 429 lane
  // regardless of its token, so the request mirrors the binary's exactly.
  'User-Agent': 'claude-cli/2.1.235 (external, cli)'
})

/** Order the meters render in; anything else — the model-scoped weeks among
 *  them, whose ids are dynamic — follows in reported order. */
const ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * One node of the response, read through the field spellings this endpoint is
 * known to use. Every member is optional and `.catch`es back to "absent", which
 * is what keeps the parser as tolerant as the hand-rolled reads it replaces: an
 * incomplete body, a window the plan is not metering (fields arrive `null`), or
 * a spelling that changes again all degrade to "no data" for that node, never
 * to a thrown parse. Loose: unknown members are what the walk below recurses
 * into.
 */
const USAGE_NODE = z.looseObject({
  // Reset instant. Three spellings in the wild, and either an ISO string or an
  // epoch number.
  resets_at: z.union([z.string(), z.number()]).nullish().catch(undefined),
  resetsAt: z.union([z.string(), z.number()]).nullish().catch(undefined),
  reset: z.union([z.string(), z.number()]).nullish().catch(undefined),
  // `percent` is the `limits[]` spelling, `utilization` the keyed one.
  utilization: z.number().nullish().catch(undefined),
  percent: z.number().nullish().catch(undefined),
  kind: z.string().nullish().catch(undefined),
  scope: z
    .looseObject({
      model: z.looseObject({ display_name: z.string().nullish().catch(undefined) }).nullish().catch(undefined),
      surface: z.looseObject({ display_name: z.string().nullish().catch(undefined) }).nullish().catch(undefined)
    })
    .nullish()
    .catch(undefined)
})
type UsageNode = z.infer<typeof USAGE_NODE>

/** The reset instant of one window object, in whatever form it arrived. */
function resetOf(o: UsageNode): string | undefined {
  const v = o.resets_at ?? o.resetsAt ?? o.reset
  if (typeof v === 'number') {
    // Seconds or milliseconds since the epoch — 1e12 is 2001 in ms, and no
    // plausible reset is 30,000 years out in seconds.
    const at = new Date(v < 1e12 ? v * 1000 : v)
    return Number.isNaN(at.getTime()) ? undefined : at.toISOString()
  }
  if (typeof v !== 'string') return undefined
  const at = new Date(v)
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString()
}

/** The utilization of one window object, or undefined if it carries none.
 *  (Both spellings arrive null on a window the plan has but is not metering.) */
function utilizationOf(o: UsageNode): number | undefined {
  const v = o.utilization ?? o.percent
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** The display name a `limits[]` entry is scoped to, if any — a model
 *  ("Fable") or a surface, whichever the entry carries. */
function scopeNameOf(o: UsageNode): string | undefined {
  for (const target of [o.scope?.model, o.scope?.surface]) {
    if (target?.display_name) return target.display_name
  }
  return undefined
}

/**
 * Pull the windows out of a `/api/oauth/usage` body.
 *
 * Two shapes exist in the wild, and a body may carry both at once:
 * - keyed: `{ five_hour: {utilization, resets_at}, seven_day: {…} }`
 * - listed: `{ limits: [{kind, percent, resets_at, scope: {model: {display_name}}}] }`
 *   — the newer form (CLI 2.1.x), and the only place model-scoped weeks
 *   ("Current week (Fable)") are reported.
 *
 * Structural in its walk, schema-bound per node: it descends the response
 * looking for objects that carry a utilization — keyed by name or describing
 * themselves via `kind` — at any depth, and reads each candidate through
 * {@link USAGE_NODE}. The exact nesting is the one thing that could not be read
 * off the binary, so the walk stays shape-agnostic; getting it wrong still
 * costs nothing — an unrecognized body yields an empty list, which every caller
 * already renders as "no data". Where both shapes report the same window the
 * keyed one wins (first found), so nothing draws twice.
 */
export function parsePlanWindows(body: unknown): PlanWindow[] {
  const found = new Map<string, PlanWindow>()
  const put = (id: string, label: string, util: number, resetsAt?: string): void => {
    if (!found.has(id))
      found.set(id, {
        id,
        label,
        utilization: Math.max(0, Math.min(100, util)),
        raw: util,
        ...(resetsAt ? { resetsAt } : {})
      })
  }
  const visit = (node: unknown, key: string | null, depth: number): void => {
    if (depth > 5) return
    if (Array.isArray(node)) {
      for (const el of node) visit(el, null, depth + 1)
      return
    }
    if (!isRecord(node)) return
    const parsed = USAGE_NODE.safeParse(node)
    if (!parsed.success) return
    const util = utilizationOf(parsed.data)
    const kind = parsed.data.kind ?? undefined
    if (kind && util !== undefined) {
      const base = labelOf(kind)
      const name = scopeNameOf(parsed.data)
      put(name ? `${kind}:${name}` : kind, name ? `${base} (${name})` : base, util, resetOf(parsed.data))
      return
    }
    if (key !== null && util !== undefined) {
      put(key, labelOf(key), util, resetOf(parsed.data))
      return
    }
    for (const [k, v] of Object.entries(node)) visit(v, k, depth + 1)
  }
  visit(body, null, 0)
  const known = ORDER.filter((id) => found.has(id)).map((id) => found.get(id)!)
  const rest = [...found.values()].filter((w) => !ORDER.includes(w.id))
  return [...known, ...rest]
}

/** SDK events use fractions (0.7 = 70%), unlike the usage endpoint's percent.
 * Confirmed with a setup-token response; never infer units from the value. */
export function parseClaudeRateLimit(body: unknown): PlanWindow[] {
  if (!isRecord(body)) return []
  const windows = isRecord(body['unifiedWindows'])
    ? body['unifiedWindows']
    : typeof body['rateLimitType'] === 'string'
      ? { [body['rateLimitType']]: body }
      : {}
  const out: PlanWindow[] = []
  for (const [id, value] of Object.entries(windows)) {
    const parsed = USAGE_NODE.safeParse(value)
    if (!parsed.success) continue
    const raw = parsed.data.utilization
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) continue
    const resetsAt = resetOf(parsed.data)
    out.push({
      id,
      label: labelOf(id),
      utilization: Math.min(100, raw * 100),
      raw,
      ...(resetsAt ? { resetsAt } : {})
    })
  }
  return out
}

/** What a live Claude rate-limit event says beyond the windows: whether the
 *  request was refused, and whether overage (extra usage) can absorb an
 *  exhausted window. `status` and `overageStatus` read `allowed`,
 *  `allowed_warning` or `rejected` (see LIVE_LIMIT in the tests). */
export function parseClaudeRateLimitState(body: unknown): LivePlanState {
  const windows = parseClaudeRateLimit(body)
  if (!isRecord(body)) return { windows }
  const status = body['status']
  const overageStatus = body['overageStatus']
  const reset = USAGE_NODE.safeParse(body)
  const resetsAt = reset.success ? resetOf(reset.data) : undefined
  return {
    windows,
    ...(typeof overageStatus === 'string' ? { overage: overageStatus.startsWith('allowed') } : {}),
    ...(typeof status === 'string' ? { rejected: status === 'rejected' } : {}),
    ...(status === 'rejected' && resetsAt ? { rejectedUntil: resetsAt } : {})
  }
}

/**
 * Can this account spend past an exhausted window, per a usage poll?
 * `extra_usage: { is_enabled, utilization }` — on, and not itself spent.
 * Anything absent or unreadable is "no": the hold is the safe side of a guess.
 */
export function parseOverage(body: unknown): boolean {
  if (!isRecord(body)) return false
  const x = body['extra_usage']
  if (!isRecord(x) || x['is_enabled'] !== true) return false
  const util = x['utilization']
  return typeof util !== 'number' || util < 100
}

// --- the plugin ----------------------------------------------------------------

export const main: AgentMainPlugin = {
  id: manifest.id,

  // §3.2 of docs/requirements-agent-history.md: pin the mangled-cwd directory
  // name this kind's own history keys by to a constant — the session id,
  // already what the host history directory is keyed by — so its history
  // survives a repo-set change too. An ordinary non-secret var.
  launchEnv: ({ sessionId }) => ({ CLAUDE_CODE_PROJECT_DIR_NAME: sessionId }),

  oauth: {
    client: {
      id: 'anthropic',
      authorizationEndpoint: 'https://claude.ai/oauth/authorize',
      tokenEndpoint: 'https://console.anthropic.com/v1/oauth/token',
      clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      scopes: ['org:create_api_key', 'user:profile', 'user:inference'],
      // Anthropic's endpoint takes JSON, not form encoding.
      tokenBody: 'json',
      authParams: { code: 'true' },
      // The borrowed registration pins its loopback redirect to this exact port
      // and hostname — a random port (the RFC 8252 default elsewhere) would be
      // rejected as an unregistered redirect_uri.
      port: 54545,
      redirectHost: 'localhost',
      redirectPath: '/callback'
    },
    account: accountOf
  },

  probeToken: (token) =>
    // An OAuth token (`sk-ant-oat…`) is not accepted by the public API and
    // has to go to the surface it belongs to — the exact call the plan-usage
    // poll makes, headers and all, because that path's edge is stricter than
    // the published API's and an anonymous-looking client lands in the 429
    // lane regardless of its token.
    token.startsWith('sk-ant-oat')
      ? {
          label: 'Anthropic',
          url: USAGE_ENDPOINT,
          headers: {
            Authorization: `Bearer ${token}`,
            'anthropic-beta': 'oauth-2025-04-20',
            'User-Agent': 'claude-cli/2.1.235 (external, cli)'
          }
        }
      : { label: 'Anthropic', ...apiKeyProbe(token) },

  // Only claude-agent-acp honors `_meta.claudeCode.options`; model and effort
  // map onto the SDK's query options there (effort `default` means "don't set
  // it"). Sent on `session/new` so the very first turn already runs on them,
  // and on `session/load` too: a pinned model (e.g. fable) only appears in the
  // CLI's model picker when the CLI is launched with it pinned, so a reload
  // without it brings up an adapter whose picker forgot the pin, and the next
  // `session/set_config_option` for it is rejected as an invalid value.
  sessionMeta: (configValues) => {
    const options: Record<string, string> = {}
    const model = configValues['model']
    const effort = configValues['effort']
    if (typeof model === 'string' && model) options['model'] = model
    if (typeof effort === 'string' && effort && effort !== 'default') options['effort'] = effort
    if (!Object.keys(options).length) return undefined
    return { claudeCode: { options } }
  },

  normalizeConfigOptions: (options: SessionConfigOption[]) =>
    options.map((o) =>
      o.type === 'select' && o.category === 'model' ? { ...o, options: withFable(o.options ?? []) } : o
    ),

  usageMeta: (meta) => parseClaudeRateLimitState(meta?.['_claude/rateLimit']),

  planUsage: {
    eligible: ({ secret, credential }: AgentLink) => {
      // Not a failure and not worth retrying: an API-key agent bills per
      // token and has no plan window to report.
      if (!secret || !isOauthToken(secret)) return { error: 'no subscription token linked', live: true }
      // setup-token can run inference but lacks user:profile. Its real limits
      // arrive with normal session responses; never poll it into repeated 403s.
      if (credential?.kind === 'agent-token')
        return { error: 'waiting for usage from a Claude response', live: true }
      return true
    },
    request: ({ secret }) => ({ url: USAGE_ENDPOINT, headers: usageHeaders(secret) }),
    parse: (body) => ({ windows: parsePlanWindows(body), overage: parseOverage(body) })
  }
}
