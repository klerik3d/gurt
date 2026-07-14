import { BrowserWindow, ipcMain } from 'electron'
import type { AgentsFile, EnvRef, EnvState, RepoConfig, Tree } from '../shared/types'
import { agentDef } from '../shared/agents'
import * as store from './store'
import { cloneDir } from './store'
import {
  devcontainerUp,
  dockerRemove,
  dockerStop,
  ensureClone,
  installAcpAdapter,
  overrideConfigArgs,
  removeClone
} from './provision'
import { SessionManager, type EnvContext } from './sessions'

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, ...args)
}

const envKey = (ref: EnvRef) => `${ref.workspace}/${ref.task}/${ref.repo}`

async function getEnv(ref: EnvRef): Promise<EnvState> {
  const task = await store.getTask(ref.workspace, ref.task)
  const env = task.envs.find((e) => e.repo === ref.repo)
  if (!env) throw new Error(`no env for repo "${ref.repo}" in task "${ref.task}"`)
  return env
}

/** Everything a session needs from an environment, validated. */
async function resolveEnv(ref: EnvRef): Promise<EnvContext> {
  const env = await getEnv(ref)
  if (env.status !== 'running' || !env.remoteWorkspaceFolder)
    throw new Error('environment is not running — start it first')
  const agentId = env.agent ?? 'claude-code'
  const def = agentDef(agentId)
  if (!def) throw new Error(`unknown agent "${agentId}"`)
  const agents = await store.getAgents()
  const cfg = agents[agentId]
  if (!cfg?.enabled) throw new Error(`agent "${def.label}" is disabled — enable it in Agents`)
  const repo = (await store.getWorkspace(ref.workspace)).repos.find((r) => r.name === ref.repo)
  if (!repo) throw new Error(`repo "${ref.repo}" is not registered in "${ref.workspace}"`)
  return {
    agent: def,
    remoteWorkspaceFolder: env.remoteWorkspaceFolder,
    hostWorkspaceFolder: cloneDir(ref.workspace, ref.task, ref.repo),
    configArgs: await overrideConfigArgs(ref, repo),
    secret: cfg.secret,
    secretEnv: cfg.secretEnv || def.secretEnv
  }
}

const sessions = new SessionManager({
  onSessionsChanged: () => broadcast('tree-changed'),
  onSessionChanged: (id) => {
    const snap = sessions.snapshot(id)
    if (snap) broadcast('session-changed', snap)
  },
  resolveEnv,
  persist: (ws, task, records) => {
    store.writeSessions(ws, task, records).catch((e) => console.error('persist failed:', e))
  }
})

async function restoreSessions(): Promise<void> {
  const tree = await store.buildTree()
  for (const ws of tree.workspaces)
    for (const task of ws.tasks)
      sessions.restore(await store.readSessions(ws.name, task.name))
}

async function tree(): Promise<Tree> {
  const t = await store.buildTree()
  for (const ws of t.workspaces)
    for (const task of ws.tasks)
      for (const env of task.envs)
        env.sessions = sessions.listForEnv({ workspace: ws.name, task: task.name, repo: env.repo })
  return t
}

async function startEnv(ref: EnvRef): Promise<void> {
  const ws = await store.getWorkspace(ref.workspace)
  const repo = ws.repos.find((r) => r.name === ref.repo)
  if (!repo) throw new Error(`repo "${ref.repo}" is not registered in "${ref.workspace}"`)
  const env = await getEnv(ref)
  const def = agentDef(env.agent ?? 'claude-code')
  if (!def) throw new Error(`unknown agent "${env.agent}"`)
  const log = (line: string) => broadcast('provision-log', { key: envKey(ref), line })
  console.log(`[env:start] ${envKey(ref)} agent=${def.id}`)

  await store.updateEnv(ref.workspace, ref.task, ref.repo, { status: 'starting', error: undefined })
  broadcast('tree-changed')
  try {
    const dir = await ensureClone(ref, repo, log)
    const configArgs = await overrideConfigArgs(ref, repo)
    const up = await devcontainerUp(ref, def, configArgs, dir, log)
    await installAcpAdapter(ref, def, configArgs, dir, log)
    await store.updateEnv(ref.workspace, ref.task, ref.repo, {
      status: 'running',
      containerId: up.containerId,
      remoteWorkspaceFolder: up.remoteWorkspaceFolder
    })
    log('environment is running')
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await store.updateEnv(ref.workspace, ref.task, ref.repo, { status: 'error', error: message })
    log(`error: ${message}`)
    throw e
  } finally {
    broadcast('tree-changed')
  }
}

