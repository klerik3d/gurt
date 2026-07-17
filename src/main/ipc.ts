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
    getCredentials: () => getCredentials(),
    setCredentials: (data) => setCredentials(data),
    credentialUsedBy: (id) => credentialUsedBy(id),
    createWorkspace: async (name) => {
      await store.createWorkspace(name)
      broadcast('tree-changed')
    },
    addRepo: async (ws, repo) => {
      await store.addRepo(ws, repo)
      broadcast('tree-changed')
    },
    discoverDevcontainer: (url) => discoverDevcontainer(url),
    updateRepo: async (ws, repo) => {
      await store.updateRepo(ws, repo)
      broadcast('tree-changed')
    },
    removeRepo: async (ws, name) => {
      await store.removeRepo(ws, name)
      broadcast('tree-changed')
    },
    createTask: async (ws, name) => {
      await store.createTask(ws, name)
      broadcast('tree-changed')
    },
    removeTask: (ws, name) => kernel.deleteTask(ws, name),
    taskDirtyRepos: (ws, name) => kernel.taskDirtyRepos(ws, name),
    startEnv: (ref) => kernel.envs.start(ref),
    stopEnv: (ref) => kernel.envs.stop(ref),
    removeEnv: (ref) => kernel.envs.remove(ref),
    getTaskChanges: (ws, task, opts) => changes.getTaskChanges(ws, task, opts ?? {}),
    getFileDiff: (ws, task, repo, file) => changes.getFileDiff(ws, task, repo, file),
    getCommitDiff: (ws, task, repo, sha) => changes.getCommitDiff(ws, task, repo, sha),
    changesCommit: (ws, task, repo, message) => changes.commit(ws, task, repo, message),
    changesPush: (ws, task, repo) => changes.push(ws, task, repo),
    changesOpenPr: async (ws, task, repo) => {
      await shell.openExternal(await changes.prUrl(ws, task, repo))
    },
    changesOpenVscode: (ws, task, repo) => changes.openInVscode(ws, task, repo),
    createSession: async (ref, agent, prompt, action, mcp, autoAllow, gitAccess) =>
      kernel.sessions.createSession(ref, agent, prompt, action, mcp, autoAllow, gitAccess),
    sessionRun: async (id) => kernel.sessions.run(id),
    sessionEnqueue: async (id) => kernel.sessions.enqueue(id),
    sessionCancelQueue: async (id) => kernel.sessions.cancelQueue(id),
    sessionEditPrompt: async (id, text) => kernel.sessions.editPrompt(id, text),
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
