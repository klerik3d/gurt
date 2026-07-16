import { useEffect, useState } from 'react'
import type { AgentsFile } from '../../shared/types'

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
    .catch(console.error)
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
