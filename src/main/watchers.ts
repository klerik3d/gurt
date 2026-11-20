// Watchers (docs/requirements-watchers.md): a scope that holds one stateful
// session of role `watcher`, which monitors an outside process and wakes
// itself. The manager owns the settings (`task.json`'s `watcher`), the user's
// acts (Start / Pause / Resume / Stop / Re-arm) and the tools the agent uses.
//
// The *state* (the wakeup, the counters, the deadline) lives on the session's
// record in `sessions.json`, and the timed automatic prompt that sends the wake
// is the session manager's — one mechanism with the plan-limit resume (§5.1).
import type { EnvRef, Tree } from '../shared/types'
import { defaultEnvName, repoMode } from '../shared/types'
import {
  WATCHER_DEFAULTS,
  parseWakeWhen,
  sanitizeWatcherConfig,
  wakeAtFor,
  wakeRefusal,
  watchSetText,
  watcherActive,
  withoutWatch,
  type ActiveWatch,
  type WatcherConfig,
  type WatcherLevel,
  type WatcherState,
  type WatcherView
} from '../shared/watchers'
import type { Bus } from './bus'
import type { WatcherToolHooks } from './mcp/gurtServer'
import type { SessionManager } from './sessions'
import * as store from './store'
import { createLogger } from './log'
import { keyedChain } from './keyedChain'
import { createWatchPoller, type PollerClock } from './watchPoller'
import type { ExecChild } from './reviewCheck'

const log = createLogger('watchers')

/** A new watcher's instructions — a starting point the user rewrites. */
export const DEFAULT_WATCHER_INSTRUCTIONS =
  'Describe what this watcher monitors and when to call you. For example:\n\n' +
  'Watch the Jenkins job "storefront-release" (build #412): first the CI environment is ' +
  'built (about 5 minutes), then the tests run (about 20 minutes). Look every few minutes. ' +
  'If the build or the tests fail, call notify_user with the names of the failed tests. ' +
  'When the tests pass, finish with a one-line summary.'

export interface WatcherDeps {
  bus: Bus
  sessions: SessionManager
  /** Stop a finished watcher's container — nothing will prompt it again. */
  stopContainer: (sessionId: string) => Promise<void>
  /** The poller (§6.1), over the same container paths as the review loop's checks. */
  poll: {
    exec(sessionId: string, argv: string[], cwd: string): ExecChild
    containerUp(sessionId: string): boolean
    /** `docker stop` the session's container — how a poll is killed. */
    stopContainer(sessionId: string): Promise<void>
    containerRunning(sessionId: string): Promise<boolean | null>
    /** The keep-alive stopped: the container may idle out again. */
    idle(sessionId: string): void
    clock?: Partial<PollerClock>
  }
}

interface Entry {
  ws: string
  name: string
  config: WatcherConfig
}

export interface WatcherManager {
  /** Read every workspace's watchers (boot, after sessions are restored) and
   *  sort what each left behind by origin (§10). */
  load(tree: Tree): Promise<void>
  views(ws: string): WatcherView[]
  isWatcher(ws: string, task: string): boolean
  /** The watcher a session belongs to. */
  ofSession(sessionId: string): { ws: string; name: string } | undefined
  create(ws: string, name: string): Promise<void>
  /** Relaunch (§14): a new, unstarted watcher with the same settings and
   *  start prompt, none of the conversation. Returns the new name. */
  duplicate(ws: string, name: string): Promise<string>
  update(ws: string, name: string, patch: Partial<WatcherConfig>): Promise<void>
  start(ws: string, name: string): Promise<void>
  stop(ws: string, name: string): Promise<void>
  /** The pane's Re-arm (§3): the same act as Start, for a finished watcher. */
  rearm(ws: string, name: string, patch?: Partial<WatcherConfig>): Promise<void>
  wakeNow(ws: string, name: string): void
  /** "Check now": poll at once, without waking the agent (§5.3). */
  checkNow(ws: string, name: string): void
  cancelWake(ws: string, name: string): void
  /** The watcher was opened: its attention flag clears (§11). */
  seen(sessionId: string): void
  hooksFor(ws: string, task: string, sessionId: string): WatcherToolHooks
  onScopeDeleted(ws: string, task: string): void
  /** A scope restored from the archive: register it again if it is a watcher. */
  adopt(ws: string, task: string): Promise<void>
  onRenamed(ws: string, task: string, newName: string): void
  dropWorkspace(ws: string): void
}

const key = (ws: string, name: string): string => `${ws}/${name}`
const HOUR = 3_600_000

