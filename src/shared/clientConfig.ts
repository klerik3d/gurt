// A client's native settings file: an agent instance's config JSON, written on
// every adapter launch to the path its kind's plugin names
// (`AgentManifest.clientConfig`). Kinds without one take no config JSON.
import type { JsonObject } from './agentPlugin'
import { agentDef } from './agents'

/** Native settings are profile-scoped; paths are fixed, never user-supplied. */
export function clientConfigPath(kind: string): string | undefined {
  return agentDef(kind)?.clientConfig?.path
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

/** What the config field's example button fills in — {} for a kind with none. */
export function clientConfigExample(kind: string): JsonObject {
  const example = agentDef(kind)?.clientConfig?.example.config
  return example ? structuredClone(example) : {}
}
