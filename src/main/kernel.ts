// Composition root of the electron-free core: wires EnvManager and
// SessionManager together and exposes the operations that span both.
// Importable without an Electron app (headless runs, orchestrator, tests).
import type { SessionSnapshot, Tree } from '../shared/types'
import { resolveMcpServers, stopMcpServers } from './mcp/manager'
import { isDirty } from './provision'
import * as store from './store'
import { cloneDir } from './store'
import { EnvManager } from './envs'
import { SessionManager } from './sessions'

/** Temporary seam; replaced by the event bus in requirements-event-bus.md. */
export interface KernelEvents {
  treeChanged(): void
  sessionChanged(snap: SessionSnapshot): void
  provisionLog(e: { key: string; line: string }): void
}

export interface Kernel {
  envs: EnvManager
  sessions: SessionManager
  /** store.buildTree + session overlay. */
  tree(): Promise<Tree>
  deleteTask(ws: string, task: string): Promise<void>
  /** Repos in this task whose clone has uncommitted changes. */
  taskDirtyRepos(ws: string, task: string): Promise<string[]>
}

export function createKernel(events: KernelEvents): Kernel {
  // EnvManager and SessionManager depend on each other; the lazy getter breaks
  // the construction-order knot.
  let sessions: SessionManager

  const envs = new EnvManager({
    sessions: () => sessions,
    log: (key, line) => events.provisionLog({ key, line }),
    changed: () => events.treeChanged()
  })

  sessions = new SessionManager({
    onSessionsChanged: () => events.treeChanged(),
    onSessionChanged: (id) => {
      const snap = sessions.snapshot(id)
      if (snap) events.sessionChanged(snap)
    },
    resolveEnv: (ref, agentId, gitAccess) => envs.resolveEnv(ref, agentId, gitAccess),
    installAdapter: (ref, ctx) => envs.installAdapter(ref, ctx),
    resolveMcpServers,
    stopMcpServers,
    envStatus: (ref) => envs.status(ref),
    persist: (ws, task, records) => {
      store.writeSessions(ws, task, records).catch((e) => console.error('persist failed:', e))
    },
    onEnvIdle: (ref) => envs.noteIdle(ref),
    onEnvActive: (ref) => envs.noteActive(ref)
  })

  async function restoreSessions(): Promise<void> {
    const t = await store.buildTree()
    for (const ws of t.workspaces)
      for (const task of ws.tasks) sessions.restore(await store.readSessions(ws.name, task.name))
    // Resume the queue once, after everything is restored.
    sessions.schedule()
  }
  restoreSessions().catch((e) => console.error('session restore failed:', e))

  return {
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
      events.treeChanged()
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
