// Seed config surface per agent *kind* (see `AgentDef.id`) — used only until a
// live session reports its own configOptions/commands. Deliberately empty: the
// real claude-code ACP adapter builds its `model`/`effort`/`fast` options from
// the account's live model list and the SDK's per-model effort support, so a
// hardcoded guess here would drift from (and could misrepresent) what the
// agent actually offers. The New Session modal simply shows no config picker
// until the agent has run at least once and populated the cache.
import type { AgentConfig, SessionConfigOption } from './types'

export function defaultAgentConfig(_kind: string): AgentConfig {
  return { configOptions: [], commands: [] }
}

/**
 * The concrete model a `model` option is really on, for highlighting the picker.
 *
 * The claude-code ACP adapter reports the model option's `currentValue` as the
 * literal alias `"default"` and never rewrites it to the model that actually
 * ran (`currentModelId` stays `"default"` across a turn) — the sole hint is the
 * `default` entry's own description, e.g. "Use the default model (currently
 * Opus 5 (1M context)) · …". We hide the `default` chip (it's the absence of a
 * choice, not one), so without this the picker would highlight nothing even
 * while a concrete model is running. Map the alias back to a concrete option by
 * the family word after "currently". Best-effort and display-only: returns the
 * value unchanged when nothing resolves, so it can never break selection.
 */
export function resolveModelValue(opt: SessionConfigOption): string | boolean {
  const cur = opt.currentValue
  if (typeof cur !== 'string') return cur
  const opts = opt.options ?? []
  // An explicit concrete pick already lines up with a visible chip.
  if (opts.some((o) => o.value === cur && o.value !== 'default')) return cur
  // Resolve the "default" alias via its description's "(currently <Family> …)".
  const family = opts.find((o) => o.value === cur)?.description?.match(/currently\s+([A-Za-z]+)/i)?.[1]
  if (family) {
    const hit = opts.find(
      (o) => o.value !== 'default' && o.name.toLowerCase().startsWith(family.toLowerCase())
    )
    if (hit) return hit.value
  }
  return cur
}
