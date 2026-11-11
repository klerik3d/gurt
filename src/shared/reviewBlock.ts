// The review loop's Review block, as pure rules (docs/requirements-review-loop.md
// §3): which agent is offered as reviewer, which one is the default, whether a
// block may start, and what a new block is prefilled with. The Config tab and
// Settings → Repos draw on these and main enforces the same functions at the
// IPC boundary, so the UI's "Run disabled" and the host's refusal cannot
// disagree. No I/O; tested in plain node (scripts/review-block.test.mjs).
import { agentOptionView } from './agentConfig'
import { agentDef } from './agents'
import type { CredentialEntry } from './credentials'
import { oauthSignedOut } from './credentials'
import { ladderFor } from './reviewLoop'
import type {
  AgentConfig,
  AgentsFile,
  RepoConfig,
  ReviewLoopConfig,
  SessionConfigOption,
  ShipRung
} from './types'
import { REVIEW_LOOP_DEFAULTS, REVIEW_MAX_ROUNDS, SHIP_RUNGS } from './types'

export { ladderFor }

/** How each rung reads in a picker (§3 "When clean"): each includes the ones
 *  below it, `merge` being the local repos' stand-in for push / pr. */
export const RUNG_LABEL: Record<ShipRung, string> = {
  notify: 'notify',
  commit: 'commit',
  push: 'commit + push',
  pr: 'commit + push + PR',
  merge: 'commit + merge into main'
}

/** Whether an agent *kind* receives gurt's MCP server (`AgentManifest.acpMcp`;
 *  absent = yes). Both loop tools are gurt MCP tools with no text fallback, so
 *  a kind that does not receive them is neither executor nor reviewer (§3). A
 *  kind no plugin provides cannot run at all. */
export function agentReceivesMcp(kind: string | undefined): boolean {
  const def = kind ? agentDef(kind) : undefined
  return !!def && def.acpMcp !== false
}

/** The ids the reviewer picker offers, in picker order (the agent registry's
 *  order, as the session's own agent picker lists them): not denied in the
 *  workspace, and a kind that receives gurt's MCP server. */
export function reviewerCandidates(agents: AgentsFile, deniedAgents: readonly string[]): string[] {
  return Object.entries(agents)
    .filter(([id, a]) => !deniedAgents.includes(id) && agentReceivesMcp(a.kind))
    .map(([id]) => id)
}

/** A linked `credentialId` that resolves to an agent credential and, for an
 *  `oauth` one, is not signed out (§3). An instance with no link is not
 *  "usable" here: the default reviewer must be one that can authenticate. */
export function credentialUsable(
  credentialId: string | undefined,
  credentials: readonly CredentialEntry[]
): boolean {
  if (!credentialId) return false
  const entry = credentials.find((c) => c.id === credentialId)
  if (!entry || (entry.kind !== 'agent-token' && entry.kind !== 'oauth')) return false
  return !oauthSignedOut(entry)
}

/** §3 "Default reviewer": an instance of a **different kind** than the
 *  executor's with a usable credential, else one of the same kind — picker
 *  order decides among candidates, and another instance is preferred over the
 *  executor's own. `undefined` when nothing qualifies. With no executor agent
 *  picked yet nothing is "the same kind", so the first usable candidate wins. */
export function defaultReviewer(input: {
  executorAgent: string | undefined
  agents: AgentsFile
  deniedAgents: readonly string[]
  credentials: readonly CredentialEntry[]
}): string | undefined {
  const { executorAgent, agents, deniedAgents, credentials } = input
  const executorKind = executorAgent ? agents[executorAgent]?.kind : undefined
  const candidates = reviewerCandidates(agents, deniedAgents)
  const usable = (id: string): boolean => credentialUsable(agents[id]?.credentialId, credentials)
  const different = candidates.filter((id) => agents[id]?.kind !== executorKind || executorKind === undefined)
  const found = different.find(usable)
  if (found) return found
  const same = candidates.filter((id) => executorKind !== undefined && agents[id]?.kind === executorKind)
  // Another instance of the kind before the executor's own; among the others,
  // one that can authenticate first.
  const others = same.filter((id) => id !== executorAgent)
  return others.find(usable) ?? others[0] ?? same.find((id) => id === executorAgent)
}

/** The model an agent would run with, for the "differs in model" rule: the
 *  `model`-category select option's value — the pick if there is one, else
 *  what the agent reports (through the kind's option view, so claude-code's
 *  `default` is read the way the chips read it). `undefined` when the config
 *  surface reports no model option at all. */
