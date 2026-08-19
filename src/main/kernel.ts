// Composition root of the electron-free core: wires ContainerManager and
// SessionManager over the domain bus and exposes the operations that span
// both. Importable without an Electron app (headless runs, orchestrator,
// tests).
import type { Tree } from '../shared/types'
import { isSessionRole } from '../shared/types'
import type { SessionDraftPatch } from '../shared/api'
import { NOTIFICATION_DEFAULTS } from '../shared/notifications'
import { resolveMcpServers, stopMcpServers } from './mcp/manager'
import { ensureGurtServer, stopGurtServer } from './mcp/gurtServer'
import { isDirty } from './provision'
import * as store from './store'
import { cloneDir } from './store'
import * as changes from './changes'
import { createBus, type Bus } from './bus'
import { ContainerManager } from './containers'
import { SessionManager, type RestoredSession } from './sessions'
import { createNotifications, type Notifications } from './notifications'
import { createUsageLedger, type UsageLedger } from './usage'
import { createPlanUsage, type PlanUsageStore } from './planUsage'
import { listCredentials } from './credentials'
import { createLogger, dropSessionLog, sessionLogLine } from './log'

const log = createLogger('kernel')
// Same scope as sessions.ts/containers.ts's own loggers (`sessions`,
// `containers`) — these bus-tap records are the other half of the same
// subsystems' lifecycle (session.queued/end, agent.spawn/exit; container.stop/
// remove, provision.*, reconcile.done), and docs/logging.md's one worked
// example ([sessions] agent.spawn) assumes a single canonical scope per
// subsystem, not one split across [session]/[sessions] or [container]/[containers].
const sessionLog = createLogger('sessions')
const containerLog = createLogger('containers')

export interface Kernel {
  bus: Bus
  containers: ContainerManager
  sessions: SessionManager
  /** Settles when the boot restore is done — sessions loaded, container records
   *  reconciled against Docker, queue resumed. The app never waits on it (the UI
   *  renders the sessions as they land), but anything that stages state *as if*
   *  it were already booted must: the reconcile rewrites container records, and
   *  one landing mid-setup looks exactly like a container going away. Never
   *  rejects — a failed restore is logged, not thrown. */
  ready: Promise<void>
  notifications: Notifications
  /** Per-turn agent accounting — what the dashboard's agent cards read. */
  usage: UsageLedger
  /** Provider-reported plan limits, cached. The one source that knows what is
   *  *left*; `usage` only knows what gurt itself spent. */
  planUsage: PlanUsageStore
  /** store.buildTree + session overlay. */
  tree(): Promise<Tree>
  deleteTask(ws: string, task: string): Promise<void>
  /** Delete a whole workspace: every task, clone and session goes with it. */
  deleteWorkspace(ws: string): Promise<void>
  /** Rename a task: stops its envs (a running container's bind mount is
   *  pinned to the old directory), moves the directory, and best-effort
   *  renames its branch in every clone. */
  renameTask(ws: string, task: string, newName: string): Promise<void>
  /** Repos in this task whose clone has uncommitted changes. */
  taskDirtyRepos(ws: string, task: string): Promise<string[]>
  /** sessions.editDraft behind a repo check — the UI constrains the choice, IPC must too. */
  editDraft(sessionId: string, patch: SessionDraftPatch): Promise<void>
  /** Forge compare URL for the task branch; when the latest proposal carries a PR,
   *  its title/body ride along as url-encoded query params (the compare page picks
   *  them up). */
  prUrl(ws: string, task: string, repo: string): Promise<string>
}

/** Reject a draft target that does not exist in the workspace. Shared by the
 *  IPC edit path and the agent-driven `create_session` one — both take repo/env
 *  names from outside the kernel, and a draft naming a missing one would only
 *  fail much later, at its start. */
async function assertDraftTarget(ws: string, repos: string[], env?: string): Promise<void> {
  const wsData = await store.getWorkspace(ws)
  for (const r of repos)
    if (!wsData.repos.some((c) => c.name === r))
      throw new Error(`repo "${r}" is not registered in "${ws}"`)
  if (env !== undefined && !wsData.envs.some((e) => e.name === env))
    throw new Error(`environment "${env}" is not registered in "${ws}"`)
}

