// Proactive agents (docs/design-proactive-agents.md): a scope that holds a
// template draft, a schedule that copies it into a run, and the `gurt` tools a
// run uses to turn what it finds into scopes with draft sessions.
//
// Everything that decides identity — which ref belongs to which scope — runs
// under one per-workspace lock. Gurt is a single instance (index.ts takes the
// single-instance lock), so an in-process chain is the whole of the locking.
import type { EnvRef, SessionInfo, Tree } from '../shared/types'
import { defaultEnvName } from '../shared/types'
import type {
  ProactiveAgentView,
  ProactiveConfig,
  ProactiveOrigin,
  ProactiveRun,
  ProactiveRunOutcome,
  ProactiveState
} from '../shared/proactive'
import {
  PROACTIVE_DEFAULTS,
  PROACTIVE_DEFERRALS_KEPT,
  PROACTIVE_RUNS_KEPT,
  PROACTIVE_TOMBSTONES_KEPT,
  isPendingScope,
  nextRunDue,
  normalizeRefs,
  sanitizeProactiveConfig,
  scopeSlug
} from '../shared/proactive'
import type { Bus } from './bus'
import type { ProactiveHooks, ProposeScopeInput } from './mcp/gurtServer'
import type { DraftInheritance, PreparedDraft, SessionManager } from './sessions'
import * as store from './store'
import { createLogger } from './log'

const log = createLogger('proactive')

/** How often the schedule and the run timeouts are checked. */
const TICK_MS = 30_000

/** A new agent's instructions — a starting point the user rewrites. */
export const DEFAULT_PROACTIVE_INSTRUCTIONS =
  'Describe what this agent watches and what it should raise. For example:\n\n' +
  'Look at the unresolved Sentry issues of project "storefront" seen since the cursor ' +
  '(start with the last 24 hours if there is none). Raise a scope for each issue that ' +
  'affects checkout or more than 50 users, with one executor session for the repo the ' +
  'stack trace points at. Defer the rest for 24 hours with the reason.'

export interface ProactiveDeps {
  bus: Bus
  sessions: SessionManager
  /** Stop a finished run's container — nothing will prompt it again. */
  stopContainer: (sessionId: string) => Promise<void>
}

interface ActiveRun {
  id: string
  /** Scopes proposed so far — what `maxScopesPerRun` counts. */
  proposed: number
  finished: boolean
}

interface Agent {
  ws: string
  name: string
  config: ProactiveConfig
  state: ProactiveState
  active?: ActiveRun | undefined
}

export interface ProactiveManager {
  /** Read every workspace's agents and raised scopes (boot, after sessions are
   *  restored); runs left `running` by a previous app life become `interrupted`. */
  load(tree: Tree): Promise<void>
  /** Start the schedule clock. */
  start(): void
  /** Stop it (tests, shutdown). */
  stop(): void
  /** One pass of the clock: due runs start, overdue runs are cancelled. */
  tick(): void
  views(ws: string): ProactiveAgentView[]
  isAgent(ws: string, task: string): boolean
  create(ws: string, name: string): Promise<void>
  update(ws: string, name: string, patch: Partial<ProactiveConfig>): Promise<void>
  runNow(ws: string, name: string): Promise<string>
  undefer(ws: string, name: string, ref: string): Promise<void>
  /** Drop a tombstone, so the agent may raise the ref again. */
  forget(ws: string, name: string, ref: string): Promise<void>
  /** The tools of one run, bound to its workspace, agent and session. */
  hooksFor(ws: string, agent: string, sessionId: string): ProactiveHooks
  /** A scope is about to be deleted: an agent goes away with its scope, a
   *  raised scope leaves its refs behind as tombstones. */
  onScopeDeleted(ws: string, task: string): Promise<void>
  onScopeRenamed(ws: string, task: string, newName: string): void
  dropWorkspace(ws: string): void
}

const key = (ws: string, name: string): string => `${ws}/${name}`
const now = (): string => new Date().toISOString()

