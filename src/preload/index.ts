import { contextBridge, ipcRenderer } from 'electron'
import type { AgentsFile, EnvRef, McpSelection, RepoConfig } from '../shared/types'

const api = {
  getTree: () => ipcRenderer.invoke('tree:get'),
  getMcpDefs: () => ipcRenderer.invoke('mcp:list'),
  getAgents: () => ipcRenderer.invoke('agents:get'),
  setAgents: (agents: AgentsFile) => ipcRenderer.invoke('agents:set', agents),
  createWorkspace: (name: string) => ipcRenderer.invoke('workspace:create', name),
  addRepo: (ws: string, repo: RepoConfig) => ipcRenderer.invoke('repo:add', ws, repo),
  discoverDevcontainer: (url: string) => ipcRenderer.invoke('repo:discover-devcontainer', url),
  updateRepo: (ws: string, repo: RepoConfig) => ipcRenderer.invoke('repo:update', ws, repo),
  removeRepo: (ws: string, name: string) => ipcRenderer.invoke('repo:remove', ws, name),
  createTask: (ws: string, name: string) => ipcRenderer.invoke('task:create', ws, name),
  removeTask: (ws: string, name: string) => ipcRenderer.invoke('task:remove', ws, name),
  taskDirtyRepos: (ws: string, name: string) => ipcRenderer.invoke('task:dirty-repos', ws, name),
  startEnv: (ref: EnvRef) => ipcRenderer.invoke('env:start', ref),
  stopEnv: (ref: EnvRef) => ipcRenderer.invoke('env:stop', ref),
  removeEnv: (ref: EnvRef) => ipcRenderer.invoke('env:remove', ref),
  createSession: (
    ref: EnvRef,
    agent: string,
    prompt: string,
    action: string,
    mcp: McpSelection[],
    autoAllow: boolean,
    model?: string
  ) => ipcRenderer.invoke('session:create', ref, agent, prompt, action, mcp, autoAllow, model),
  sessionRun: (id: string) => ipcRenderer.invoke('session:run', id),
  sessionEnqueue: (id: string) => ipcRenderer.invoke('session:enqueue', id),
  sessionCancelQueue: (id: string) => ipcRenderer.invoke('session:cancel-queue', id),
  sessionEditPrompt: (id: string, text: string) =>
    ipcRenderer.invoke('session:edit-prompt', id, text),
  sessionDelete: (id: string) => ipcRenderer.invoke('session:delete', id),
  sessionSnapshot: (id: string) => ipcRenderer.invoke('session:snapshot', id),
  sessionPrompt: (id: string, text: string) => ipcRenderer.invoke('session:prompt', id, text),
  sessionCancel: (id: string) => ipcRenderer.invoke('session:cancel', id),
  sessionSetMode: (id: string, modeId: string) => ipcRenderer.invoke('session:set-mode', id, modeId),
  sessionAutoAllow: (id: string, v: boolean) => ipcRenderer.invoke('session:auto-allow', id, v),
  sessionPermission: (id: string, entryId: number, optionId: string) =>
    ipcRenderer.invoke('session:permission', id, entryId, optionId),
  sessionActivity: (id: string) => ipcRenderer.invoke('session:activity', id),

  onTreeChanged: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('tree-changed', listener)
    return () => ipcRenderer.removeListener('tree-changed', listener)
  },
  onSessionChanged: (cb: (snapshot: unknown) => void) => {
    const listener = (_e: unknown, snapshot: unknown) => cb(snapshot)
    ipcRenderer.on('session-changed', listener)
    return () => ipcRenderer.removeListener('session-changed', listener)
  },
  onProvisionLog: (cb: (event: { key: string; line: string }) => void) => {
    const listener = (_e: unknown, event: { key: string; line: string }) => cb(event)
    ipcRenderer.on('provision-log', listener)
    return () => ipcRenderer.removeListener('provision-log', listener)
  }
}

contextBridge.exposeInMainWorld('gurt', api)

export type GurtApi = typeof api
