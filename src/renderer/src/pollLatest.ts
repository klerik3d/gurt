/**
 * Read now and then every `intervalMs`, handing each answer to `apply` — but
 * never an answer older than one already handed over. Reads overlap (a slow one
 * is still out when the next tick fires), so replies can come back in another
 * order than they were asked in; the late reply of an earlier read must not
 * put an earlier state back over a newer one. A reply to a read that is not the
 * newest is still used when nothing newer has landed, so a stream of fast ticks
 * cannot starve the display.
 *
 * Returns the stop function; once called, nothing is applied any more.
 */
export function pollLatest<T>(
  read: () => Promise<T>,
  apply: (value: T) => void,
  onError: (e: unknown) => void,
  intervalMs: number
): () => void {
  let live = true
  let asked = 0
  let shown = 0
  const tick = (): void => {
    const mine = ++asked
    read().then((value) => {
      if (!live || mine < shown) return
      shown = mine
      apply(value)
    }, onError)
  }
  tick()
  const timer = setInterval(tick, intervalMs)
  return () => {
    live = false
    clearInterval(timer)
  }
}
