import { useEffect, useMemo, useState } from 'react'
import type { McpDef, McpEntry, McpFailure, McpRegistryEntry } from '../../shared/mcp'
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

// --- local servers that did not start (docs/requirements-mcp-stdio.md §8.2) --
//
// A local entry is a process, and a process fails in ways a URL does not: its
// package will not install, its command is gone, its credential does not
// resolve. Main logs the reason (`mcp.fail`) and publishes the set per session;
// this is where the session pane reads it, so the user sees it where they work
// instead of in ~/.gurt/logs.
//
// Cached module-side, like the registries above: a pane unmounts and remounts
// every time the user looks at another session, and the failure of a start that
// happened once must survive that.

/** sessionId → what it selected and did not get. Whole sets, never deltas — an
 *  empty one is main saying the session has recovered. */
const failures = new Map<string, McpFailure[]>()
const failSubscribers = new Set<() => void>()

// Subscribed at module load, not on first mount, and never torn down: a session
// started by the scheduler can fail to get a server while the user is looking at
// Settings, and an event nobody was listening for is simply gone — unlike a
// registry, there is nothing to re-fetch. (A window reload does lose them; the
// reason is still in the app log, which is what `mcp.fail` is for.)
window.gurt.onMcpFail(({ sessionId, failures: list }) => {
  if (list.length) failures.set(sessionId, list)
  else failures.delete(sessionId)
  failSubscribers.forEach((fn) => fn())
})

/** Every local MCP server this session asked for and did not get, with the
 *  reason. Empty when everything it selected is running — which is the normal
 *  case, so the pane renders nothing at all. */
export function useMcpFailures(sessionId: string): McpFailure[] {
  const [tick, bump] = useState(0)

  useEffect(() => {
    const onChange = (): void => bump((n) => n + 1)
    failSubscribers.add(onChange)
    return () => {
      failSubscribers.delete(onChange)
    }
  }, [])

  return useMemo(
    () => failures.get(sessionId) ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, tick]
  )
}
