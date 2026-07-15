import { BrowserWindow, ipcMain } from 'electron'
import type { AgentsFile, EnvRef, EnvState, EnvStatus, RepoConfig, Tree } from '../shared/types'
import { agentDef } from '../shared/agents'
import * as store from './store'
import { cloneDir } from './store'
import {
  devcontainerUp,
  discoverDevcontainer,
  dockerRemove,
  dockerStop,
  ensureClone,
  installAcpAdapter,
  overrideConfigArgs,
  removeClone
} from './provision'
import { SessionManager, type CreateAction, type EnvContext } from './sessions'

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, ...args)
}

const envKey = (ref: EnvRef) => `${ref.workspace}/${ref.task}/${ref.repo}`
const logFor = (ref: EnvRef) => (line: string) =>
  broadcast('provision-log', { key: envKey(ref), line })

async function findEnv(ref: EnvRef): Promise<EnvState | undefined> {
  const task = await store.getTask(ref.workspace, ref.task)
  return task.envs.find((e) => e.repo === ref.repo)
}

async function envStatus(ref: EnvRef): Promise<EnvStatus> {
  return (await findEnv(ref))?.status ?? 'stopped'
}

/** In-flight `up` per env, so concurrent starts (Run now + confirm) share one. */
const ensureInFlight = new Map<string, Promise<EnvState>>()

/**
 * Ensure the container is up: create the env record if missing, clone, and
 * `devcontainer up` (reusing a stopped container). Idempotent; agent-agnostic.
 */
function ensureEnvRunning(ref: EnvRef): Promise<EnvState> {
  const key = envKey(ref)
  const running = ensureInFlight.get(key)
  if (running) return running
  const p = (async () => {
    await store.ensureEnv(ref.workspace, ref.task, ref.repo)
    let env = await findEnv(ref)
    if (env?.status === 'running' && env.remoteWorkspaceFolder) return env

    const ws = await store.getWorkspace(ref.workspace)
    const repo = ws.repos.find((r) => r.name === ref.repo)
    if (!repo) throw new Error(`repo "${ref.repo}" is not registered in "${ref.workspace}"`)
    const log = logFor(ref)

    await store.updateEnv(ref.workspace, ref.task, ref.repo, {
      status: 'starting',
      error: undefined
    })
    broadcast('tree-changed')
    try {
      const dir = await ensureClone(ref, repo, log)
      const configArgs = await overrideConfigArgs(ref, repo)
      const up = await devcontainerUp(ref, configArgs, dir, log)
      await store.updateEnv(ref.workspace, ref.task, ref.repo, {
        status: 'running',
        containerId: up.containerId,
        remoteWorkspaceFolder: up.remoteWorkspaceFolder
      })
      log('environment is running')
      env = await findEnv(ref)
      return env!
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      await store.updateEnv(ref.workspace, ref.task, ref.repo, { status: 'error', error: message })
      log(`error: ${message}`)
      throw e
    } finally {
      broadcast('tree-changed')
    }
  })()
  ensureInFlight.set(key, p)
  p.finally(() => ensureInFlight.delete(key)).catch(() => {})
  return p
}

/** Ensure env is up, then build the validated launch context for an agent. */
async function resolveEnv(ref: EnvRef, agentId: string): Promise<EnvContext> {
  const def = agentDef(agentId)
  if (!def) throw new Error(`unknown agent "${agentId}"`)
  const agents = await store.getAgents()
  const cfg = agents[agentId]
  if (!cfg?.enabled) throw new Error(`agent "${def.label}" is disabled — enable it in Agents`)
  const repo = (await store.getWorkspace(ref.workspace)).repos.find((r) => r.name === ref.repo)
  if (!repo) throw new Error(`repo "${ref.repo}" is not registered in "${ref.workspace}"`)

  const env = await ensureEnvRunning(ref)
  if (env.status !== 'running' || !env.remoteWorkspaceFolder)
    throw new Error('environment is not running')

  return {
    agent: def,
    remoteWorkspaceFolder: env.remoteWorkspaceFolder,
    hostWorkspaceFolder: cloneDir(ref.workspace, ref.task, ref.repo),
    configArgs: await overrideConfigArgs(ref, repo),
    secret: cfg.secret,
    secretEnv: cfg.secretEnv || def.secretEnv
  }
}

async function installAdapter(ref: EnvRef, ctx: EnvContext): Promise<void> {
  await installAcpAdapter(ref, ctx.agent, ctx.configArgs, ctx.hostWorkspaceFolder, logFor(ref))
}

const sessions = new SessionManager({
  onSessionsChanged: () => broadcast('tree-changed'),
  onSessionChanged: (id) => {
    const snap = sessions.snapshot(id)
    if (snap) broadcast('session-changed', snap)
  },
  resolveEnv,
  installAdapter,
  envStatus,
  persist: (ws, task, records) => {
    store.writeSessions(ws, task, records).catch((e) => console.error('persist failed:', e))
  }
})

async function restoreSessions(): Promise<void> {
  const tree = await store.buildTree()
  for (const ws of tree.workspaces)
    for (const task of ws.tasks)
      sessions.restore(await store.readSessions(ws.name, task.name))
  // Resume the queue once, after everything is restored.
  sessions.schedule()
}

async function tree(): Promise<Tree> {
  const t = await store.buildTree()
  for (const ws of t.workspaces)
    for (const task of ws.tasks)
      task.sessions = sessions.listForTask(ws.name, task.name)
  return t
}

async function startEnv(ref: EnvRef): Promise<void> {
  await ensureEnvRunning(ref)
}

async function stopEnv(ref: EnvRef): Promise<void> {
  const env = await findEnv(ref)
  const log = logFor(ref)
  sessions.closeEnv(ref)
  if (env?.containerId) await dockerStop(env.containerId, log)
  await store.updateEnv(ref.workspace, ref.task, ref.repo, { status: 'stopped' })
  log('environment stopped')
  broadcast('tree-changed')
  // A freed repo may release queued sessions.
  sessions.schedule()
}

/** Delete the env infrastructure. Sessions are kept (they re-provision on run). */
async function deleteEnv(ref: EnvRef): Promise<void> {
  const env = await findEnv(ref)
  const log = logFor(ref)
  sessions.closeEnv(ref)
  if (env?.containerId) await dockerRemove(env.containerId, log)
  await removeClone(ref)
  await store.removeEnv(ref.workspace, ref.task, ref.repo)
  broadcast('tree-changed')
  sessions.schedule()
}

async function deleteTask(ws: string, task: string): Promise<void> {
  const data = await store.getTask(ws, task)
  for (const env of data.envs) {
    sessions.closeEnv({ workspace: ws, task, repo: env.repo })
    if (env.containerId) await dockerRemove(env.containerId, () => {})
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
  handle('repo:discover-devcontainer', (url: string) => discoverDevcontainer(url))
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

  handle('env:start', (ref: EnvRef) => startEnv(ref))
  handle('env:stop', (ref: EnvRef) => stopEnv(ref))
  handle('env:remove', (ref: EnvRef) => deleteEnv(ref))

  handle('session:create', (ref: EnvRef, agent: string, prompt: string, action: CreateAction) =>
    sessions.createSession(ref, agent, prompt, action)
  )
  handle('session:run', (id: string) => sessions.run(id))
  handle('session:enqueue', (id: string) => sessions.enqueue(id))
  handle('session:cancel-queue', (id: string) => sessions.cancelQueue(id))
  handle('session:edit-prompt', (id: string, text: string) => sessions.editPrompt(id, text))
  handle('session:delete', (id: string) => sessions.deleteSession(id))
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
