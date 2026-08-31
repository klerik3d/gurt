import { useEffect, useMemo, useState } from 'react'
import type { SkillEntry } from '../../shared/skills'
import { skillEntries } from '../../shared/skills'

// Shared skill lookup for the renderer: the workspace's registry as main reads
// it off disk (`getSkills`), in the one `SkillEntry` shape the draft's picker,
// the live session's tags and the Settings list all read
// (docs/requirements-skills.md §7).
//
// Cached per workspace and re-fetched on `tree.changed` — the signal every
// registry write announces itself on (see `addSkill` in ipc.ts) — so a skill
// added, edited or deleted in Settings reaches the picker of every open session
// without a reload. The same shape as `useMcp.ts`, deliberately: one registry
// cache pattern, not two.

/** workspace → its skills, for every workspace some mounted hook has asked for. */
const registries = new Map<string, SkillEntry[]>()
const subscribers = new Set<() => void>()
/** The one `tree.changed` subscription behind every hook instance. */
let unwatch: (() => void) | null = null

const notify = (): void => subscribers.forEach((fn) => fn())

function loadSkills(ws: string): void {
  window.gurt
    .getSkills(ws)
    .then((s) => {
      registries.set(ws, s)
      notify()
    })
    // A workspace that has gone away resolves to nothing rather than keeping a
    // stale registry alive — the names in it can no longer be selected anyway.
    .catch(() => {
      registries.delete(ws)
      notify()
    })
}

/**
 * Every skill `ws` can offer a session, in name order. Empty until the first
 * fetch lands and for a null workspace, which is what a picker with nothing
 * selected yet should show.
 */
export function useSkillEntries(ws: string | null | undefined): SkillEntry[] {
  const [tick, bump] = useState(0)

  useEffect(() => {
    const onChange = (): void => bump((n) => n + 1)
    subscribers.add(onChange)
    // Re-fetched on every mount, not only on a cache miss: the cache outlives
    // the hook (see the teardown), so a registry edited while nothing was
    // mounted would otherwise come back stale. The cached value is what renders
    // until this lands, so the picker never flashes empty.
    if (ws) loadSkills(ws)
    if (!unwatch)
      unwatch = window.gurt.onTreeChanged(() => {
        for (const known of registries.keys()) loadSkills(known)
      })
    return () => {
      subscribers.delete(onChange)
      // The registries stay cached: a session pane closing and reopening is the
      // common case, and an entry is a name, a line of description and a file
      // list — the `SKILL.md` bodies are not fetched here at all.
      if (subscribers.size === 0) {
        unwatch?.()
        unwatch = null
      }
    }
  }, [ws])

  return useMemo(
    () => skillEntries(ws ? (registries.get(ws) ?? []) : []),
    // `tick` is the dependency that matters — the cache it reads is module
    // state, and a notify is the only thing that changes it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws, tick]
  )
}
