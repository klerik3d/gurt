// Seed config surface per agent *kind* (see `AgentDef.id`) — used only until a
// live session reports its own configOptions/commands. Deliberately empty: the
// real claude-code ACP adapter builds its `model`/`effort`/`fast` options from
// the account's live model list and the SDK's per-model effort support, so a
// hardcoded guess here would drift from (and could misrepresent) what the
// agent actually offers. The New Session modal simply shows no config picker
// until the agent has run at least once and populated the cache.
import type { AgentConfig, ConfigSelectOption, SessionConfigOption } from './types'

export function defaultAgentConfig(_kind: string): AgentConfig {
  return { configOptions: [], commands: [] }
}

/**
 * How an agent kind's config options are *presented* — which select entries
 * become chips and which value reads as active. Pure display: nothing here may
 * change what is sent back to the agent. Kinds with reporting quirks register
 * an entry in `VIEWS`; everyone else gets the neutral pass-through, so callers
 * dispatch by kind without knowing any kind exists.
 */
export interface AgentOptionView {
  /** The entries to render as chips for a select option. */
  selectOptions(opt: SessionConfigOption): ConfigSelectOption[]
  /** The value to highlight as active. */
  activeValue(opt: SessionConfigOption): string | boolean
}

const neutral: AgentOptionView = {
  selectOptions: (opt) => opt.options ?? [],
  activeValue: (opt) => opt.currentValue
}

/**
 * claude-code's adapter reports a literal `"default"` select entry — the
 * absence of a choice, not one — and for the model option never rewrites
 * `currentValue` to the model that actually ran (`currentModelId` stays
 * `"default"` across a turn). The default entry's own description is the sole
 * hint: "Use the default model (currently Opus 5 (1M context)) · …". So: hide
 * the `default` chip, and highlight the concrete model the description names.
 */
const claudeCode: AgentOptionView = {
  selectOptions: (opt) => (opt.options ?? []).filter((o) => o.value !== 'default'),
  activeValue: (opt) => (opt.category === 'model' ? resolveClaudeModel(opt) : opt.currentValue)
}

const VIEWS: Record<string, AgentOptionView> = { 'claude-code': claudeCode }

/** The option view for an agent kind — neutral pass-through when none registered. */
export const agentOptionView = (kind?: string): AgentOptionView =>
  (kind && VIEWS[kind]) || neutral

/**
 * Map claude-code's `"default"` model alias to the concrete option its
 * description names. Matching is on family *and* version ("Opus 5", not just
 * "Opus"): an account can offer several models of one family (e.g. Opus 5
 * alongside Opus 4.8), and a family-only match would highlight whichever
 * happens to be listed first. Best-effort and display-only: returns the value
 * unchanged when nothing resolves unambiguously, so it can never break
 * selection.
 */
function resolveClaudeModel(opt: SessionConfigOption): string | boolean {
  const cur = opt.currentValue
  if (typeof cur !== 'string') return cur
  const opts = opt.options ?? []
  // An explicit concrete pick already lines up with a visible chip.
  if (opts.some((o) => o.value === cur && o.value !== 'default')) return cur
  // "…(currently Opus 5 (1M context))…" → family "opus", version "5".
  const target = opts
    .find((o) => o.value === cur)
    ?.description?.match(/currently\s+([A-Za-z]+)\s*([\d.]+)?/i)
  if (!target) return cur
  const [, family, version] = target
  // A candidate must agree on family and, when the default names one, version —
  // read from the candidate's own name/description ("Opus (1M context)" carries
  // its version only in "Opus 5 with 1M context").
  const candidates = opts.filter((o) => {
    if (o.value === 'default') return false
    const text = `${o.name} ${o.description ?? ''}`.toLowerCase()
    if (!text.includes(family.toLowerCase())) return false
    if (!version) return true
    return new RegExp(`${family}\\s*${version.replace('.', '\\.')}\\b`, 'i').test(text)
  })
  // Ambiguity is worse than no highlight — it would assert the wrong model.
  return candidates.length === 1 ? candidates[0].value : cur
}
