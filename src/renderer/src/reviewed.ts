// "You have looked at this since it finished" marks, per session.
//
// Deliberately local to the renderer and persisted in localStorage: it is a
// property of *this user at this screen*, not of the session, and nothing in
// the kernel should start branching on whether a human has read something. The
// worst failure mode is a cleared store, which re-surfaces finished sessions in
// the dashboard's review list — noisy for one pass, never wrong about the work.
import { useEffect, useState } from 'react'
import type { TurnRecord } from '../../shared/usage'
import { logErr } from './log'

const KEY = 'gurt.seenSessions'
/** Enough for any realistic session count; the oldest marks fall off first. */
const CAP = 500

export type Seen = Record<string, string>

function read(): Seen {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if (!raw || typeof raw !== 'object') return {}
    const out: Seen = {}
    for (const [id, at] of Object.entries(raw)) if (typeof at === 'string') out[id] = at
    return out
  } catch {
    return {}
  }
}

let seen: Seen = read()
const subscribers = new Set<(s: Seen) => void>()

function commit(next: Seen): void {
  // Trim oldest-first so a long-lived install can't grow the entry unbounded.
  const ids = Object.keys(next)
  if (ids.length > CAP) {
    const at = (id: string): string => next[id] ?? ''
    const keep = ids.sort((a, b) => at(b).localeCompare(at(a))).slice(0, CAP)
    next = Object.fromEntries(keep.map((id) => [id, at(id)]))
  }
  seen = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // a full/blocked store only costs the marks — keep the in-memory copy
  }
  subscribers.forEach((fn) => fn(next))
}

/** Mark a session reviewed as of now — called when it is opened, and by the
 *  dashboard's explicit "reviewed" action. */
export function markSeen(id: string): void {
  commit({ ...seen, [id]: new Date().toISOString() })
}

/** Mark several at once (the review list's "mark all" action). */
export function markAllSeen(ids: string[]): void {
  const at = new Date().toISOString()
  commit({ ...seen, ...Object.fromEntries(ids.map((id) => [id, at])) })
}

/** Live view of the marks. */
export function useSeen(): Seen {
  const [state, setState] = useState<Seen>(seen)
  useEffect(() => {
    subscribers.add(setState)
    setState(seen)
    return () => {
      subscribers.delete(setState)
    }
  }, [])
  return state
}

/** The turn ledger, refetched whenever main files a turn. */
export function useUsage(): TurnRecord[] {
  const [usage, setUsage] = useState<TurnRecord[]>([])
  useEffect(() => {
    const load = (): void => {
      window.gurt.getUsage().then(setUsage).catch(logErr('getUsage'))
    }
    load()
    return window.gurt.onUsageChanged(load)
  }, [])
  return usage
}

/** ISO end of each session's last recorded turn — the ledger is append-ordered,
 *  so the last match wins. */
export function lastTurnEnds(usage: TurnRecord[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const r of usage) out.set(r.sessionId, r.ts)
  return out
}

/**
 * Has the user looked at this session since its last turn ended? A session with
 * no recorded turn counts as reviewed: nothing is on record for them to have
 * missed, and a turn this install never saw must not nag forever.
 */
export const isReviewed = (id: string, marks: Seen, lastTurnEnd?: string): boolean =>
  !lastTurnEnd || (marks[id] ?? '') >= lastTurnEnd
