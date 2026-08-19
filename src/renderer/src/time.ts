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
  const h = d.getHours() % 12 || 12
  const min = d.getMinutes()
  const time = `${h}${min ? `:${String(min).padStart(2, '0')}` : ''}${d.getHours() < 12 ? 'am' : 'pm'}`
  if (new Date().toDateString() === d.toDateString()) return time
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${time}`
}
