// Composition root of the electron-free core: wires EnvManager and
// SessionManager over the domain bus and exposes the operations that span
// both. Importable without an Electron app (headless runs, orchestrator,
// tests).
import type { Tree } from '../shared/types'
import type { SessionDraftPatch } from '../shared/api'
import { resolveMcpServers, stopMcpServers } from './mcp/manager'
import { ensureGurtServer, stopGurtServer, stopGurtServersForEnv } from './mcp/gurtServer'
import { isDirty } from './provision'
import * as store from './store'
import { cloneDir } from './store'
import * as changes from './changes'
import { createBus, type Bus } from './bus'
import { EnvManager } from './envs'
import { SessionManager, type RestoredSession } from './sessions'

export interface Kernel {
  bus: Bus
  envs: EnvManager
  sessions: SessionManager
  /** store.buildTree + session overlay. */
  tree(): Promise<Tree>
  deleteTask(ws: string, task: string): Promise<void>
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

  // EnvManager and SessionManager depend on each other; the lazy getter breaks
  // the construction-order knot.
  let sessions: SessionManager

  const envs = new EnvManager({ sessions: () => sessions, bus })

  sessions = new SessionManager(
    {
      resolveEnv: (ref, repo, agentId, gitAccess) =>
        envs.resolveEnv(ref, repo, agentId, gitAccess),
      releaseEnv: (ref) => {
        envs.release(ref).catch((e) => console.error('env release failed:', e))
      },
      installAdapter: (ref, ctx) => envs.installAdapter(ref, ctx),
      resolveMcpServers,
      stopMcpServers: (ref) => {
        stopMcpServers(ref)
        stopGurtServersForEnv(ref)
      },
      resolveGurtServer: ensureGurtServer,
      stopGurtServer,
      taskEnvStates: async (ws, task) =>
        (await store.getTask(ws, task)).envs.map((e) => ({
          session: e.session,
          env: e.env,
          repo: e.repo,
          status: e.status
        })),
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

  // Idle auto-stop policy: a session's container is stopped after a grace
  // period once its turn finished; any activity cancels the pending stop.
  // `noteIdle` re-verifies idleness *and* the running status before stopping.
  bus.on('session.turn', ({ ref, phase }) => {
    if (phase === 'started') envs.noteActive(ref)
    else if (sessions.isEnvIdle(ref)) envs.noteIdle(ref)
  })
  bus.on('session.awaiting', ({ ref, awaiting }) => {
    if (!awaiting && sessions.isEnvIdle(ref)) envs.noteIdle(ref)
  })
  // A dead adapter leaves its non-busy sessions with no turn end to emit — the
  // env would otherwise keep running forever if a pending stop had been cancelled.
  bus.on('env.adapterExited', ({ ref }) => {
    if (sessions.isEnvIdle(ref)) envs.noteIdle(ref)
  })
  bus.on('env.activity', ({ ref }) => envs.noteActive(ref))

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
    // Resume the queue once, after everything is restored.
    sessions.schedule()
  }
  restoreSessions().catch((e) => console.error('session restore failed:', e))

  return {
    bus,
    envs,
    sessions,

    async tree(): Promise<Tree> {
      const t = await store.buildTree()
      for (const ws of t.workspaces)
        for (const task of ws.tasks) task.sessions = sessions.listForTask(ws.name, task.name)
      return t
    },

    async deleteTask(ws: string, task: string): Promise<void> {
      await envs.teardownTask(ws, task)
      sessions.dropTaskSessions(ws, task)
      await store.removeTaskDir(ws, task)
      bus.emit('tree.changed', undefined)
    },

    async taskDirtyRepos(ws: string, task: string): Promise<string[]> {
      // Disk-based: clones outlive the per-session instance records (a deleted
      // session releases its record but keeps the clone).
      const dirty: string[] = []
      for (const repo of await store.taskCloneRepos(ws, task))
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
