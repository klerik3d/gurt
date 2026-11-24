import { useEffect, useState } from 'react'
import type { AgentConfig, AgentsFile } from '../../shared/types'
import { logErr } from './log'

// Shared agents cache: session chips resolve an agent instance id to its
// user-facing name (label), not the raw id/kind. One fetch is shared across
// every chip, and refreshAgents() re-broadcasts after the Agents editor saves
// so renamed labels update live.
let cache: AgentsFile | null = null
const subscribers = new Set<(a: AgentsFile) => void>()

function load(): void {
  window.gurt
    .getAgents()
    .then((a) => {
      cache = a
      subscribers.forEach((fn) => fn(a))
    })
    .catch(logErr('getAgents'))
}

/** Re-fetch agents and notify every mounted chip (call after saving edits). */
export function refreshAgents(): void {
  load()
}

export function useAgents(): AgentsFile {
  const [agents, setAgents] = useState<AgentsFile>(cache ?? {})
  useEffect(() => {
    subscribers.add(setAgents)
    if (cache) setAgents(cache)
    else load()
    return () => {
      subscribers.delete(setAgents)
    }
  }, [])
  return agents
}

/** The agent instance's user-facing name, falling back to its id if unknown. */
export const agentName = (agents: AgentsFile, id?: string): string =>
  (id && agents[id]?.label) || id || ''

/** The agent instance's kind (references `AgentManifest.id`), for icon lookup. */
export const agentKind = (agents: AgentsFile, id?: string): string | undefined =>
  id ? agents[id]?.kind : undefined

/** The agent instance's cached config surface (model/effort/… options,
 *  commands, modes), or null while it loads or with no agent. Kept current:
 *  main refreshes its cache whenever a live session of this agent reports a new
 *  option set (a start, a model switch), and a picker that read it once before
 *  that — a draft's Config tab, the Review tab's reviewer — would otherwise go
 *  on offering the stale list until it was remounted. */
export function useAgentConfig(agentId: string | undefined): AgentConfig | null {
  const [config, setConfig] = useState<AgentConfig | null>(null)
  useEffect(() => {
    setConfig(null)
    if (!agentId) return
    let live = true
    let seq = 0
    const read = (): void => {
      const mine = ++seq
      window.gurt
        .getAgentConfig(agentId)
        .then((c) => live && mine === seq && setConfig(c))
        .catch(() => live && mine === seq && setConfig(null))
    }
    read()
    // A session's snapshot carries the option set main just cached for its
    // agent; re-read only when that set actually moved.
    const seen = new Map<string, string>()
    const off = window.gurt.onSessionChanged((snap) => {
      if (snap.info.agent !== agentId || snap.info.state !== 'started') return
      const key = JSON.stringify([snap.configOptions ?? null, snap.modes ?? null])
      if (seen.get(snap.info.id) === key) return
      seen.set(snap.info.id, key)
      read()
    })
    return () => {
      live = false
      off()
    }
  }, [agentId])
  return config
}