export function createKernel(): Kernel {
  const bus = createBus()

  // The container manager reads and writes container state that lives *on* the
  // session, and the session manager asks it to provision — a genuine mutual
  // dependency, so one lazy getter breaks the construction-order knot.
  let sessions: SessionManager

  const containers = new ContainerManager({
    bus,
    session: (id) => sessions.sessionInfo(id),
    sessions: () => sessions.allSessions(),
    patchContainer: (id, patch) => sessions.patchContainer(id, patch),
    isSessionIdle: (id) => sessions.isSessionIdle(id),
    detach: (id) => sessions.detach(id)
  })

  sessions = new SessionManager(
    {
      resolveLaunch: (sessionId) => containers.resolveLaunch(sessionId),
      releaseContainer: (sessionId, reason) => {
        containers
          .release(sessionId, reason)
          .catch((e) => log.error('internal.fail', { site: 'container-release', s: sessionId, reason, err: e }))
      },
      installAdapter: (ctx) => containers.installAdapter(ctx),
      resolveMcpServers,
      stopMcpServers,
      resolveGurtServer: ensureGurtServer,
      stopGurtServer,
      checkDraftTarget: assertDraftTarget,
      persist: (ws, task, records) => {
        store
          .writeSessions(ws, task, records)
          .catch((e) => log.error('internal.fail', { site: 'session-persist', ws, task, err: e }))
      },
      saveAgentConfig: (agentId, cfg) => {
        store
          .setAgentConfig(agentId, cfg)
          .catch((e) => log.error('internal.fail', { site: 'agent-config-persist', agent: agentId, err: e }))
      },
      appendLog: (ws, task, sessionId, records) =>
        store.appendSessionLog(ws, task, sessionId, records),
      deleteLog: (ws, task, sessionId) => {
        store
          .deleteSessionLog(ws, task, sessionId)
          .catch((e) => log.error('internal.fail', { site: 'session-log-delete', s: sessionId, err: e }))
        // The session's diagnostic file goes with its timeline.
        dropSessionLog(sessionId)
      }
    },
    bus
  )

  // --- log tap ------------------------------------------------------------
  // The lifecycle *is* the bus, so one subscription per event is the whole
  // "what happened" trail — no logging calls sprinkled through the emitters.
  // Deliberately not tapped: session.log, session.changed, tree.changed and
  // session.activity — high-frequency, and the first two carry chat content.
  bus.on('session.state', ({ sessionId, ref, state, reason, err }) => {
    sessionLog.info('session.state', { s: sessionId, task: ref.task, state, reason, err })
  })
  bus.on('session.turn', ({ sessionId, phase }) => sessionLog.info('session.turn', { s: sessionId, phase }))
  bus.on('session.awaiting', ({ sessionId, awaiting }) =>
    sessionLog.info('session.awaiting', { s: sessionId, awaiting })
  )
  bus.on('session.adapterExited', ({ sessionId }) =>
    sessionLog.info('session.adapterExited', { s: sessionId })
  )
  bus.on('container.status', ({ sessionId, status, reason }) =>
    containerLog.info('container.status', { s: sessionId, status, reason })
  )
  // The proposal carries the agent's commit/PR prose — only the fact is logged.
  bus.on('session.proposal', ({ sessionId }) =>
    sessionLog.info('session.proposal', { s: sessionId, repos: sessions.sessionInfo(sessionId)?.repos })
  )
  // Accounting, not content: `detail` carries the adapter's own stop/error
  // prose and is deliberately left out — the failure itself is already logged
  // by the turn that threw it.
  bus.on('agent.turn', ({ sessionId, agent, kind, ms, outcome }) =>
    sessionLog.info('agent.turn', { s: sessionId, agent, kind, ms, outcome })
  )
  // Provisioning output is volume, and per session: it goes to that session's
  // own file and never to the app log.
  bus.on('provision.log', ({ key, line }) => sessionLogLine(key, line))

  // Queue handoff: while something waits in the queue, an idle container is not
  // resting, it is *blocking* — the clone it holds is exactly what the queued
  // session needs, and the scheduler only ever advances when a container comes
  // down. Stopping those the moment their session falls idle is what makes the
  // queue run at turn speed instead of at grace-period speed. Sessions nobody
  // is waiting on are not touched here: with an empty queue this is a no-op and
  // the plain idle policy below is the whole behaviour, unchanged.
  const reaping = new Set<string>()
  const reapForQueue = (): void => {
    for (const id of sessions.holdersBlockingQueue()) {
      // One stop per session at a time: the triggers below fire in bursts (turn
      // end, then the adapter's exit), and a second stop would race the first.
      if (reaping.has(id)) continue
      reaping.add(id)
      containers
        .stop(id, 'queue')
        .catch((e) => {
          log.error('internal.fail', { site: 'queue-handoff', s: id, err: e })
          // The stop cancelled this session's pending auto-stop before it went to
          // Docker, so a failure leaves the container up with nothing left to try
          // again — and the queue would wait on that clone until the holder
          // happens to move. Re-arm the grace period: the handoff falls back to
          // the policy it was cutting short, never to nothing.
          containers.noteIdle(id)
        })
        .finally(() => {
          reaping.delete(id)
          // Belt and braces: a stop that succeeded already re-ran the scheduler
          // through `container.status`, and a failed one leaves the holder
          // holding, so this pass usually starts nothing.
          sessions.schedule()
        })
    }
  }

  // Notifications: turns select bus events into user-facing records (see
  // docs/requirements-notifications.md). Wired synchronously with the
  // hardcoded defaults so no early event is missed; the persisted matrix
  // (if any) swaps in once restoreSessions() has read it.
  const notifications = createNotifications(bus, NOTIFICATION_DEFAULTS, (id) =>
    sessions.sessionInfo(id)
  )

  // Usage ledger: files every finished turn against the agent instance that
  // served it. Wired here, next to notifications, for the same reason — both
  // are pure bus subscribers that must exist before the first event fires.
  const usage = createUsageLedger(bus)

  // Plan limits, straight from the provider. Lazy by construction — nothing is
  // polled until something asks, so a workspace with no dashboard open never
  // touches the network.
  const planUsage = createPlanUsage(bus, {
    agents: () => store.getAgents(),
    credentials: () => listCredentials()
  })

  // Idle auto-stop policy: a session's container is stopped after it has sat
  // idle for a grace period; any activity cancels the pending stop. `noteIdle`
  // re-verifies idleness *and* the running status before stopping.
  const idle = (sessionId: string): void => {
    if (sessions.isSessionIdle(sessionId)) containers.noteIdle(sessionId)
    // Global by design: this session going idle may free a *different* one's
    // blocker (a start it was waiting on finished), and the check is cheap.
    reapForQueue()
  }
  bus.on('session.turn', ({ sessionId, phase }) => {
    if (phase === 'started') containers.noteActive(sessionId)
    else idle(sessionId)
  })
  bus.on('session.awaiting', ({ sessionId, awaiting }) => {
    if (!awaiting) idle(sessionId)
  })
  // A dead adapter leaves a non-busy session with no turn end to emit — its
  // container would otherwise keep running if a pending stop had been cancelled.
  bus.on('session.adapterExited', ({ sessionId }) => idle(sessionId))
  // A failed start drops the session back to `draft` while its container may
  // already be up — and no turn will ever end to trigger the check. Without
  // this the container would hold the session's repo indefinitely.
  bus.on('session.state', ({ sessionId, state }) => {
    if (state === 'draft') idle(sessionId)
    // A fresh queue item may be blocked by an environment that has been sitting
    // idle for minutes — free it now instead of when its timer happens to fire.
    else if (state === 'queued') reapForQueue()
  })
  bus.on('session.activity', ({ sessionId }) => containers.noteActive(sessionId))
  // A container that came down released its session's clone — the next queued
  // session of that repo can start now.
  bus.on('container.status', ({ status }) => {
    if (status === 'stopped' || status === 'error') sessions.schedule()
  })

  async function restoreSessions(): Promise<void> {
    notifications.setPrefs(await store.getNotificationPrefs())
    sessions.loadAgentConfigs(await store.getAgentConfigs())
    sessions.loadAgentKinds(await store.getAgents())
    const t = await store.buildTree()
    for (const ws of t.workspaces)
      for (const task of ws.tasks) {
        const restored: RestoredSession[] = []
        for (const r of await store.readSessions(ws.name, task.name)) {
          let log = await store.readSessionLog(ws.name, task.name, r.info.id)
          if (!log.length && r.entries?.length) {
            // Legacy record carrying entries and no JSONL yet: synthesize the log
            // once. sessions.json drops the entries on its next regular persist.
            log = r.entries.map((entry, i) => ({ seq: i + 1, type: 'entry' as const, entry }))
            await store.appendSessionLog(ws.name, task.name, r.info.id, log)
          }
          restored.push({ info: r.info, acpSessionId: r.acpSessionId, proposal: r.proposal, log })
        }
        sessions.restore(restored)
      }
    // Docker is the registry: correct the restored container records against it
    // (and reap orphans) before anything tries to exec into one.
    await containers.reconcile().catch((e) => log.error('internal.fail', { site: 'container-reconcile', err: e }))
    // Resume the queue once, after everything is restored: start what can start,
    // then free what the rest is waiting on. Without the second call a queue
    // restored behind a still-running container would never move — nothing has
    // armed an idle timer for that container in this process yet.
    sessions.schedule()
    reapForQueue()
  }
  const ready = restoreSessions().catch((e) =>
    log.error('internal.fail', { site: 'session-restore', err: e })
  )

  return {
    bus,
    containers,
    sessions,
    ready,
    notifications,
    usage,
    planUsage,

    async tree(): Promise<Tree> {
      const t = await store.buildTree()
      for (const ws of t.workspaces)
        for (const task of ws.tasks) task.sessions = sessions.listForTask(ws.name, task.name)
      return t
    },

    async deleteTask(ws: string, task: string): Promise<void> {
      await containers.teardownTask(ws, task)
      sessions.dropTaskSessions(ws, task)
      await store.removeTaskDir(ws, task)
      bus.emit('tree.changed', undefined)
    },

    async deleteWorkspace(ws: string): Promise<void> {
      await containers.teardownWorkspace(ws)
      sessions.dropWorkspaceSessions(ws)
      await store.removeWorkspaceDir(ws)
      bus.emit('tree.changed', undefined)
    },

    async renameTask(ws: string, task: string, newName: string): Promise<void> {
      if (newName === task) return
      await containers.stopTask(ws, task)
      await store.renameTask(ws, task, newName)
      await changes.renameTaskBranches(ws, newName, task)
      sessions.renameTask(ws, task, newName)
      bus.emit('tree.changed', undefined)
    },

    async taskDirtyRepos(ws: string, task: string): Promise<string[]> {
      const dirty: string[] = []
      for (const repo of await store.taskClones(ws, task))
        if (await isDirty(cloneDir(ws, task, repo))) dirty.push(repo)
      return dirty
    },

    async editDraft(sessionId: string, patch: SessionDraftPatch): Promise<void> {
      if (patch.role !== undefined && !isSessionRole(patch.role))
        throw new Error(`unknown session role "${String(patch.role)}"`)
      const info = sessions.snapshot(sessionId)?.info
      if (info) await assertDraftTarget(info.workspace, patch.repos ?? [], patch.env)
      sessions.editDraft(sessionId, patch)
    },

    async prUrl(ws: string, task: string, repo: string): Promise<string> {
      const url = await changes.prUrl(ws, task, repo)
      const pr = sessions.latestProposal(ws, task, repo)?.pr
      if (!pr) return url
      // encodeURIComponent (spaces → %20) rather than URLSearchParams (+), so the
      // params are unambiguous on GitHub's compare page.
      const parts = [`title=${encodeURIComponent(pr.title)}`]
      if (pr.body) parts.push(`body=${encodeURIComponent(pr.body)}`)
      return `${url}${url.includes('?') ? '&' : '?'}${parts.join('&')}`
    }
  }
}