export function modelOf(
  kind: string | undefined,
  config: AgentConfig | null | undefined,
  values: Record<string, string | boolean> | undefined
): string | undefined {
  const opt: SessionConfigOption | undefined = config?.configOptions.find((o) => o.category === 'model')
  if (!opt || opt.type !== 'select') return undefined
  const picked = values?.[opt.id]
  if (typeof picked === 'string') return picked
  const active = agentOptionView(kind).activeValue(opt)
  return typeof active === 'string' ? active : undefined
}

/** What `validateReviewBlock` reads beyond the block: the registry, the
 *  workspace's deny list, and each agent instance's config surface (the cached
 *  or seed one — `getAgentConfig`) for its model. */
export interface ReviewBlockContext {
  agents: AgentsFile
  deniedAgents: readonly string[]
  configs: Readonly<Record<string, AgentConfig | null | undefined>>
}

/** The session a block belongs to. */
export interface ReviewExecutor {
  role?: string | undefined
  agent: string | undefined
  configValues?: Record<string, string | boolean> | undefined
}

/**
 * Why a Review block may not start (§3 "Validation"), or `null` when it may:
 *
 * - the session is an executor, on an agent that receives gurt's MCP server;
 * - the reviewer names an existing agent, not denied in the workspace, that
 *   receives gurt's MCP server;
 * - the reviewer differs from the executor in agent instance or in model;
 * - `maxRounds` is within bounds and `whenClean` is on the repos' ladder (when
 *   `ladder` is given).
 *
 * `executor` absent validates a repo's *defaults* (Settings → Repos): the
 * executor is not known there, so only the reviewer's own conditions apply.
 * The first reason found is the one shown.
 */
export function validateReviewBlock(
  block: ReviewLoopConfig,
  executor: ReviewExecutor | undefined,
  ctx: ReviewBlockContext,
  ladder?: readonly ShipRung[]
): string | null {
  if (executor) {
    if (executor.role !== undefined && executor.role !== 'executor')
      return 'the review loop is for executor sessions'
    const own = executor.agent ? ctx.agents[executor.agent] : undefined
    if (!own) return 'pick the session’s own agent first'
    if (!agentReceivesMcp(own.kind))
      return `${agentDef(own.kind)?.label ?? own.kind} does not receive gurt’s tools, so it cannot run a review loop`
  }
  if (!block.agent) return 'pick a reviewer'
  const reviewer = ctx.agents[block.agent]
  if (!reviewer) return `the reviewer “${block.agent}” no longer exists`
  if (ctx.deniedAgents.includes(block.agent)) return `the reviewer “${reviewer.label}” is denied in this workspace`
  if (!agentReceivesMcp(reviewer.kind))
    return `${agentDef(reviewer.kind)?.label ?? reviewer.kind} does not receive gurt’s tools, so it cannot be the reviewer`
  if (executor?.agent === block.agent) {
    const exModel = modelOf(reviewer.kind, ctx.configs[block.agent], executor.configValues)
    const rvModel = modelOf(reviewer.kind, ctx.configs[block.agent], block.configValues)
    if (exModel === undefined || rvModel === undefined)
      return 'the reviewer is the session’s own agent and reports no model to tell them apart — pick another agent'
    if (exModel === rvModel) return 'the reviewer is the same agent and model as the session — pick another agent or model'
  }
  if (
    !Number.isInteger(block.maxRounds) ||
    block.maxRounds < REVIEW_MAX_ROUNDS.min ||
    block.maxRounds > REVIEW_MAX_ROUNDS.max
  )
    return `rounds must be ${REVIEW_MAX_ROUNDS.min}–${REVIEW_MAX_ROUNDS.max}`
  if (!SHIP_RUNGS.includes(block.whenClean)) return `unknown “when clean” step “${String(block.whenClean)}”`
  if (ladder && !ladder.includes(block.whenClean))
    return `“${RUNG_LABEL[block.whenClean]}” is not available for these repositories`
  return null
}

/** A rung the repos' ladder can deliver: the one asked for if offered, else
 *  `commit` (the safe step down), else `notify`. */
export function clampRung(rung: ShipRung, ladder: readonly ShipRung[]): ShipRung {
  if (ladder.includes(rung)) return rung
  return ladder.includes('commit') ? 'commit' : 'notify'
}

/** `maxRounds` as an integer within bounds; anything else the default. */
export function clampRounds(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return REVIEW_MAX_ROUNDS.default
  return Math.min(REVIEW_MAX_ROUNDS.max, Math.max(REVIEW_MAX_ROUNDS.min, Math.round(n)))
}

/** A new draft's Review block (§3 "prefilled from the anchor's defaults"):
 *  the anchor repo's `review` defaults over the global ones; the reviewer is
 *  the repo's named one, else `fallbackAgent` (the cross-kind default), else
 *  empty — "pick a reviewer". A named reviewer that has since gone is kept as
 *  named: validation says so, rather than the block silently choosing again. */
