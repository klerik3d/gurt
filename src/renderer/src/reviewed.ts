// "You have looked at this since it finished" marks, per session.
//
// Deliberately local to the renderer and persisted in localStorage: it is a
// property of *this user at this screen*, not of the session, and nothing in
// the kernel should start branching on whether a human has read something. The
// worst failure mode is a cleared store, which re-surfaces finished sessions in
// the dashboard's review list — noisy for one pass, never wrong about the work.
import { useEffect, useState } from 'react'

const KEY = 'gurt.seenSessions'
/** Enough for any realistic session count; the oldest marks fall off first. */
const CAP = 500

type Seen = Record<string, string>

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
