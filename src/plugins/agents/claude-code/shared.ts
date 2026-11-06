// claude-code, shared half: how its config options are presented. Pure — the
// renderer runs it too.
import type { AgentOptionView, AgentPlugin, SessionConfigOption } from '../../../shared/agentPlugin'

/**
 * claude-code's adapter reports a literal `"default"` select entry — the
 * absence of a choice, not one — and for the model option never rewrites
 * `currentValue` to the model that actually ran (`currentModelId` stays
 * `"default"` across a turn). The default entry's own description is the sole
 * hint: "Use the default model (currently Opus 5 (1M context)) · …". So: hide
 * the `default` chip, and highlight the concrete model the description names.
 *
 * It also answers `session/set_config_option` and then keeps reporting
 * `currentValue: "default"` — which is why the core overlays a session's own
 * picks on the report (`withPickedValues`) before this view reads it.
 */
const optionView: AgentOptionView = {
  selectOptions: (opt) => (opt.options ?? []).filter((o) => o.value !== 'default'),
  activeValue: (opt) => (opt.category === 'model' ? resolveClaudeModel(opt) : opt.currentValue)
}

export const shared: Omit<AgentPlugin, 'manifest'> = { optionView }

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
  if (!family) return cur
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
  return candidates.length === 1 ? (candidates[0]?.value ?? cur) : cur
}
