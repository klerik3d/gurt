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

/** Wall-clock `14:07`, for window bounds where the exact time matters. */
export const clockTime = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** `19 Aug 14:07` — bounds that can sit days apart, where a weekday alone is
 *  ambiguous (a 7-day window opens and closes on the same weekday). */
export const dateClockTime = (ms: number): string => {
  const d = new Date(ms)
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${clockTime(ms)}`
}

/** `Mon 14:07` — a window that may have opened on another day. */
export const dayClockTime = (ms: number): string => {
  const d = new Date(ms)
  const sameDay = new Date().toDateString() === d.toDateString()
  return sameDay
    ? clockTime(ms)
    : `${d.toLocaleDateString([], { weekday: 'short' })} ${clockTime(ms)}`
}
