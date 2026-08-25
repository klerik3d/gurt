import { useEffect, useMemo, useState } from 'react'
import type { McpDef, McpEntry, McpRegistryEntry } from '../../shared/mcp'
import { mcpEntries } from '../../shared/mcp'
import { logErr } from './log'

// Shared MCP lookup for the renderer: the built-ins main is willing to serve
// (`getMcpDefs`) unioned with the workspace's own registry (`getMcpServers`),
// in the one `McpEntry` shape the composer's picker and the session chips both
// read (docs/requirements-mcp-proxy.md §3.3).
//
// Cached per workspace and re-fetched on `tree.changed` — the signal every
// registry write already announces itself on (see `addMcpServer` in ipc.ts) —
// so a server added, renamed or deleted in Settings reaches the picker and the
// chips of every open session without a reload.

/** Built-ins, as main reports them. Global: they are code, not workspace data. */
let defs: McpDef[] | null = null
/** workspace → its registry, for every workspace some mounted hook has asked for. */
const registries = new Map<string, McpRegistryEntry[]>()
const subscribers = new Set<() => void>()
/** The one `tree.changed` subscription behind every hook instance. */
let unwatch: (() => void) | null = null

const notify = (): void => subscribers.forEach((fn) => fn())

function loadDefs(): void {
  window.gurt
    .getMcpDefs()
    .then((d) => {
      defs = d
      notify()
    })
    .catch(logErr('getMcpDefs'))
}

function loadRegistry(ws: string): void {
  window.gurt
    .getMcpServers(ws)
    .then((r) => {
      registries.set(ws, r)
      notify()
    })
    // A workspace that has gone away resolves to nothing rather than keeping a
    // stale registry alive — the ids in it can no longer be selected anyway.
    .catch(() => {
      registries.delete(ws)
      notify()
    })
}

/**
 * Every MCP server `ws` can offer a session, built-ins first. Empty until the
 * first fetch lands and for a null workspace, which is what a picker with
 * nothing selected yet should show.
 */
export function useMcpEntries(ws: string | null | undefined): McpEntry[] {
  const [tick, bump] = useState(0)

  useEffect(() => {
    const onChange = (): void => bump((n) => n + 1)
    subscribers.add(onChange)
    if (!defs) loadDefs()
    // Re-fetched on every mount, not only on a cache miss: the cache outlives
    // the hook (see the teardown), so a registry edited while nothing was
    // mounted would otherwise come back stale. The cached value is what renders
    // until this lands, so the picker never flashes empty.
    if (ws) loadRegistry(ws)
    if (!unwatch)
      unwatch = window.gurt.onTreeChanged(() => {
        loadDefs()
        for (const known of registries.keys()) loadRegistry(known)
      })
    return () => {
      subscribers.delete(onChange)
      // The registries stay cached: a session pane closing and reopening is the
      // common case, and the entries are a URL and a label each.
      if (subscribers.size === 0) {
        unwatch?.()
        unwatch = null
      }
    }
  }, [ws])

  return useMemo(
    () => mcpEntries(ws ? (registries.get(ws) ?? []) : [], defs ?? []),
    // `tick` is the dependency that matters — the caches it reads are module
    // state, and a notify is the only thing that changes them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws, tick]
  )
}
