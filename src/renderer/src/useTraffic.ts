import { useEffect, useState } from 'react'
import type { SessionTraffic } from '../../shared/proxy'
import { emptyTraffic } from '../../shared/proxy'
import { logErr } from './log'

// What one session's proxy has been seen doing (docs/requirements-mcp-proxy.md
// §8), for the panes that show it.
//
// Not cached across mounts like `useAgents`/`useMcp` are: the ledger lives in
// main and is already bounded there, the pull is one IPC call, and a stale
// blocked list is exactly the thing this surface must not show — a host that
// was unblocked a minute ago has to stop being an explanation.

/** The session's traffic, live. Empty (never null) before the first pull lands,
 *  so a caller renders "nothing observed" rather than branching on absence. */
export function useSessionTraffic(sessionId: string): SessionTraffic {
  const [traffic, setTraffic] = useState<SessionTraffic>(() => emptyTraffic(sessionId))

  useEffect(() => {
    let live = true
    // The pull covers everything observed before this pane existed; the
    // subscription covers everything after. Both are needed: main coalesces
    // changes, so a quiet session emits nothing at all.
    setTraffic(emptyTraffic(sessionId))
    window.gurt
      .sessionTraffic(sessionId)
      .then((t) => live && setTraffic(t))
      .catch(logErr('sessionTraffic'))
    const off = window.gurt.onProxyTraffic((t) => {
      if (live && t.session === sessionId) setTraffic(t)
    })
    return () => {
      live = false
      off()
    }
  }, [sessionId])

  return traffic
}