export function seedReviewBlock(
  defaults: RepoConfig['review'],
  fallbackAgent: string | undefined,
  ladder: readonly ShipRung[]
): ReviewLoopConfig {
  const configValues = defaults?.agent ? defaults.configValues : undefined
  return {
    agent: defaults?.agent || fallbackAgent || '',
    ...(configValues && Object.keys(configValues).length ? { configValues: { ...configValues } } : {}),
    maxRounds: clampRounds(defaults?.maxRounds ?? REVIEW_LOOP_DEFAULTS.maxRounds),
    whenClean: clampRung(defaults?.whenClean ?? REVIEW_LOOP_DEFAULTS.whenClean, ladder),
    draftPr: defaults?.draftPr ?? REVIEW_LOOP_DEFAULTS.draftPr
  }
}

/** Whether the anchor's defaults turn the loop on for a new draft. */
export const reviewEnabledByDefault = (defaults: RepoConfig['review']): boolean => defaults?.enabled === true

/** The rounds a picker offers: every integer `maxRounds` allows. */
export const REVIEW_ROUNDS: readonly number[] = Array.from(
  { length: REVIEW_MAX_ROUNDS.max - REVIEW_MAX_ROUNDS.min + 1 },
  (_, i) => REVIEW_MAX_ROUNDS.min + i
)

/** What the renderer last prefilled into a draft, and from which anchor. */
export interface SeededReview {
  anchor: string
  block: ReviewLoopConfig
}

/** Field-by-field equality of two blocks (`configValues` by entry, not by key order). */
export function sameReviewBlock(a: ReviewLoopConfig, b: ReviewLoopConfig): boolean {
  const av = Object.entries(a.configValues ?? {})
  return (
    a.agent === b.agent &&
    a.maxRounds === b.maxRounds &&
    a.whenClean === b.whenClean &&
    a.draftPr === b.draftPr &&
    av.length === Object.keys(b.configValues ?? {}).length &&
    av.every(([k, v]) => b.configValues?.[k] === v)
  )
}

/**
 * Whether the anchor's defaults still owe the draft a prefilled block (§3) —
 * decided from the draft alone, so it holds on whichever tab is showing and
 * Run can wait for it. Due when the anchor's defaults turn the loop on and
 *
 * - the draft has no block and its owner did not switch it off (`reviewOff`), or
 * - it has one that is still exactly what an *earlier* anchor prefilled
 *   (`seeded`): the user has not touched it, so swapping the anchor swaps the
 *   defaults. An edited block, or one the user switched on themselves, is
 *   never overwritten.
 */
export function reviewSeedDue(input: {
  executor: boolean
  review: ReviewLoopConfig | undefined
  reviewOff: boolean
  anchor: RepoConfig | undefined
  seeded: SeededReview | undefined
}): boolean {
  const { executor, review, reviewOff, anchor, seeded } = input
  if (!executor || reviewOff || !anchor || !reviewEnabledByDefault(anchor.review)) return false
  if (!review) return true
  return !!seeded && seeded.anchor !== anchor.name && sameReviewBlock(seeded.block, review)
}

/** An untrusted Review block (an IPC patch, a hand-edited file) as a
 *  `ReviewLoopConfig`: wrong-typed fields degrade to the defaults, rounds are
 *  clamped, an unknown rung falls to `notify`. Never throws. */
export function sanitizeReviewBlock(raw: unknown): ReviewLoopConfig {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const cv = r['configValues']
  const values =
    cv && typeof cv === 'object' && !Array.isArray(cv)
      ? Object.entries(cv).filter(([, v]) => typeof v === 'string' || typeof v === 'boolean')
      : []
  return {
    agent: typeof r['agent'] === 'string' ? r['agent'] : '',
    ...(values.length ? { configValues: Object.fromEntries(values) } : {}),
    maxRounds: clampRounds(r['maxRounds']),
    whenClean: SHIP_RUNGS.includes(r['whenClean'] as ShipRung) ? (r['whenClean'] as ShipRung) : REVIEW_LOOP_DEFAULTS.whenClean,
    draftPr: typeof r['draftPr'] === 'boolean' ? r['draftPr'] : REVIEW_LOOP_DEFAULTS.draftPr
  }
}

/** The ladder for a draft: the `RepoConfig`s of the repos it mounts for
 *  `write` — the ones delivery touches (§3). Unknown names are skipped. */
export function ladderOfRepos(writeRepoNames: readonly string[], repos: readonly RepoConfig[]): ShipRung[] {
  return ladderFor(repos.filter((r) => writeRepoNames.includes(r.name)))
}
