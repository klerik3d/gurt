import { createLogger } from './log'

const log = createLogger('ui')

/**
 * Adapt an async handler to React's void-returning event props.
 *
 * `onClick={async () => …}` type-checks — React ignores the returned promise —
 * but a rejection then has nowhere to go: it becomes an unhandled rejection in
 * the window, invisible unless devtools happen to be open. Wrapping consumes
 * the promise and records what failed, so a handler that throws leaves a trace
 * in the app log like everything else does.
 *
 * It is not an error *display*: handlers that have something to say to the user
 * still catch and say it themselves (see the alertDialog calls around the app).
 * This is the floor under them.
 */
// The parameter is `unknown`, not `Promise<unknown>`: several handlers are
// guarded expressions (`e.key === 'Enter' && save()`) whose value is a promise
// only on the branch that acts. Awaiting a non-promise is a no-op.
/**
 * Start an async call from a statement position — a keyboard `case`, an effect
 * body — with the same floor as {@link run}: the promise is consumed and a
 * rejection is recorded rather than lost.
 */
export function fire(fn: () => unknown): void {
  run(fn)()
}

export function run<A extends unknown[]>(fn: (...args: A) => unknown): (...args: A) => void {
  return (...args: A) => {
    void (async () => {
      try {
        await fn(...args)
      } catch (e) {
        log.error('handler.failed', { err: e })
      }
    })()
  }
}