async function stopEnv(ref: EnvRef): Promise<void> {
  const env = await getEnv(ref)
  const log = (line: string) => broadcast('provision-log', { key: envKey(ref), line })
  sessions.closeEnv(ref)
  if (env.containerId) await dockerStop(env.containerId, log)
  await store.updateEnv(ref.workspace, ref.task, ref.repo, { status: 'stopped' })
  log('environment stopped')
  broadcast('tree-changed')
}

async function deleteEnv(ref: EnvRef): Promise<void> {
  const env = await getEnv(ref)
  const log = (line: string) => broadcast('provision-log', { key: envKey(ref), line })
  sessions.dropEnvSessions(ref)
  if (env.containerId) await dockerRemove(env.containerId, log)
  await removeClone(ref)
  await store.removeEnv(ref.workspace, ref.task, ref.repo)
  broadcast('tree-changed')
}

async function deleteTask(ws: string, task: string): Promise<void> {
  const data = await store.getTask(ws, task)
  for (const env of data.envs) {
    const ref: EnvRef = { workspace: ws, task, repo: env.repo }
    sessions.dropEnvSessions(ref)
    if (env.containerId)
      await dockerRemove(env.containerId, () => {})
  }
  sessions.dropTaskSessions(ws, task)
  await store.removeTaskDir(ws, task)
  broadcast('tree-changed')
}

export function registerIpc(): void {
  const handle = (channel: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, (_e, ...args) => fn(...args))

  handle('tree:get', () => tree())
  handle('agents:get', () => store.getAgents())
  handle('agents:set', (agents: AgentsFile) => store.setAgents(agents))
  handle('workspace:create', async (name: string) => {
    await store.createWorkspace(name)
    broadcast('tree-changed')
  })
  handle('repo:add', async (ws: string, repo: RepoConfig) => {
    await store.addRepo(ws, repo)
    broadcast('tree-changed')
  })
  handle('repo:update', async (ws: string, repo: RepoConfig) => {
    await store.updateRepo(ws, repo)
    broadcast('tree-changed')
  })
  handle('repo:remove', async (ws: string, name: string) => {
    await store.removeRepo(ws, name)
    broadcast('tree-changed')
  })
  handle('task:create', async (ws: string, name: string) => {
    await store.createTask(ws, name)
    broadcast('tree-changed')
  })
  handle('task:remove', (ws: string, name: string) => deleteTask(ws, name))
  handle('env:add', async (ref: EnvRef, agent: string) => {
    await store.addEnv(ref.workspace, ref.task, ref.repo, agent)
    broadcast('tree-changed')
  })
  handle('env:start', (ref: EnvRef) => startEnv(ref))
  handle('env:stop', (ref: EnvRef) => stopEnv(ref))
  handle('env:remove', (ref: EnvRef) => deleteEnv(ref))
  handle('session:create', (ref: EnvRef) => sessions.create(ref))
  handle('session:snapshot', (id: string) => sessions.snapshot(id))
  handle('session:prompt', (id: string, text: string) => sessions.prompt(id, text))
  handle('session:cancel', (id: string) => sessions.cancel(id))
  handle('session:set-mode', (id: string, modeId: string) => sessions.setMode(id, modeId))
  handle('session:auto-allow', (id: string, v: boolean) => sessions.setAutoAllow(id, v))
  handle('session:permission', (id: string, entryId: number, optionId: string) =>
    sessions.respondPermission(id, entryId, optionId)
  )

  restoreSessions().catch((e) => console.error('session restore failed:', e))
}
