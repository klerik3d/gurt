/** Native settings are profile-scoped; paths are fixed, never user-supplied. */
export function clientConfigPath(kind: string): string | undefined {
  switch (kind) {
    case 'claude-code': return '.claude/settings.json'
    case 'pi': return '.pi/agent/settings.json'
    case 'opencode': return '.config/opencode/opencode.json'
    default: return undefined
  }
}

export function parseClientConfig(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text.trim() || '{}')
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Config JSON must be an object')
  }
  return value as Record<string, unknown>
}

export function clientConfigFile(kind: string, config: Record<string, unknown> | undefined):
  { path: string; content: string } | undefined {
  if (config === undefined) return undefined
  const path = clientConfigPath(kind)
  if (!path) throw new Error(`Native JSON config is not supported for ${kind}`)
  return { path, content: JSON.stringify(parseClientConfig(JSON.stringify(config)), null, 2) + '\n' }
}

export function clientConfigExample(kind: string): Record<string, unknown> {
  if (kind === 'claude-code') return { attribution: { commit: '', pr: '', sessionUrl: false } }
  if (kind === 'pi') return {
    defaultProvider: 'openrouter',
    defaultModel: 'anthropic/claude-sonnet-4.5'
  }
  if (kind === 'opencode') return {
    $schema: 'https://opencode.ai/config.json',
    model: 'openrouter/anthropic/claude-sonnet-4.5',
    provider: {
      openrouter: {
        options: { apiKey: '{env:OPENROUTER_API_KEY}' },
        models: { 'anthropic/claude-sonnet-4.5': {} }
      }
    }
  }
  return {}
}
