// The whole Electron-facing surface: broadcast bridge, the `GurtApi`
// implementation over the kernel, and handler registration. Everything
// domain-shaped lives in kernel.ts and below.
import { BrowserWindow, ipcMain, shell } from 'electron'
import { API_METHODS, type GurtApi } from '../shared/api'
import { MCP_DEFS } from '../shared/mcp'
import { createKernel } from './kernel'
import { getCredentials, setCredentials, credentialUsedBy } from './credentials'
import { discoverDevcontainer } from './provision'
import * as store from './store'
import * as changes from './changes'

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, ...args)
}

export function registerIpc(): void {
  const kernel = createKernel()

  kernel.bus.on('tree.changed', () => broadcast('tree-changed'))
  kernel.bus.on('session.changed', ({ sessionId }) => {
    const snap = kernel.sessions.snapshot(sessionId)
    // The per-change broadcast never carries history — timeline deltas ride
    // the session-log channel; the full fold comes from session:snapshot.
    if (snap) broadcast('session-changed', { ...snap, entries: undefined })
  })
  kernel.bus.on('session.log', (e) => broadcast('session-log', e))
  kernel.bus.on('session.turn', (e) => broadcast('session-turn', e))
  kernel.bus.on('provision.log', (e) => broadcast('provision-log', e))

  const impl: GurtApi = {
    getTree: () => kernel.tree(),
    getMcpDefs: async () => MCP_DEFS,
    getAgents: () => store.getAgents(),
    setAgents: (agents) => store.setAgents(agents),
    getAgentConfig: async (agentId) => {
      // Prefer the live in-memory cache (freshest); fall back to the persisted
      // file / hardcoded default when no session has refreshed it this run.
      const agents = await store.getAgents()
      const kind = agents[agentId]?.kind
      const live = kernel.sessions.agentConfig(agentId, kind)
      if (live.updatedAt) return live
      return store.getAgentConfig(agentId)
    },
    getCredentials: () => getCredentials(),
    setCredentials: (data) => setCredentials(data),
    credentialUsedBy: (id) => credentialUsedBy(id),
    // Store CRUD announces over the bus, not straight to the windows, so
    // headless bus subscribers (orchestrator, extensions) see these too.
    createWorkspace: async (name) => {
      await store.createWorkspace(name)
      kernel.bus.emit('tree.changed', undefined)
    },
    addRepo: async (ws, repo) => {
      await store.addRepo(ws, repo)
      kernel.bus.emit('tree.changed', undefined)
    },
    discoverDevcontainer: (url) => discoverDevcontainer(url),
    updateRepo: async (ws, repo) => {
      await store.updateRepo(ws, repo)
      kernel.bus.emit('tree.changed', undefined)
    },
    removeRepo: async (ws, name) => {
      await store.removeRepo(ws, name)
      kernel.bus.emit('tree.changed', undefined)
    },
    addEnv: async (ws, env) => {
      await store.addEnv(ws, env)
      kernel.bus.emit('tree.changed', undefined)
    },
    updateEnv: async (ws, env) => {
      await store.updateEnv(ws, env)
      kernel.bus.emit('tree.changed', undefined)
    },
    removeEnv: async (ws, name) => {
      await store.removeEnv(ws, name)
      kernel.bus.emit('tree.changed', undefined)
    },
    createTask: async (ws, name) => {
      await store.createTask(ws, name)
      kernel.bus.emit('tree.changed', undefined)
    },
    removeTask: (ws, name) => kernel.deleteTask(ws, name),
    taskDirtyRepos: (ws, name) => kernel.taskDirtyRepos(ws, name),
    stopEnv: (ref) => kernel.envs.stop(ref),
    removeTaskEnv: (ref) => kernel.envs.remove(ref),
    getTaskChanges: (ws, task, opts) => changes.getTaskChanges(ws, task, opts ?? {}),
    getFileDiff: (ws, task, repo, file) => changes.getFileDiff(ws, task, repo, file),
    getCommitDiff: (ws, task, repo, sha) => changes.getCommitDiff(ws, task, repo, sha),
    changesCommit: (ws, task, repo, message) => changes.commit(ws, task, repo, message),
    changesPush: (ws, task, repo) => changes.push(ws, task, repo),
    latestProposal: async (ws, task, repo) => kernel.sessions.latestProposal(ws, task, repo),
    changesOpenPr: async (ws, task, repo) => {
      await shell.openExternal(await kernel.prUrl(ws, task, repo))
    },
    changesOpenVscode: (ws, task, repo) => changes.openInVscode(ws, task, repo),
    createSession: async (ref, repo, agent, prompt, action, mcp, autoAllow, gitAccess, configValues) =>
      kernel.sessions.createSession(
        ref,
        repo,
        agent,
        prompt,
        action,
        mcp,
        autoAllow,
        gitAccess,
        configValues
      ),
    sessionRun: async (id) => kernel.sessions.run(id),
    sessionEnqueue: async (id) => kernel.sessions.enqueue(id),
    sessionCancelQueue: async (id) => kernel.sessions.cancelQueue(id),
    sessionEditPrompt: async (id, text) => kernel.sessions.editPrompt(id, text),
    sessionEditDraft: async (id, patch) => kernel.editDraft(id, patch),
    sessionDelete: async (id) => kernel.sessions.deleteSession(id),
    sessionSnapshot: async (id) => kernel.sessions.snapshot(id),
    sessionPrompt: (id, text, context, images) => kernel.sessions.prompt(id, text, context, images),
    sessionCancel: async (id) => kernel.sessions.cancel(id),
    sessionSetMode: (id, modeId) => kernel.sessions.setMode(id, modeId),
    sessionSetConfigOption: (id, configId, value) =>
      kernel.sessions.setConfigOption(id, configId, value),
    sessionPermission: async (id, entryId, optionId) =>
      kernel.sessions.respondPermission(id, entryId, optionId),
    sessionActivity: async (id) => kernel.sessions.activity(id)
  }

  for (const m of API_METHODS)
    ipcMain.handle(`api:${m}`, (_e, ...args) =>
      (impl[m] as (...a: unknown[]) => unknown)(...args)
    )
}
