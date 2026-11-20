// The watcher's poller (docs/requirements-watchers.md §6): runs the agent's
// `watch` command in the watcher's own container, with no LLM, and records what
// came out on the watcher's state. When the condition holds (or the watch times
// out or is broken) it only marks the watch `fired`: the wake itself is the
// session manager's timed prompt (§5.1, §5.4), gated like any wake.
//
// A poll runs through the review loop's check runner, so killing one is
// stopping the container, confirmed by an inspect (§6.1). That is why polls
// never overlap a turn: `canPoll` / `setPolling` on the session manager.
import { safeRegexTest } from './safeRegex'
import { CONTAINER_ROOT } from '../shared/files'
import {
  WATCH_LIMITS,
  tailBytes,
  watchFired,
  watcherActive,
  type ActiveWatch,
  type PollResult,
  type WatcherState
} from '../shared/watchers'
import type { Bus } from './bus'
import { createLogger } from './log'
import { CheckRunner, type CheckOptions, type ExecChild } from './reviewCheck'
import type { SessionManager } from './sessions'

const log = createLogger('watch-poller')

export interface PollerClock {
  /** Pings that keep the container up while a watch is active (< IDLE_STOP_MS). */
  keepAliveMs: number
  /** How soon a poll that may not run now (a turn, a hold) is asked again. */
  retryMs: number
  /** An unconfirmed stop is retried this often; `null` = the watch's interval. */
  stopRetryMs: number | null
  now: () => number
  /** Test seam for the runner (the poll's own limit). */
  runner?: Partial<CheckOptions>
}

const DEFAULT_CLOCK: PollerClock = { keepAliveMs: 2 * 60_000, retryMs: 5_000, stopRetryMs: null, now: Date.now }

export interface PollerDeps {
  bus: Bus
  sessions: Pick<
    SessionManager,
    'sessionInfo' | 'canPoll' | 'setPolling' | 'patchWatcher' | 'activity' | 'ensureContainerUp'
  >
  exec(sessionId: string, argv: string[], cwd: string): ExecChild
  containerUp(sessionId: string): boolean
  /** `docker stop` — the one way a poll is killed. May reject; the inspect decides. */
  stopContainer(sessionId: string): Promise<void>
  containerRunning(sessionId: string): Promise<boolean | null>
  /** Pause: no unattended work of any kind (§3). */
  paused(sessionId: string): boolean
  /** The container may idle out again (the keep-alive stopped). */
  idle(sessionId: string): void
  /** A stop that could not be confirmed three times (§6.1): the user must know. */
  fault(sessionId: string, text: string): void
  clock?: Partial<PollerClock>
}

export interface WatchPoller {
  /** Start, retarget or stop the session's loop to match its state. Idempotent. */
  reconcile(sessionId: string): void
  /** "Check now": poll at once. Throws a sentence when it cannot. */
  checkNow(sessionId: string): void
  /** The session is gone. */
  drop(sessionId: string): void
}

interface Poll {
  id: string
  /** The watch this loop serves (`ActiveWatch.setAt`). */
  setAt: string
  runner: CheckRunner
  timer?: NodeJS.Timeout | undefined
  keepAlive?: NodeJS.Timeout | undefined
  inflight: boolean
  /** The watch ended or the watcher paused during a poll: its result is dropped. */
  released: boolean
  /** The last poll's container stop could not be confirmed: turns stay held. */
  unconfirmed: boolean
  stopTries: number
  faulted: boolean
  seq: number
}

