// Composition root of the electron-free core: wires EnvManager and
// SessionManager over the domain bus and exposes the operations that span
// both. Importable without an Electron app (headless runs, orchestrator,
// tests).
import type { Tree } from '../shared/types'
import { resolveMcpServers, stopMcpServers } from './mcp/manager'
import { isDirty } from './provision'
import * as store from './store'
import { cloneDir } from './store'
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
}

export function createKernel(): Kernel {
  const bus = createBus()

  // EnvManager and SessionManager depend on each other; the lazy getter breaks
  // the construction-order knot.
  let sessions: SessionManager

  const envs = new EnvManager({ sessions: () => sessions, bus })

  sessions = new SessionManager(
    {
      resolveEnv: (ref, agentId, gitAccess) => envs.resolveEnv(ref, agentId, gitAccess),
      installAdapter: (ref, ctx) => envs.installAdapter(ref, ctx),
      resolveMcpServers,
      stopMcpServers,
      envStatus: (ref) => envs.status(ref),
      persist: (ws, task, records) => {
        store.writeSessions(ws, task, records).catch((e) => console.error('persist failed:', e))
      },
      appendLog: (ws, task, sessionId, records) => {
        store
          .appendSessionLog(ws, task, sessionId, records)
          .catch((e) => console.error('session-log append failed:', e))
      },
      deleteLog: (ws, task, sessionId) => {
        store
          .deleteSessionLog(ws, task, sessionId)
          .catch((e) => console.error('session-log delete failed:', e))
      }
    },
    bus
  )

  // Idle auto-stop policy: an env whose sessions all finished their turns is
  // stopped after a grace period; any activity cancels the pending stop.
  // `noteIdle` re-verifies idleness *and* the running status before stopping.
  bus.on('session.turn', ({ ref, phase }) => {
    if (phase === 'started') envs.noteActive(ref)
    else if (sessions.isEnvIdle(ref)) envs.noteIdle(ref)
  })
  bus.on('session.awaiting', ({ ref, awaiting }) => {
    if (!awaiting && sessions.isEnvIdle(ref)) envs.noteIdle(ref)
  })
  bus.on('env.activity', ({ ref }) => envs.noteActive(ref))

  async function restoreSessions(): Promise<void> {
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
          restored.push({ info: r.info, acpSessionId: r.acpSessionId, log })
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
      const data = await store.getTask(ws, task)
      const dirty: string[] = []
      for (const env of data.envs)
        if (await isDirty(cloneDir(ws, task, env.repo))) dirty.push(env.repo)
      return dirty
    }
  }
}
