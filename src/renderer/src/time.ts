/** Coarse "when was this" wording, shared by the notifications panel and the
 *  dashboard so the two never phrase the same age differently. */
export function relativeTime(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

/** `6:30pm` today, `Aug 20 at 12am` on another day — when a plan window
 *  resets, in this machine's timezone. The wording Claude Code's own `/usage`
 *  uses, so the two surfaces read the same. */
export function resetClock(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return 'unknown'
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (new Date().toDateString() === d.toDateString()) return `today at ${time}`
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${time}`
}

/** Wall clock since something started: `12s`, `1:05`, `1:02:03`. Shown where a
 *  live row has no better progress signal than the time it has been up. */
export function elapsedClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}:${pad(s % 60)}`
  return `${Math.floor(m / 60)}:${pad(m % 60)}:${pad(s % 60)}`
}

/** A message's end time for the gutter beside the rail: `14:32`, plus the date
 *  (`Aug 20`) when it was not today. */
export function stamp(ms: number): { time: string; date?: string } {
  const d = new Date(ms)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (new Date().toDateString() === d.toDateString()) return { time }
  return { time, date: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }
}

/** How long something took (or has taken so far): `1s`, `12s`, `1:05` — never
 *  0, so a live readout does not flick from "<1s" to "1s". */
export function durationLabel(ms: number): string {
  return elapsedClock(Math.max(1, ms / 1000))
}
