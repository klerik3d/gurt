// Every executor's RPM switch and last-run status, for the scope rows' review
// slot (docs/requirements-scope-row-status.md §5). One `rpmOverview` read for
// the whole sidebar, re-read on the `rpm` event — not a `useRpm` per executor.
import { useEffect, useState } from 'react'
import type { RpmBrief } from '../../rpm/core'
import { logErr } from './log'

/** By executor id; empty until the first read answers. */
export function useRpmOverview(): Map<string, RpmBrief> {
  const [briefs, setBriefs] = useState<Map<string, RpmBrief>>(() => new Map())
  useEffect(() => {
    let live = true
    // One read in flight at a time: a burst of events (a run writes several
    // entries at a step) ends in one more read after the current one, which
    // sees them all.
    let inFlight = false
    let again = false
    const load = (): void => {
      if (inFlight) {
        again = true
        return
      }
      inFlight = true
      window.gurt
        .rpmOverview()
        .then((list) => {
          if (live) setBriefs(new Map(list.map((b) => [b.executor, b])))
        })
        .catch(logErr('rpmOverview'))
        .finally(() => {
          inFlight = false
          if (live && again) {
            again = false
            load()
          }
        })
    }
    load()
    const off = window.gurt.onRpm(load)
    return () => {
      live = false
      off()
    }
  }, [])
  return briefs
}
