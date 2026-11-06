// The agent registry, main half: each kind's main-process hooks, read from the
// built-in plugin list (src/plugins/agents/main.ts). The shared half — which
// kinds exist and their manifests — is shared/agents.ts.
//
// Every hook is optional, and a kind without a main half has none: callers
// treat a missing hook as "this agent does not have the feature".
import type { AgentMainPlugin, AgentManifest } from '../shared/agentPlugin'
import { AGENT_MANIFESTS } from '../shared/agents'
import { AGENT_MAIN_PLUGINS } from '../plugins/agents/main'

/**
 * Refuse a main list that does not line up with the manifests. Lookups take
 * the first match and the sign-in table is keyed by provider id, so a
 * duplicate would win or lose silently; a main half with no manifest is a
 * kind nobody can pick; a sign-in must be the one its own manifest names,
 * and every sign-in a manifest names must be declared — else its button runs
 * a flow that does not exist.
 */
export function assertAgentMains(manifests: readonly AgentManifest[], mains: readonly AgentMainPlugin[]): void {
  const kinds = new Set<string>()
  const providers = new Set<string>()
  for (const p of mains) {
    if (kinds.has(p.id)) throw new Error(`agent plugins: kind "${p.id}" has two main halves`)
    kinds.add(p.id)
    const manifest = manifests.find((m) => m.id === p.id)
    if (!manifest) throw new Error(`agent plugins: main half "${p.id}" has no manifest`)
    if (!p.oauth) continue
    const id = p.oauth.client.id
    if (providers.has(id)) throw new Error(`agent plugins: sign-in "${id}" is declared twice`)
    providers.add(id)
    if (manifest.oauthProvider !== id)
      throw new Error(`agent plugins: "${p.id}" declares sign-in "${id}" but its manifest names "${manifest.oauthProvider}"`)
  }
  for (const m of manifests)
    if (m.oauthProvider !== null && !providers.has(m.oauthProvider))
      throw new Error(`agent plugins: "${m.id}" names sign-in "${m.oauthProvider}", which no main half declares`)
}

assertAgentMains(AGENT_MANIFESTS, AGENT_MAIN_PLUGINS)

/** The main-process hooks of one kind — undefined when it has none. */
export const agentMain = (kind: string | undefined): AgentMainPlugin | undefined =>
  kind ? AGENT_MAIN_PLUGINS.find((p) => p.id === kind) : undefined

/** Every kind's main-process hooks, in registry order. */
export const agentMains = (): readonly AgentMainPlugin[] => AGENT_MAIN_PLUGINS
