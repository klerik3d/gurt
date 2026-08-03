// Composition root of the electron-free core: wires ContainerManager and
// SessionManager over the domain bus and exposes the operations that span
// both. Importable without an Electron app (headless runs, orchestrator,
// tests).
import type { Tree } from '../shared/types'
import type { SessionDraftPatch } from '../shared/api'
import { resolveMcpServers, stopMcpServers } from './mcp/manager'
import { ensureGurtServer, stopGurtServer } from './mcp/gurtServer'
import { isDirty } from './provision'
import * as store from './store'
import { cloneDir } from './store'
import * as changes from './changes'
import { createBus, type Bus } from './bus'
import { ContainerManager } from './containers'
import { SessionManager, type RestoredSession } from './sessions'

export interface Kernel {
  bus: Bus
  containers: ContainerManager
  sessions: SessionManager
  /** store.buildTree + session overlay. */
  tree(): Promise<Tree>
  deleteTask(ws: string, task: string): Promise<void>
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
      releaseContainer: (sessionId) => {
        containers.release(sessionId).catch((e) => console.error('container release failed:', e))
      },
      installAdapter: (ctx) => containers.installAdapter(ctx),
      resolveMcpServers,
      stopMcpServers,
      resolveGurtServer: ensureGurtServer,
      stopGurtServer,
      persist: (ws, task, records) => {
        store.writeSessions(ws, task, records).catch((e) => console.error('persist failed:', e))
      },
      saveAgentConfig: (agentId, cfg) => {
        store
          .setAgentConfig(agentId, cfg)
          .catch((e) => console.error('agent-config persist failed:', e))
      },
      appendLog: (ws, task, sessionId, records) =>
        store.appendSessionLog(ws, task, sessionId, records),
      deleteLog: (ws, task, sessionId) => {
        store
          .deleteSessionLog(ws, task, sessionId)
          .catch((e) => console.error('session-log delete failed:', e))
      }
    },
    bus
  )

  // Idle auto-stop policy: a session's container is stopped after it has sat
  // idle for a grace period; any activity cancels the pending stop. `noteIdle`
  // re-verifies idleness *and* the running status before stopping.
  const idle = (sessionId: string): void => {
    if (sessions.isSessionIdle(sessionId)) containers.noteIdle(sessionId)
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
  })
  bus.on('session.activity', ({ sessionId }) => containers.noteActive(sessionId))
  // A container that came down released its session's clone — the next queued
  // session of that repo can start now.
  bus.on('container.status', ({ status }) => {
    if (status === 'stopped' || status === 'error') sessions.schedule()
  })

  async function restoreSessions(): Promise<void> {
    sessions.loadAgentConfigs(await store.getAgentConfigs())
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
    await containers.reconcile().catch((e) => console.error('container reconcile failed:', e))
    // Resume the queue once, after everything is restored.
    sessions.schedule()
  }
  restoreSessions().catch((e) => console.error('session restore failed:', e))

  return {
    bus,
    containers,
    sessions,

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
      const info = sessions.snapshot(sessionId)?.info
      if (info) {
        const wsData = await store.getWorkspace(info.workspace)
        if (patch.repo != null && !wsData.repos.some((r) => r.name === patch.repo))
          throw new Error(`repo "${patch.repo}" is not registered in "${info.workspace}"`)
        if (patch.env !== undefined && !wsData.envs.some((e) => e.name === patch.env))
          throw new Error(`environment "${patch.env}" is not registered in "${info.workspace}"`)
      }
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