export function createWatchPoller(deps: PollerDeps): WatchPoller {
  const { sessions } = deps
  const clock: PollerClock = { ...DEFAULT_CLOCK, ...deps.clock }
  const polls = new Map<string, Poll>()

  /** The watch this session should be polling right now, if any. */
  const wanted = (id: string): { w: WatcherState; watch: ActiveWatch } | undefined => {
    const w = sessions.sessionInfo(id)?.watcher
    if (!watcherActive(w) || !w.watch || w.watch.fired || deps.paused(id)) return undefined
    return { w, watch: w.watch }
  }

  /** The next poll is at the interval, but never later than the watch's timeout:
   *  that poll is what ends the watch, so a long interval must not delay it. */
  const untilNextPoll = (watch: ActiveWatch): number =>
    Math.max(0, Math.min(watch.everySeconds * 1000, Date.parse(watch.timeoutAt) - clock.now()))

  const arm = (p: Poll, ms: number): void => {
    clearTimeout(p.timer)
    p.timer = setTimeout(() => void tick(p), ms)
    p.timer.unref?.()
  }

  function startKeepAlive(p: Poll): void {
    if (p.keepAlive) return
    p.keepAlive = setInterval(() => sessions.activity(p.id), clock.keepAliveMs)
    p.keepAlive.unref?.()
  }

  /** The loop ends (the watch is gone, fired or paused). A poll in flight is
   *  left to finish — its result is dropped — because ending it means stopping
   *  the container. */
  function release(p: Poll): void {
    // A stop that could not be confirmed keeps its hold (and its retries) while
    // the watcher lives — Pause is not Stop (§6.1); the end of the watcher, or
    // its deletion, is what lifts it.
    if (p.unconfirmed && watcherActive(sessions.sessionInfo(p.id)?.watcher)) return
    clearTimeout(p.timer)
    p.timer = undefined
    clearInterval(p.keepAlive)
    p.keepAlive = undefined
    p.released = true
    if (p.unconfirmed) {
      // Pause / Stop: the hold has done its work (Stop stops the container itself).
      p.unconfirmed = false
      polls.delete(p.id)
      sessions.setPolling(p.id, false)
    } else if (!p.inflight) polls.delete(p.id)
    deps.idle(p.id)
  }

  const cwdOf = (id: string): string => {
    const repo = sessions.sessionInfo(id)?.repos[0]
    return repo ? `${CONTAINER_ROOT}/${repo}` : CONTAINER_ROOT
  }

  function create(id: string, watch: ActiveWatch): Poll {
    const p: Poll = {
      id,
      setAt: watch.setAt,
      runner: new CheckRunner({
        exec: (argv, cwd) => deps.exec(id, argv, cwd),
        // A container stopped by a timed-out poll, a restart or by hand is
        // started again here, so it is never reported as a broken command (§6.1).
        ensureContainerUp: async () => {
          if (!deps.containerUp(id)) await sessions.ensureContainerUp(id)
        },
        stopContainer: () => deps.stopContainer(id),
        containerRunning: () => deps.containerRunning(id),
        options: { timeoutMs: WATCH_LIMITS.pollMs, ...clock.runner }
      }),
      inflight: false,
      released: false,
      unconfirmed: false,
      stopTries: 0,
      faulted: false,
      seq: 0
    }
    polls.set(id, p)
    return p
  }

  async function tick(p: Poll): Promise<void> {
    p.timer = undefined
    const want = wanted(p.id)
    if (!want) return release(p)
    if (p.inflight || p.unconfirmed) return
    if (!sessions.canPoll(p.id)) return arm(p, clock.retryMs)
    const { watch } = want
    p.inflight = true
    sessions.setPolling(p.id, true)
    const run = await p.runner.run({
      intent: `watch.${++p.seq}`,
      repo: 'watch',
      command: watch.command,
      cwd: cwdOf(p.id),
      splitStreams: true
    })
    p.inflight = false
    if (run.status === 'unconfirmed') {
      // The poll may still be running: turns stay held until a stop is confirmed.
      p.unconfirmed = true
      p.stopTries = 1
      if (p.released) return release(p)
      return armStopRetry(p, watch.everySeconds)
    }
    const at = new Date(clock.now()).toISOString()
    let poll: PollResult | undefined
    if (run.status === 'finished')
      poll = {
        at,
        exit: run.result.code,
        out: tailBytes(run.result.tail.join('\n'), WATCH_LIMITS.outBytes),
        err: tailBytes((run.result.stderr ?? []).join('\n'), WATCH_LIMITS.errBytes)
      }
    else if (run.status === 'stopped' && run.reason === 'timeout')
      poll = {
        at,
        exit: null,
        out: tailBytes(run.result.tail.join('\n'), WATCH_LIMITS.outBytes),
        err: `the command ran past ${WATCH_LIMITS.pollMs / 1000} s and was stopped (the container was stopped)`
      }
    else if (run.status === 'failed-to-run') poll = { at, exit: null, out: '', err: run.error.slice(0, WATCH_LIMITS.errBytes) }
    // Applied before the poll flag drops: what a turn that was waiting sees is
    // already the new state (a fired watch is queued before a typed message runs).
    if (poll && !p.released) apply(p, poll)
    sessions.setPolling(p.id, false)
    const next = wanted(p.id)
    if (!next) return release(p)
    // A watch replaced during the poll starts over at once.
    arm(p, next.watch.setAt === p.setAt ? untilNextPoll(next.watch) : 0)
    p.setAt = next.watch.setAt
  }

  /** Record one poll on the watch it was made for; wake the agent when it says so. */
  function apply(p: Poll, poll: PollResult): void {
    const w = sessions.sessionInfo(p.id)?.watcher
    const watch = w?.watch
    if (!watcherActive(w) || !watch || watch.setAt !== p.setAt || watch.fired) return
    const verdict = watchFired(watch, poll, clock.now(), safeRegexTest)
    const l = watch.last
    const changed = !l || l.exit !== poll.exit || l.out !== poll.out || l.err !== poll.err
    const next: ActiveWatch = {
      ...watch,
      polls: watch.polls + 1,
      failedInARow: verdict.failedInARow,
      last: { at: poll.at, exit: poll.exit, out: poll.out, err: poll.err }
    }
    const baselineChanged = verdict.baseline !== undefined && verdict.baseline !== watch.baseline
    if (verdict.baseline !== undefined) next.baseline = verdict.baseline
    if (verdict.reason) next.fired = { at: poll.at, reason: verdict.reason, out: poll.out.trim() }
    // Written at most once per poll that changed something (§6.3).
    sessions.patchWatcher(p.id, { watcher: { ...w, watch: next } }, { persist: changed || baselineChanged || !!verdict.reason })
  }

  function armStopRetry(p: Poll, everySeconds: number): void {
    clearTimeout(p.timer)
    p.timer = setTimeout(() => void retryStop(p), clock.stopRetryMs ?? everySeconds * 1000)
    p.timer.unref?.()
  }

  async function retryStop(p: Poll): Promise<void> {
    p.timer = undefined
    if (!p.unconfirmed) return
    const stopped = await p.runner.stopContainer()
    if (!p.unconfirmed) return
    if (!stopped.ok) {
      p.stopTries++
      log.warn('watch.stop.unconfirmed', { s: p.id, tries: p.stopTries, detail: stopped.detail })
      if (p.stopTries >= 3 && !p.faulted) {
        p.faulted = true
        deps.fault(p.id, 'could not stop a watch command')
      }
      const every = sessions.sessionInfo(p.id)?.watcher?.watch?.everySeconds ?? 30
      return armStopRetry(p, every)
    }
    // Confirmed: the poll counts as a failed one, and turns may go on.
    p.unconfirmed = false
    p.stopTries = 0
    p.faulted = false
    const at = new Date(clock.now()).toISOString()
    if (!p.released)
      apply(p, { at, exit: null, out: '', err: `the command ran past ${WATCH_LIMITS.pollMs / 1000} s and was stopped (the container was stopped)` })
    sessions.setPolling(p.id, false)
    const next = wanted(p.id)
    if (!next) return release(p)
    arm(p, untilNextPoll(next.watch))
  }

  return {
    reconcile(id) {
      const want = wanted(id)
      const p = polls.get(id)
      if (!want) {
        if (p && !p.released) release(p)
        return
      }
      if (!p || (p.released && !p.inflight && !p.unconfirmed)) {
        const fresh = create(id, want.watch)
        startKeepAlive(fresh)
        // One poll now (a restart, a new watch): the baseline is kept (§10).
        arm(fresh, 0)
        return
      }
      p.released = false
      startKeepAlive(p)
      if (p.setAt !== want.watch.setAt && !p.inflight && !p.unconfirmed) {
        p.setAt = want.watch.setAt
        arm(p, 0)
      } else if (!p.timer && !p.inflight && !p.unconfirmed) arm(p, 0)
    },

    checkNow(id) {
      const p = polls.get(id)
      if (!p || !wanted(id)) throw new Error('nothing is being watched')
      if (p.inflight || p.unconfirmed) throw new Error('a check is already running')
      if (!sessions.canPoll(id)) throw new Error('a turn is running — check when it ends')
      arm(p, 0)
    },

    drop(id) {
      const p = polls.get(id)
      if (!p) return
      clearTimeout(p.timer)
      clearInterval(p.keepAlive)
      p.released = true
      polls.delete(id)
    }
  }
}
