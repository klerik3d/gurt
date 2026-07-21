// Hardcoded base config surfaces per agent *kind* (see `AgentDef.id`). These
// seed the on-disk cache the first time an agent is used and are the fallback
// whenever no live session has refreshed it yet — so the New Session modal can
// offer model/effort choices without spinning up a container. Every real
// session start/load overwrites the cache with what the agent actually reports.
import type { AgentConfig, SessionConfigOption } from './types'

/** Effort levels offered by default; the live agent narrows these per model. */
const EFFORT_OPTIONS = [
  { value: 'default', name: 'Default' },
  { value: 'low', name: 'Low' },
  { value: 'medium', name: 'Medium' },
  { value: 'high', name: 'High' },
  { value: 'xhigh', name: 'Xhigh' },
  { value: 'max', name: 'Max' }
]

/** claude-code: family aliases, not pinned version IDs — the SDK/CLI resolves
 *  `opus`/`sonnet`/`haiku`/`fable` to the latest release of each family, so this
 *  seed never goes stale on a new model drop. A live session overwrites these
 *  with the exact IDs the account reports; the alias still applies fine via
 *  `_meta.claudeCode.options.model` in the meantime. */
const CLAUDE_MODELS: SessionConfigOption['options'] = [
  { value: 'opus', name: 'Opus', description: 'Most capable' },
  { value: 'sonnet', name: 'Sonnet', description: 'Balanced' },
  { value: 'fable', name: 'Fable', description: 'Fast, capable' },
  { value: 'haiku', name: 'Haiku', description: 'Fastest' }
]

const CLAUDE_DEFAULT: AgentConfig = {
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      description: 'AI model to use',
      category: 'model',
      type: 'select',
      currentValue: 'sonnet',
      options: CLAUDE_MODELS
    },
    {
      id: 'effort',
      name: 'Effort',
      description: 'How hard the model works before answering',
      category: 'thought_level',
      type: 'select',
      currentValue: 'default',
      options: EFFORT_OPTIONS
    },
    {
      id: 'fast',
      name: 'Fast mode',
      description: 'Faster responses on supported models',
      category: 'model_config',
      type: 'boolean',
      currentValue: false
    }
  ],
  commands: []
}

/** The seed config for an agent kind. Kinds with no known surface get an empty
 *  config (the live session fills it in on first start). */
export function defaultAgentConfig(kind: string): AgentConfig {
  switch (kind) {
    case 'claude-code':
      // Deep copy so callers can mutate the returned config freely.
      return structuredClone(CLAUDE_DEFAULT)
    default:
      return { configOptions: [], commands: [] }
  }
}
