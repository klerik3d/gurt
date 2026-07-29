// Seed config surface per agent *kind* (see `AgentDef.id`) — used only until a
// live session reports its own configOptions/commands. Deliberately empty: the
// real claude-code ACP adapter builds its `model`/`effort`/`fast` options from
// the account's live model list and the SDK's per-model effort support, so a
// hardcoded guess here would drift from (and could misrepresent) what the
// agent actually offers. The New Session modal simply shows no config picker
// until the agent has run at least once and populated the cache.
import type { AgentConfig } from './types'

export function defaultAgentConfig(_kind: string): AgentConfig {
  return { configOptions: [], commands: [] }
}
