/**
 * A per-key promise chain: `chain(key, fn)` runs `fn` once the previous task
 * queued under the same key has settled — fulfilled or rejected — and returns
 * `fn`'s own promise, its rejection included. The map keeps only the
 * error-swallowed tail (`next.catch(() => {})`), so one failure never breaks
 * the chain for the tasks behind it. Keys are never removed.
 *
 * Every call creates its own chain map. Not re-entrant: awaiting a task on
 * the same key from inside `fn` deadlocks.
 */
export function keyedChain(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>()
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const next = Promise.resolve(tails.get(key))
      .catch(() => {})
      .then(fn)
    tails.set(
      key,
      next.catch(() => {})
    )
    return next
  }
}
