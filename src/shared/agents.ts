// The agent registry, shared half: which agent kinds exist and what each one
// is, read from the built-in plugin list (src/plugins/agents/index.ts). Main
// and the renderer both reach agents through here (main's hooks through
// main/agentPlugins.ts) — nothing else in the core imports a plugin, and
// nothing in the core names a kind.
import type { AgentManifest, AgentPlugin } from './agentPlugin'
import { AGENT_PLUGINS } from '../plugins/agents'

/**
 * Refuse a list the registry cannot answer for unambiguously. Every lookup here
 * is by kind and takes the first match, so a second plugin claiming a kind
 * would be silently unreachable — and a sign-in with no name to show would
 * draw an empty button. Loud at load instead: the list is code, and a broken
 * one should not get as far as a window.
 */
export function assertAgentManifests(manifests: readonly AgentManifest[]): void {
  const seen = new Set<string>()
  for (const m of manifests) {
    if (!m.id) throw new Error('agent plugins: a manifest has an empty id')
    if (seen.has(m.id)) throw new Error(`agent plugins: kind "${m.id}" is declared twice`)
    seen.add(m.id)
    if (!!m.signIn !== (m.oauthProvider !== null))
      throw new Error(`agent plugins: "${m.id}" must name its sign-in (signIn) exactly when it has one (oauthProvider)`)
  }
}

/** Every known kind, in registry order — the order pickers list them in. */
export const AGENT_MANIFESTS: readonly AgentManifest[] = AGENT_PLUGINS.map((p) => p.manifest)
assertAgentManifests(AGENT_MANIFESTS)

/** The kind a new agent instance starts as (Welcome, Settings → Clients). */
export const DEFAULT_AGENT_KIND: string = AGENT_MANIFESTS[0]?.id ?? ''

/** One kind's plugin entry (manifest plus shared hooks), by kind. */
export const agentPlugin = (id: string | undefined): AgentPlugin | undefined =>
  id ? AGENT_PLUGINS.find((p) => p.manifest.id === id) : undefined

/** One kind's manifest, by kind — undefined for a kind no plugin provides
 *  (agents.json can outlive a plugin). */
export const agentDef = (id: string): AgentManifest | undefined => agentPlugin(id)?.manifest
