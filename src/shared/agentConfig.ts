// Seed config surface per agent *kind* (`AgentManifest.id`) — used only until a
// live session reports its own configOptions/commands. A kind's plugin may
// declare one (`seedConfig`) so the New Session modal and the composer offer a
// pick before the agent has ever run and populated the cache; every other kind
// gets nothing — a hardcoded guess for those would drift from (and could
// misrepresent) what the agent actually offers.
import type { AgentConfig, AgentOptionView, SessionConfigOption } from './agentPlugin'
import { agentDef, agentPlugin } from './agents'

export type { AgentOptionView }

export function defaultAgentConfig(kind: string): AgentConfig {
  const seed = agentDef(kind)?.seedConfig
  // A copy: the seed is the manifest's own data, and a caller owns what it gets.
  return seed ? structuredClone(seed) : { configOptions: [], commands: [] }
}

const neutral: AgentOptionView = {
  selectOptions: (opt) => opt.options ?? [],
  activeValue: (opt) => opt.currentValue
}

/**
 * How an agent kind's config options are *presented* (`AgentOptionView`).
 * Kinds with reporting quirks bring a view in their plugin; everyone else gets
 * the neutral pass-through, so callers dispatch by kind without knowing any
 * kind exists.
 */
export const agentOptionView = (kind?: string): AgentOptionView =>
  agentPlugin(kind)?.optionView ?? neutral

/**
 * Overlay a session's own picks (`SessionInfo.configValues`) on the agent's
 * live report, for display.
 *
 * An agent that echoes a concrete choice back is the truth and is left alone.
 * When it does not — an adapter that answers `session/set_config_option` and
 * then keeps reporting `currentValue: "default"` (claude-code's does) — the
 * pick is the truth, and it has to win: the `default` entry describes the
 * *account* fallback, so a session explicitly started on one model would
 * otherwise be shown (and read) as whatever that fallback is. A pick no chip
 * offers is ignored rather than asserted.
 */
export function withPickedValues(
  options: SessionConfigOption[],
  values: Record<string, string | boolean> | undefined,
  kind?: string
): SessionConfigOption[] {
  if (!values) return options
  const view = agentOptionView(kind)
  return options.map((o) => {
    const picked = values[o.id]
    if (o.type !== 'select' || typeof picked !== 'string') return o
    const chips = view.selectOptions(o)
    if (chips.some((c) => c.value === o.currentValue)) return o
    return chips.some((c) => c.value === picked) ? { ...o, currentValue: picked } : o
  })
}