export function createProactive(deps: ProactiveDeps): ProactiveManager {
  const { bus, sessions } = deps
  const agents = new Map<string, Agent>()
  /** Every raised scope's origin, by `ws/scope`. */
  const origins = new Map<string, ProactiveOrigin>()
  /** Per workspace: ref → the scope it is bound to (raised scopes only). */
  const refIndex = new Map<string, Map<string, string>>()
  const locks = new Map<string, Promise<unknown>>()
  let timer: NodeJS.Timeout | undefined

  /** Run `fn` after everything queued for this workspace — the lock every
   *  identity decision (ref → scope) is taken under. */
  function locked<T>(ws: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(ws) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    locks.set(
      ws,
      next.catch(() => {})
    )
    return next
  }

  const refsOf = (ws: string): Map<string, string> => {
    let m = refIndex.get(ws)
    if (!m) refIndex.set(ws, (m = new Map<string, string>()))
    return m
  }

  function indexOrigin(ws: string, scope: string, origin: ProactiveOrigin): void {
    origins.set(key(ws, scope), origin)
    const refs = refsOf(ws)
    for (const r of origin.refs) refs.set(r, scope)
  }

  function agentOf(ws: string, name: string): Agent {
    const a = agents.get(key(ws, name))
    if (!a) throw new Error(`no proactive agent "${name}" in "${ws}"`)
    return a
  }

  const persistState = (a: Agent): Promise<void> => store.writeProactiveState(a.ws, a.name, a.state)

  function persistLater(a: Agent): void {
    persistState(a).catch((e: unknown) => log.error('internal.fail', { site: 'proactive-state', agent: a.name, err: e }))
  }

  /** A ref's tombstone, in any agent of the workspace. */
  function tombstoneOf(ws: string, ref: string): { scope: string } | undefined {
    for (const a of agents.values()) {
      if (a.ws !== ws) continue
      const t = a.state.tombstones.find((x) => x.ref === ref)
      if (t) return t
    }
    return undefined
  }

  function activeDeferral(a: Agent, ref: string): { until: string; reason: string } | undefined {
    const t = Date.now()
    return a.state.deferrals.find((d) => d.ref === ref && Date.parse(d.until) > t)
  }

  function template(a: Agent): SessionInfo | undefined {
    const id = a.config.templateId
    const info = id ? sessions.sessionInfo(id) : undefined
    return info?.template ? info : undefined
  }

  /** Scopes this agent raised that still exist, newest first. */
  function ownScopes(a: Agent): { scope: string; origin: ProactiveOrigin; sessions: SessionInfo[] }[] {
    const out: { scope: string; origin: ProactiveOrigin; sessions: SessionInfo[] }[] = []
    for (const [k, origin] of origins) {
      if (origin.agent !== a.name || !k.startsWith(`${a.ws}/`)) continue
      const scope = k.slice(a.ws.length + 1)
      out.push({ scope, origin, sessions: sessions.listForTask(a.ws, scope) })
    }
    return out.sort((x, y) => y.origin.createdAt.localeCompare(x.origin.createdAt))
  }

  const pendingCount = (a: Agent): number => ownScopes(a).filter((s) => isPendingScope(s.sessions)).length

  function runRecord(a: Agent, id: string): ProactiveRun | undefined {
    return a.state.runs.find((r) => r.id === id)
  }

  /** The run calling a tool must be the agent's run in progress — a run that
   *  has ended has no limits left to count against, and a user prompting its
   *  session afterwards must not reopen it. */
  function activeFor(a: Agent, sessionId: string): ActiveRun {
    if (a.active?.id !== sessionId) throw new Error('this run has ended — its tools are closed')
    return a.active
  }

  // --- runs -----------------------------------------------------------------

  function startRun(a: Agent): string {
    if (a.active) throw new Error(`"${a.name}" is already running`)
    const t = template(a)
    if (!t) throw new Error(`"${a.name}" has no template session`)
    const startedAt = now()
    const title = `run ${startedAt.slice(0, 16).replace('T', ' ')}`
    const info = sessions.spawnRun(t.id, title)
    a.active = { id: info.id, proposed: 0, finished: false }
    a.state.lastRunAt = startedAt
    a.state.runs.unshift({ id: info.id, startedAt, outcome: 'running', proposed: [], attached: [], deferred: 0 })
    a.state.runs.length = Math.min(a.state.runs.length, PROACTIVE_RUNS_KEPT)
    persistLater(a)
    log.info('proactive.run.start', { ws: a.ws, agent: a.name, s: info.id })
    bus.emit('tree.changed', undefined)
    return info.id
  }

  function finishRun(a: Agent, outcome: ProactiveRunOutcome, error?: string): void {
    const active = a.active
    if (!active) return
    a.active = undefined
    const rec = runRecord(a, active.id)
    if (rec) {
      rec.outcome = outcome
      rec.endedAt = now()
      if (error) rec.error = error
    }
    persistLater(a)
    log.info('proactive.run.end', { ws: a.ws, agent: a.name, s: active.id, outcome })
    const info = sessions.sessionInfo(active.id)
    if (info) {
      // Nothing will prompt a finished run again; its container is only cost.
      deps.stopContainer(active.id).catch((e: unknown) =>
        log.error('internal.fail', { site: 'proactive-stop', s: active.id, err: e })
      )
      const ref: EnvRef = { workspace: info.workspace, task: info.task, env: info.env }
      bus.emit('proactive.run', { sessionId: active.id, ref, agent: a.name, outcome, proposed: rec?.proposed ?? [] })
    }
    collectRuns(a)
    bus.emit('tree.changed', undefined)
  }

  /** Keep the newest `keepRuns` finished run sessions; the history keeps the
   *  rest's summaries. */
  function collectRuns(a: Agent): void {
    const runs = sessions
      .listForTask(a.ws, a.name)
      .filter((s) => !s.template && s.id !== a.active?.id)
    const excess = runs.length - a.config.keepRuns
    for (const s of runs.slice(0, Math.max(0, excess))) sessions.deleteSession(s.id)
  }

  /** The run session for `sessionId`, if it is some agent's run in progress. */
  function runOf(sessionId: string): Agent | undefined {
    for (const a of agents.values()) if (a.active?.id === sessionId) return a
    return undefined
  }

  bus.on('session.turn', ({ sessionId, phase, final }) => {
    if (phase !== 'ended' || final === false) return
    const a = runOf(sessionId)
    if (a) finishRun(a, a.active?.finished ? 'finished' : 'incomplete')
  })
  bus.on('session.state', ({ sessionId, state, reason, err }) => {
    if (state !== 'draft' || reason !== 'start-failed') return
    const a = runOf(sessionId)
    if (a) finishRun(a, 'failed', err?.message ?? 'failed to start')
  })
  bus.on('session.deleted', ({ sessionId }) => {
    const a = runOf(sessionId)
    if (a) finishRun(a, 'cancelled')
  })

  function tick(): void {
    const t = Date.now()
    for (const a of agents.values()) {
      if (a.active) {
        const rec = runRecord(a, a.active.id)
        const started = rec ? Date.parse(rec.startedAt) : t
        if (t - started < a.config.maxRunMinutes * 60_000) continue
        const id = a.active.id
        const info = sessions.sessionInfo(id)
        finishRun(a, 'timeout', `cancelled after ${a.config.maxRunMinutes} minutes`)
        // A turn in flight is cancelled; a run still starting has nothing to
        // cancel, and is deleted instead of left to come up unwatched.
        if (info?.state === 'started') sessions.cancel(id)
        else if (info) sessions.deleteSession(id)
        continue
      }
      if (!a.config.enabled || t < nextRunDue(a.config, a.state)) continue
      try {
        startRun(a)
      } catch (e) {
        // Recorded once per due slot: the attempt still counts as the slot's
        // run, so a broken template is not retried every tick.
        a.state.lastRunAt = now()
        a.state.runs.unshift({
          id: `failed-${Date.now()}`,
          startedAt: now(),
          endedAt: now(),
          outcome: 'failed',
          proposed: [],
          attached: [],
          deferred: 0,
          error: e instanceof Error ? e.message : String(e)
        })
        a.state.runs.length = Math.min(a.state.runs.length, PROACTIVE_RUNS_KEPT)
        persistLater(a)
        bus.emit('tree.changed', undefined)
      }
    }
  }

  // --- the run's tools --------------------------------------------------------

  function hooksFor(ws: string, name: string, sessionId: string): ProactiveHooks {
    return {
      listOpen: async (check) => {
        const a = agentOf(ws, name)
        const active = activeFor(a, sessionId)
        const scopes = ownScopes(a)
        const t = Date.now()
        const result: Record<string, unknown> = {
          agent: a.name,
          cursor: a.state.cursor ?? null,
          limits: {
            scopesLeftThisRun: Math.max(0, a.config.maxScopesPerRun - active.proposed),
            pendingScopes: scopes.filter((s) => isPendingScope(s.sessions)).length,
            maxPendingScopes: a.config.maxPendingScopes
          },
          activeDeferrals: a.state.deferrals.filter((d) => Date.parse(d.until) > t).length,
          scopes: scopes.slice(0, 100).map((s) => ({
            scope: s.scope,
            title: s.origin.title,
            summary: s.origin.summary,
            refs: s.origin.refs,
            notes: s.origin.notes?.length ?? 0,
            // Untouched by the user: every session still a draft.
            pending: isPendingScope(s.sessions),
            sessions: s.sessions.map((x) => ({ title: x.title, role: x.role, state: x.state }))
          }))
        }
        if (check?.length) {
          const status: Record<string, unknown> = {}
          for (const ref of normalizeRefs(check)) {
            const scope = refsOf(ws).get(ref)
            const tomb = scope ? undefined : tombstoneOf(ws, ref)
            const deferred = scope || tomb ? undefined : activeDeferral(a, ref)
            status[ref] = scope
              ? { status: 'open', scope, agent: origins.get(key(ws, scope))?.agent }
              : tomb
                ? { status: 'dismissed', scope: tomb.scope }
                : deferred
                  ? { status: 'deferred', until: deferred.until, reason: deferred.reason }
                  : { status: 'new' }
          }
          result['check'] = status
        }
        return result
      },

      proposeScope: (input) => locked(ws, () => proposeScope(ws, name, sessionId, input)),

      attach: (input) =>
        locked(ws, async () => {
          const a = agentOf(ws, name)
          const active = activeFor(a, sessionId)
          const origin = origins.get(key(ws, input.scope))
          if (!origin) throw new Error(`"${input.scope}" is not a scope raised by a proactive agent`)
          const refs = normalizeRefs(input.refs)
          const fresh: string[] = []
          for (const ref of refs) {
            const bound = refsOf(ws).get(ref)
            if (bound === input.scope) continue
            if (bound) throw new Error(`${ref} already belongs to scope "${bound}"`)
            const tomb = tombstoneOf(ws, ref)
            if (tomb) throw new Error(`${ref} belonged to scope "${tomb.scope}", which the user deleted`)
            fresh.push(ref)
          }
          if (!fresh.length && !input.note) return { scope: input.scope, attached: [] }
          const next: ProactiveOrigin = {
            ...origin,
            refs: [...origin.refs, ...fresh],
            ...(input.note
              ? { notes: [...(origin.notes ?? []), { at: now(), agent: a.name, run: active.id, text: input.note }].slice(-200) }
              : {})
          }
          const file = await store.getTask(ws, input.scope)
          await store.saveTask(ws, input.scope, { ...file, origin: next })
          indexOrigin(ws, input.scope, next)
          a.state.deferrals = a.state.deferrals.filter((d) => !fresh.includes(d.ref))
          const rec = runRecord(a, active.id)
          if (rec && !rec.attached.includes(input.scope)) rec.attached.push(input.scope)
          await persistState(a)
          bus.emit('tree.changed', undefined)
          return { scope: input.scope, attached: fresh, noted: !!input.note }
        }),

      defer: (input) =>
        locked(ws, async () => {
          const a = agentOf(ws, name)
          const active = activeFor(a, sessionId)
          const refs = normalizeRefs(input.refs)
          const until = new Date(Date.now() + input.forHours * 3_600_000).toISOString()
          const skipped: Record<string, string> = {}
          const t = Date.now()
          // Expired deferrals go first: they decide nothing any more.
          a.state.deferrals = a.state.deferrals.filter((d) => Date.parse(d.until) > t && !refs.includes(d.ref))
          let n = 0
          for (const ref of refs) {
            const scope = refsOf(ws).get(ref)
            if (scope) {
              skipped[ref] = `already raised as scope "${scope}"`
              continue
            }
            const tomb = tombstoneOf(ws, ref)
            if (tomb) {
              skipped[ref] = `dismissed by the user (scope "${tomb.scope}")`
              continue
            }
            a.state.deferrals.push({ ref, until, reason: input.reason, run: active.id, at: now() })
            n++
          }
          a.state.deferrals = a.state.deferrals.slice(-PROACTIVE_DEFERRALS_KEPT)
          const rec = runRecord(a, active.id)
          if (rec) rec.deferred += n
          await persistState(a)
          return { deferred: n, until, ...(Object.keys(skipped).length ? { skipped } : {}) }
        }),

      finishRun: (input) =>
        locked(ws, async () => {
          const a = agentOf(ws, name)
          const active = activeFor(a, sessionId)
          active.finished = true
          if (input.cursor !== undefined) a.state.cursor = input.cursor
          const rec = runRecord(a, active.id)
          if (rec) rec.summary = input.summary
          await persistState(a)
          return { ok: true, note: 'run recorded — end your turn now' }
        })
    }
  }

  /** `propose_scope` (§5), under the workspace lock. */
  async function proposeScope(
    ws: string,
    name: string,
    sessionId: string,
    input: ProposeScopeInput
  ): Promise<unknown> {
    const a = agentOf(ws, name)
    const active = activeFor(a, sessionId)
    const refs = normalizeRefs(input.refs)
    const t = template(a)
    const inherit: DraftInheritance = t ? sessions.inheritanceOf(t) : {}
    // Check every request before anything lands: a scope is created whole or
    // not at all.
    const prepare = async (): Promise<PreparedDraft[]> => {
      const out: PreparedDraft[] = []
      for (const s of input.sessions)
        out.push(await sessions.prepareDraft(ws, s, inherit))
      return out
    }

    // Identity first: a ref already bound answers with its scope.
    for (const ref of refs) {
      const bound = refsOf(ws).get(ref)
      if (!bound) continue
      const existing = sessions.listForTask(ws, bound)
      const origin = origins.get(key(ws, bound))
      // A scope whose drafts never landed (the app died between the scope and
      // its sessions) is finished here instead of answered empty.
      if (!existing.length && origin?.agent === a.name) {
        const prepared = await prepare()
        const drafted = prepared.map((p) => sessions.createPreparedDraft(ws, bound, p, inherit))
        bus.emit('tree.changed', undefined)
        return { scope: bound, created: false, drafted: drafted.map((d) => ({ id: d.id, title: d.title })) }
      }
      return {
        scope: bound,
        created: false,
        note: `${ref} already belongs to scope "${bound}" — nothing was created; attach new refs or a note to it instead`
      }
    }
    for (const ref of refs) {
      const tomb = tombstoneOf(ws, ref)
      if (tomb)
        throw new Error(
          `${ref} belonged to scope "${tomb.scope}", which the user deleted — it is not raised again`
        )
    }
    if (active.proposed >= a.config.maxScopesPerRun)
      throw new Error(
        `this run already proposed ${active.proposed} scopes (the limit is ${a.config.maxScopesPerRun}) — ` +
          'defer the rest with reason "backpressure" and finish the run'
      )
    const pending = pendingCount(a)
    if (pending >= a.config.maxPendingScopes)
      throw new Error(
        `${pending} scopes are waiting for the user already (the limit is ${a.config.maxPendingScopes}) — ` +
          'defer the rest with reason "backpressure" and finish the run'
      )
    const prepared = await prepare()

    const base = scopeSlug(input.title)
    const taken = (n: string): boolean => {
      if (store.taskExists(ws, n) || agents.has(key(ws, n))) return true
      try {
        store.validateName('task', n)
        return false
      } catch {
        return true // a reserved name ("skills", "repos", …)
      }
    }
    let scope = base
    for (let i = 2; taken(scope); i++) scope = `${base}-${i}`
    const origin: ProactiveOrigin = {
      agent: a.name,
      run: active.id,
      refs,
      title: input.title,
      summary: input.summary,
      createdAt: now()
    }
    // One write: the scope exists exactly when its refs are bound.
    await store.createTask(ws, scope, { origin })
    indexOrigin(ws, scope, origin)
    const drafted = prepared.map((p) => sessions.createPreparedDraft(ws, scope, p, inherit))
    active.proposed++
    a.state.deferrals = a.state.deferrals.filter((d) => !refs.includes(d.ref))
    runRecord(a, active.id)?.proposed.push(scope)
    await persistState(a)
    log.info('proactive.scope', { ws, agent: a.name, scope, s: active.id, sessions: drafted.length })
    bus.emit('tree.changed', undefined)
    return { scope, created: true, sessions: drafted.map((d) => ({ id: d.id, title: d.title })) }
  }

  // --- the user's side ----------------------------------------------------

  const manager: ProactiveManager = {
    async load(tree) {
      for (const w of tree.workspaces) {
        for (const t of w.tasks) if (t.origin) indexOrigin(w.name, t.name, t.origin)
        for (const p of w.proactive) {
          const state = await store.readProactiveState(w.name, p.name)
          let changed = false
          for (const r of state.runs)
            if (r.outcome === 'running') {
              r.outcome = 'interrupted'
              r.endedAt = r.endedAt ?? now()
              changed = true
            }
          const a: Agent = { ws: w.name, name: p.name, config: p.config, state }
          agents.set(key(w.name, p.name), a)
          if (changed) persistLater(a)
          // Its tools would be closed (no run is in progress after a restart),
          // so a run still queued from the previous app life goes back to draft
          // instead of starting for nothing.
          for (const s of sessions.listForTask(w.name, p.name))
            if (!s.template && s.state === 'queued') sessions.cancelQueue(s.id)
        }
      }
    },

    start() {
      if (timer) return
      timer = setInterval(tick, TICK_MS)
      // The clock never keeps a process alive on its own (headless tests).
      timer.unref()
      tick()
    },

    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    },

    tick,

    views(ws) {
      const out: ProactiveAgentView[] = []
      for (const a of agents.values()) {
        if (a.ws !== ws) continue
        const due = nextRunDue(a.config, a.state)
        out.push({
          name: a.name,
          config: a.config,
          state: a.state,
          ...(a.config.enabled ? { nextRunAt: new Date(Math.max(due, Date.now())).toISOString() } : {}),
          ...(a.active ? { activeRun: a.active.id } : {}),
          sessions: sessions.listForTask(ws, a.name)
        })
      }
      return out.sort((x, y) => x.name.localeCompare(y.name))
    },

    isAgent: (ws, task) => agents.has(key(ws, task)),

    create: (ws, name) =>
      locked(ws, async () => {
        const wsData = await store.getWorkspace(ws)
        const agentId = wsData.defaultAgent ?? Object.keys(await store.getAgents())[0] ?? ''
        const config: ProactiveConfig = { ...PROACTIVE_DEFAULTS }
        await store.createTask(ws, name, { proactive: config })
        const info = sessions.createSession(
          { workspace: ws, task: name, env: defaultEnvName(wsData) },
          [],
          agentId,
          DEFAULT_PROACTIVE_INSTRUCTIONS,
          'draft',
          [],
          // Runs are unattended: a permission prompt would hold one until its
          // timeout.
          true,
          {},
          'proactive',
          undefined,
          { internal: true }
        )
        sessions.renameSession(info.id, 'template')
        sessions.markTemplate(info.id)
        config.templateId = info.id
        await store.saveTask(ws, name, { ...(await store.getTask(ws, name)), proactive: config })
        const a: Agent = { ws, name, config, state: await store.readProactiveState(ws, name) }
        agents.set(key(ws, name), a)
        log.info('proactive.create', { ws, agent: name })
        bus.emit('tree.changed', undefined)
      }),

    update: (ws, name, patch) =>
      locked(ws, async () => {
        const a = agentOf(ws, name)
        // The template id is the manager's, never the caller's.
        const { templateId: _ignored, ...rest } = patch
        const next = sanitizeProactiveConfig({ ...a.config, ...rest }, a.config)
        if (a.config.templateId) next.templateId = a.config.templateId
        else delete next.templateId
        await store.saveTask(ws, name, { ...(await store.getTask(ws, name)), proactive: next })
        a.config = next
        bus.emit('tree.changed', undefined)
        // A shorter interval or a fresh enable may have made a run due now.
        tick()
      }),

    runNow: async (ws, name) => startRun(agentOf(ws, name)),

    undefer: (ws, name, ref) =>
      locked(ws, async () => {
        const a = agentOf(ws, name)
        a.state.deferrals = a.state.deferrals.filter((d) => d.ref !== ref)
        await persistState(a)
        bus.emit('tree.changed', undefined)
      }),

    forget: (ws, name, ref) =>
      locked(ws, async () => {
        const a = agentOf(ws, name)
        a.state.tombstones = a.state.tombstones.filter((t) => t.ref !== ref)
        await persistState(a)
        bus.emit('tree.changed', undefined)
      }),

    hooksFor,

    onScopeDeleted: (ws, task) =>
      locked(ws, async () => {
        const a = agents.get(key(ws, task))
        if (a) {
          if (a.active) finishRun(a, 'cancelled')
          agents.delete(key(ws, task))
          return
        }
        const origin = origins.get(key(ws, task))
        if (!origin) return
        origins.delete(key(ws, task))
        const refs = refsOf(ws)
        for (const r of origin.refs) if (refs.get(r) === task) refs.delete(r)
        // The refs stay bound, as tombstones in the agent that raised them: the
        // user deleting the scope is an answer, not a request to ask again (§8).
        const owner = agents.get(key(ws, origin.agent))
        if (!owner) return
        const at = now()
        owner.state.tombstones = [
          ...owner.state.tombstones.filter((t) => !origin.refs.includes(t.ref)),
          ...origin.refs.map((ref) => ({ ref, scope: task, at }))
        ].slice(-PROACTIVE_TOMBSTONES_KEPT)
        await persistState(owner)
      }),

    onScopeRenamed(ws, task, newName) {
      const origin = origins.get(key(ws, task))
      if (!origin) return
      origins.delete(key(ws, task))
      indexOrigin(ws, newName, origin)
    },

    dropWorkspace(ws) {
      for (const [k, a] of agents) if (a.ws === ws) agents.delete(k)
      for (const k of [...origins.keys()]) if (k.startsWith(`${ws}/`)) origins.delete(k)
      refIndex.delete(ws)
    }
  }
  return manager
}