export function createWatchers(deps: WatcherDeps): WatcherManager {
  const { bus, sessions } = deps
  const entries = new Map<string, Entry>()
  /** Sessions that already called `notify_user` in their current turn (§4.1). */
  const notified = new Set<string>()
  /** Finished by `finish_watch`: stop the container once the turn has ended. */
  const stopAfterTurn = new Set<string>()
  const locked = keyedChain()

  const entryOf = (ws: string, name: string): Entry => {
    const e = entries.get(key(ws, name))
    if (!e) throw new Error(`no watcher "${name}" in "${ws}"`)
    return e
  }

  /** The watcher's one session. */
  const sessionOf = (e: Entry) => {
    const info = sessions.listForTask(e.ws, e.name)[0]
    if (!info) throw new Error(`watcher "${e.name}" has no session`)
    return info
  }

  const byId = (sessionId: string): Entry | undefined => {
    const info = sessions.sessionInfo(sessionId)
    return info ? entries.get(key(info.workspace, info.task)) : undefined
  }

  const refOf = (sessionId: string): EnvRef | undefined => {
    const info = sessions.sessionInfo(sessionId)
    return info && { workspace: info.workspace, task: info.task, env: info.env }
  }

  const persistConfig = async (e: Entry, config: WatcherConfig = e.config): Promise<void> =>
    store.saveTask(e.ws, e.name, { ...(await store.getTask(e.ws, e.name)), watcher: config })

  function notify(
    sessionId: string,
    level: WatcherLevel,
    text: string,
    reason: 'agent' | 'finish' | 'expired' | 'blind'
  ): void {
    const ref = refOf(sessionId)
    if (!ref) return
    bus.emit('watcher.notify', { sessionId, ref, level, text, reason })
  }

  /** `warning` / `error` also set "needs attention" until the watcher is opened. */
  function setAttention(sessionId: string, level: WatcherLevel, text: string): void {
    const w = sessions.sessionInfo(sessionId)?.watcher
    if (!watcherActive(w) || level === 'info') return
    sessions.patchWatcher(sessionId, { watcher: { ...w, attention: { level, text, at: new Date().toISOString() } } })
  }

  const poller = createWatchPoller({
    bus,
    sessions,
    exec: (...a) => deps.poll.exec(...a),
    containerUp: (...a) => deps.poll.containerUp(...a),
    stopContainer: (...a) => deps.poll.stopContainer(...a),
    containerRunning: (...a) => deps.poll.containerRunning(...a),
    paused: (id) => {
      const e = byId(id)
      return !e || !e.config.wakeups
    },
    idle: (...a) => deps.poll.idle(...a),
    fault: (id, text) => {
      setAttention(id, 'error', text)
      notify(id, 'error', text, 'blind')
    },
    ...(deps.poll.clock ? { clock: deps.poll.clock } : {})
  })
  // Every change to a session's state may start, retarget or end its watch.
  bus.on('session.changed', ({ sessionId }) => poller.reconcile(sessionId))

  sessions.setWatcherHooks({
    config: (id) => byId(id)?.config,
    notify: (id, level, text, reason) => notify(id, level, text, reason)
  })
  // One `notify_user` per turn: a new turn opens the gate again.
  bus.on('session.turn', ({ sessionId, phase }) => {
    if (phase === 'started') notified.delete(sessionId)
  })
  bus.on('session.deleted', ({ sessionId }) => {
    poller.drop(sessionId)
    notified.delete(sessionId)
    stopAfterTurn.delete(sessionId)
  })
  bus.on('session.turn', ({ sessionId, phase, final }) => {
    if (phase !== 'ended' || final === false || !stopAfterTurn.delete(sessionId)) return
    deps.stopContainer(sessionId).catch((err: unknown) => log.error('internal.fail', { site: 'watcher-stop', s: sessionId, err }))
  })

  function hooksFor(_ws: string, _task: string, sessionId: string): WatcherToolHooks {
    /** The live watcher and its state, or the sentence the agent can act on. */
    const live = (): { e: Entry; w: WatcherState } => {
      const e = byId(sessionId)
      const w = sessions.sessionInfo(sessionId)?.watcher
      if (!e || !w || w.end) throw new Error('this watcher has finished — the user can Re-arm it')
      return { e, w }
    }
    return {
      wakeMe: async ({ in_minutes, note }) => {
        const { e, w } = live()
        const now = Date.now()
        const refusal = wakeRefusal(w, e.config, now)
        if (refusal?.kind === 'error') throw new Error(refusal.text)
        if (refusal) return { scheduled: false, note: refusal.text }
        const at = wakeAtFor(in_minutes, e.config, w.deadlineAt, now)
        const prev = sessions.sessionInfo(sessionId)?.wake
        // A wakeup and a watch do not coexist: the new one replaces the other (§6.4).
        sessions.patchWatcher(sessionId, {
          wake: { at: at.at, note, setAt: new Date(now).toISOString() },
          ...(w.watch ? { watcher: withoutWatch(w) } : {})
        })
        return {
          scheduled: true,
          ...(w.watch ? { replaced_watch: w.watch.command } : {}),
          wake_at: at.at,
          note: at.text,
          ...(prev ? { replaced: { at: prev.at, note: prev.note } } : {}),
          wakeups_left: Math.max(0, e.config.maxWakeups - w.wakeups),
          deadline: w.deadlineAt
        }
      },

      watch: async ({ command, every_seconds, wake_when, timeout_minutes, note }) => {
        const { e, w } = live()
        const now = Date.now()
        const refusal = wakeRefusal(w, e.config, now)
        if (refusal?.kind === 'error') throw new Error(refusal.text)
        if (refusal) return { scheduled: false, note: refusal.text }
        if (parseWakeWhen(wake_when) === undefined) throw new Error('wake_when must be changed, exit0 or regex:<valid regular expression>')
        // The timeout is clamped like a wakeup: it is the wake that bounds the watch.
        const timeout = wakeAtFor(timeout_minutes, e.config, w.deadlineAt, now)
        const prev = sessions.sessionInfo(sessionId)?.wake
        const watch: ActiveWatch = {
          command,
          everySeconds: every_seconds,
          wakeWhen: wake_when,
          timeoutAt: timeout.at,
          setAt: new Date(now).toISOString(),
          polls: 0,
          failedInARow: 0,
          ...(note ? { note } : {})
        }
        sessions.patchWatcher(sessionId, { wake: undefined, watcher: { ...w, watch } })
        return {
          watching: true,
          note: `${watchSetText(watch, now)}${timeout.clamped ? ` — timeout ${timeout.text.split(' — ')[1] ?? 'clamped'}` : ''}; the first check follows when this turn ends`,
          ...(prev ? { replaced: { at: prev.at, note: prev.note } } : {}),
          ...(w.watch ? { replaced_watch: w.watch.command } : {}),
          wakeups_left: Math.max(0, e.config.maxWakeups - w.wakeups),
          deadline: w.deadlineAt
        }
      },

      cancelWakeup: async () => {
        live()
        const had = sessions.sessionInfo(sessionId)?.wake
        sessions.patchWatcher(sessionId, { wake: undefined })
        return { cancelled: !!had, note: 'nothing is pending now — end this turn with wake_me or finish_watch' }
      },

      notifyUser: async ({ text, level }) => {
        live()
        if (notified.has(sessionId)) throw new Error('already notified this turn — say everything in one message')
        notified.add(sessionId)
        setAttention(sessionId, level, text)
        notify(sessionId, level, text, 'agent')
        return { ok: true }
      },

      finishWatch: async ({ summary, outcome }) => {
        live()
        sessions.endWatcher(sessionId, { outcome, summary, at: new Date().toISOString(), by: 'agent' })
        // The summary is the notification, unless notify_user already called the user.
        if (!notified.has(sessionId)) {
          notified.add(sessionId)
          notify(sessionId, outcome === 'success' ? 'info' : outcome === 'failure' ? 'error' : 'warning', `${outcome}: ${summary}`, 'finish')
        }
        // Not now: the connection still carries this tool's result and the turn's
        // end. The container stops when the turn has ended.
        stopAfterTurn.add(sessionId)
        return { ok: true, note: 'watch finished — end your turn now' }
      }
    }
  }

  const manager: WatcherManager = {
    async load(tree) {
      for (const w of tree.workspaces) {
        for (const view of w.watchers) {
          const e: Entry = { ws: w.name, name: view.name, config: view.config }
          entries.set(key(w.name, view.name), e)
          const id = sessions.listForTask(w.name, view.name)[0]?.id
          if (!id) continue
          // Attended work waits in the Resume-sessions checklist; the watcher's
          // own wake turns go on by themselves (§10).
          if (sessions.recoverWatcher(id, !e.config.wakeups))
            sessions.resumeInterrupted(id).catch((err: unknown) => log.error('internal.fail', { site: 'watcher-resume', s: id, err }))
          // A watch goes on polling after a restart, with its baseline (§10).
          poller.reconcile(id)
        }
      }
    },

    views(ws) {
      const out: WatcherView[] = []
      for (const e of entries.values()) {
        if (e.ws !== ws) continue
        const session = sessions.listForTask(ws, e.name)[0]
        out.push({ name: e.name, config: e.config, ...(session ? { sessionId: session.id, session } : {}) })
      }
      return out.sort((a, b) => a.name.localeCompare(b.name))
    },

    isWatcher: (ws, task) => entries.has(key(ws, task)),

    ofSession(sessionId) {
      const e = byId(sessionId)
      return e && { ws: e.ws, name: e.name }
    },

    create: (ws, name) =>
      locked(ws, async () => {
        const wsData = await store.getWorkspace(ws)
        const agentId = wsData.defaultAgent ?? Object.keys(await store.getAgents())[0] ?? ''
        const config: WatcherConfig = { ...WATCHER_DEFAULTS }
        await store.createTask(ws, name, { watcher: config })
        sessions.createSession(
          { workspace: ws, task: name, env: defaultEnvName(wsData) },
          [],
          agentId,
          DEFAULT_WATCHER_INSTRUCTIONS,
          'draft',
          [],
          // Wakes are unattended: a permission prompt would watch nothing.
          true,
          {},
          'watcher',
          undefined,
          { internal: true }
        )
        entries.set(key(ws, name), { ws, name, config })
        log.info('watcher.create', { ws, watcher: name })
        bus.emit('tree.changed', undefined)
      }),

    duplicate: (ws, name) =>
      locked(ws, async () => {
        const src = sessionOf(entryOf(ws, name))
        // Free across every kind of scope in the workspace, by the store's own rules.
        const free = (n: string): boolean => {
          try {
            store.validateNewTaskName(ws, n)
            return !entries.has(key(ws, n))
          } catch {
            return false
          }
        }
        let copyName = `${name}-copy`
        for (let n = 2; !free(copyName); n++) {
          if (n > 1000) throw new Error(`no free name for a copy of "${name}"`)
          copyName = `${name}-copy-${n}`
        }
        // sanitizeWatcherConfig is also the deep copy.
        const config = sanitizeWatcherConfig({ ...entryOf(ws, name).config }, WATCHER_DEFAULTS)
        await store.createTask(ws, copyName, { watcher: config })
        sessions.createSession(
          { workspace: ws, task: copyName, env: src.env },
          [...src.repos],
          src.agent ?? '',
          src.startPrompt,
          'draft',
          src.mcp ? [...src.mcp] : [],
          src.autoAllow ?? true,
          { ...(src.configValues ?? {}) },
          'watcher',
          src.skills?.map((k) => ({ ...k })),
          src.network,
          Object.fromEntries(src.repos.map((r) => [r, repoMode(src, r)]))
        )
        entries.set(key(ws, copyName), { ws, name: copyName, config })
        log.info('watcher.duplicate', { ws, watcher: copyName, from: name })
        bus.emit('tree.changed', undefined)
        return copyName
      }),

    update: (ws, name, patch) =>
      locked(ws, async () => {
        const e = entryOf(ws, name)
        const info = sessionOf(e)
        const prev = e.config
        let next = sanitizeWatcherConfig({ ...prev, ...patch }, prev)
        const w = info.watcher
        const now = Date.now()
        if (watcherActive(w)) {
          // A cap can never be set where no wake is left and yet no final wake
          // comes (§2.1).
          next = { ...next, maxWakeups: Math.max(next.maxWakeups, w.wakeups + 1) }
        }
        // Published only once it is on disk: a refused write changes nothing.
        await persistConfig(e, next)
        e.config = next
        // The agent may have called finish_watch (or the wake counter moved)
        // while the config was being written: work from the latest state.
        const latest = sessions.sessionInfo(info.id)?.watcher
        if (watcherActive(w) && watcherActive(latest)) {
          let state: WatcherState = latest
          if (next.maxHours !== prev.maxHours) {
            // The deadline moves with the setting, never into the past.
            const at = Math.max(Date.parse(w.startedAt) + next.maxHours * HOUR, now + next.minDelayMinutes * 60_000)
            state = { ...state, deadlineAt: new Date(at).toISOString() }
          }
          // An edit clears only the `final` its own cap caused (§8).
          if (state.final === 'max-wakeups' && next.maxWakeups !== prev.maxWakeups && next.maxWakeups > state.wakeups) {
            const { final: _f, ...rest } = state
            state = rest
          }
          if (state.final === 'deadline' && next.maxHours !== prev.maxHours && Date.parse(state.deadlineAt) > now) {
            const { final: _f, ...rest } = state
            state = rest
          }
          if (state !== latest) sessions.patchWatcher(info.id, { watcher: state })
          // Pause holds wake work already queued (§3); Resume sends what is overdue.
          if (prev.wakeups && !next.wakeups) sessions.holdWakes(info.id)
        }
        sessions.schedule()
        poller.reconcile(info.id)
        bus.emit('tree.changed', undefined)
      }),

    start: (ws, name) =>
      locked(ws, async () => {
        const e = entryOf(ws, name)
        const info = sessionOf(e)
        if (info.state !== 'draft') throw new Error(`"${name}" has already started`)
        const startedAt = new Date()
        sessions.patchWatcher(info.id, {
          wake: undefined,
          watcher: {
            startedAt: startedAt.toISOString(),
            deadlineAt: new Date(startedAt.getTime() + e.config.maxHours * HOUR).toISOString(),
            wakeups: 0
          }
        })
        if (!e.config.wakeups) {
          const on = { ...e.config, wakeups: true }
          await persistConfig(e, on)
          e.config = on
        }
        sessions.enqueue(info.id)
        log.info('watcher.start', { ws, watcher: name, s: info.id })
        bus.emit('tree.changed', undefined)
      }),

    stop: (ws, name) =>
      locked(ws, async () => {
        const e = entryOf(ws, name)
        const info = sessionOf(e)
        if (!watcherActive(info.watcher)) throw new Error(`"${name}" is not active`)
        sessions.clearPending(info.id)
        sessions.cancelQueue(info.id) // still waiting for its start: back to draft
        sessions.cancel(info.id, 'host')
        sessions.endWatcher(info.id, { outcome: 'stopped', summary: 'stopped by the user', at: new Date().toISOString(), by: 'user' })
        deps.stopContainer(info.id).catch((err: unknown) => log.error('internal.fail', { site: 'watcher-stop', s: info.id, err }))
        bus.emit('tree.changed', undefined)
      }),

    rearm: (ws, name, patch = {}) =>
      locked(ws, async () => {
        const e = entryOf(ws, name)
        const info = sessionOf(e)
        const w = info.watcher
        if (!w?.end) throw new Error(`"${name}" has not finished`)
        const now = Date.now()
        const next = sanitizeWatcherConfig({ ...e.config, ...patch, wakeups: true }, e.config)
        if (w.wakeups >= next.maxWakeups) throw new Error(`no wakeups are left (${w.wakeups}/${next.maxWakeups}) — raise the limit to re-arm it`)
        let deadlineAt = w.deadlineAt
        if (Date.parse(deadlineAt) <= now + next.minDelayMinutes * 60_000) {
          if (patch.maxHours === undefined) throw new Error('the deadline has passed — set a new one to re-arm it')
          deadlineAt = new Date(now + next.maxHours * HOUR).toISOString()
        } else if (patch.maxHours !== undefined) deadlineAt = new Date(now + next.maxHours * HOUR).toISOString()
        await persistConfig(e, next)
        e.config = next
        const { end: _end, final: _final, attention: _att, ...rest } = w
        sessions.patchWatcher(info.id, { watcher: { ...rest, deadlineAt } })
        // Stopped before it ever came up: Re-arm starts it, like Start.
        if (info.state === 'draft') sessions.enqueue(info.id)
        log.info('watcher.rearm', { ws, watcher: name, s: info.id })
        bus.emit('tree.changed', undefined)
      }),

    wakeNow: (ws, name) => sessions.wakeNow(sessionOf(entryOf(ws, name)).id),

    checkNow: (ws, name) => poller.checkNow(sessionOf(entryOf(ws, name)).id),

    cancelWake: (ws, name) => sessions.cancelWake(sessionOf(entryOf(ws, name)).id),

    seen(sessionId) {
      const w = sessions.sessionInfo(sessionId)?.watcher
      if (w?.attention) {
        const { attention: _a, ...rest } = w
        sessions.patchWatcher(sessionId, { watcher: rest })
      }
    },

    hooksFor,

    onScopeDeleted(ws, task) {
      const e = entries.get(key(ws, task))
      if (!e) return
      const id = sessions.listForTask(ws, task)[0]?.id
      if (id) sessions.cancel(id, 'host')
      entries.delete(key(ws, task))
    },

    async adopt(ws, task) {
      const raw = (await store.getTask(ws, task)).watcher
      if (raw) entries.set(key(ws, task), { ws, name: task, config: sanitizeWatcherConfig(raw) })
    },

    onRenamed(ws, task, newName) {
      const e = entries.get(key(ws, task))
      if (!e) return
      entries.delete(key(ws, task))
      e.name = newName
      entries.set(key(ws, newName), e)
    },

    dropWorkspace(ws) {
      for (const [k, e] of entries) if (e.ws === ws) entries.delete(k)
    }
  }
  return manager
}
