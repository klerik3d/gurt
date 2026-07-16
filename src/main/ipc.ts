import { BrowserWindow, ipcMain } from 'electron'
import type {
  AgentsFile,
  EnvRef,
  EnvState,
  EnvStatus,
  McpSelection,
  PromptContext,
  PromptImage,
  RepoConfig,
  Tree
} from '../shared/types'
import { agentDef } from '../shared/agents'
import { MCP_DEFS } from '../shared/mcp'
import { canonicalRepoId } from '../shared/repoId'
import { resolveCredential, type CredentialsFile } from '../shared/credentials'
import { resolveMcpServers, stopMcpServers } from './mcp/manager'
import { getCredentials, setCredentials, credentialUsedBy, listCredentials } from './credentials'
import { resolveGitBroker, stopGitBroker } from './git/broker'
import { containerGitEnv } from './git/config'
import * as store from './store'
import { cloneDir } from './store'
import {
  devcontainerUp,
  discoverDevcontainer,
  dockerRemove,
  dockerRunning,
  dockerStop,
  ensureClone,
  installAcpAdapter,
  installGitShims,
  isDirty,
  overrideConfigArgs,
  removeClone
} from './provision'
import { SessionManager, type CreateAction, type EnvContext } from './sessions'
import * as changes from './changes'

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
    // The persisted `running` status can be stale — e.g. a Docker daemon
    // restart stops the container without gurt noticing. Only trust it if the
    // container is actually up; otherwise fall through to `up`, which restarts
    // the stopped container.
    if (
      env?.status === 'running' &&
      env.remoteWorkspaceFolder &&
      env.containerId &&
      (await dockerRunning(env.containerId))
    )
      return env

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
      const up = await devcontainerUp(ref, configArgs, dir, log, canonicalRepoId(repo.url)?.host)
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

/** Envs whose git shims are installed this app run — cleared on stop/delete. */
const gitShimsInstalled = new Set<string>()

/**
 * Provision (if needed) the git-access injection for a starting session: ensure
 * the per-env broker is up, the shims are installed, and return the container
 * injection env (§6). Secrets never appear here — only the broker URL+token.
 */
async function resolveGitAccess(
  ref: EnvRef,
  repo: RepoConfig,
  configArgs: string[],
  hostWorkspaceFolder: string
): Promise<Record<string, string>> {
  const host = canonicalRepoId(repo.url)?.host ?? null
  const broker = await resolveGitBroker(ref)
  const resolved = host
    ? resolveCredential(await listCredentials(), repo, host)
    : undefined
  if (!gitShimsInstalled.has(envKey(ref))) {
    await installGitShims(ref, configArgs, hostWorkspaceFolder, host, logFor(ref))
    gitShimsInstalled.add(envKey(ref))
  }
  return containerGitEnv(broker.url, host, resolved?.kind ?? 'git-host')
}

/** Ensure env is up, then build the validated launch context for an agent. */
async function resolveEnv(ref: EnvRef, agentId: string, gitAccess: boolean): Promise<EnvContext> {
  const agents = await store.getAgents()
  const cfg = agents[agentId]
  if (!cfg) throw new Error(`unknown agent "${agentId}"`)
  const def = agentDef(cfg.kind)
  if (!def) throw new Error(`agent "${cfg.label}" has unknown kind "${cfg.kind}"`)
  if (!cfg.enabled) throw new Error(`agent "${cfg.label}" is disabled — enable it in Agents`)
  const repo = (await store.getWorkspace(ref.workspace)).repos.find((r) => r.name === ref.repo)
  if (!repo) throw new Error(`repo "${ref.repo}" is not registered in "${ref.workspace}"`)

  const env = await ensureEnvRunning(ref)
  if (env.status !== 'running' || !env.remoteWorkspaceFolder)
    throw new Error('environment is not running')

  const configArgs = await overrideConfigArgs(ref, repo)
  const hostWorkspaceFolder = cloneDir(ref.workspace, ref.task, ref.repo)
  const gitBrokerEnv = gitAccess
    ? await resolveGitAccess(ref, repo, configArgs, hostWorkspaceFolder)
    : undefined

  return {
    agent: def,
    remoteWorkspaceFolder: env.remoteWorkspaceFolder,
    hostWorkspaceFolder,
    configArgs,
    secret: cfg.secret,
    secretEnv: cfg.secretEnv || def.secretEnv,
    env: cfg.env,
    gitBrokerEnv
  }
}

async function installAdapter(ref: EnvRef, ctx: EnvContext): Promise<void> {
  await installAcpAdapter(ref, ctx.agent, ctx.configArgs, ctx.hostWorkspaceFolder, logFor(ref))
}

/** Container is stopped after a session sits idle this long with no new activity. */
const ENV_IDLE_STOP_MS = 30_000
const idleTimers = new Map<string, NodeJS.Timeout>()

function cancelIdleStop(ref: EnvRef): void {
  const key = envKey(ref)
  const timer = idleTimers.get(key)
  if (!timer) return
  clearTimeout(timer)
  idleTimers.delete(key)
}

function scheduleIdleStop(ref: EnvRef): void {
  const key = envKey(ref)
  cancelIdleStop(ref)
  idleTimers.set(
    key,
    setTimeout(() => {
      idleTimers.delete(key)
      autoStopIfIdle(ref).catch((e) => console.error('auto-stop failed:', e))
    }, ENV_IDLE_STOP_MS)
  )
}

/**
 * Re-verify the env is still idle *and* running before stopping. Guards against a
 * session resuming in the window after the timer fired, and against clobbering a
 * non-running status (e.g. `error` from a failed start) with `stopped`.
 */
async function autoStopIfIdle(ref: EnvRef): Promise<void> {
  if (!sessions.isEnvIdle(ref)) return
  if ((await envStatus(ref)) !== 'running') return
  if (!sessions.isEnvIdle(ref)) return
  await stopEnv(ref)
}

const sessions = new SessionManager({
  onSessionsChanged: () => broadcast('tree-changed'),
  onSessionChanged: (id) => {
    const snap = sessions.snapshot(id)
    if (snap) broadcast('session-changed', snap)
  },
  resolveEnv,
  installAdapter,
  resolveMcpServers,
  stopMcpServers,
  envStatus,
  persist: (ws, task, records) => {
    store.writeSessions(ws, task, records).catch((e) => console.error('persist failed:', e))
  },
  onEnvIdle: scheduleIdleStop,
  onEnvActive: cancelIdleStop
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
  cancelIdleStop(ref)
  const env = await findEnv(ref)
  const log = logFor(ref)
  sessions.closeEnv(ref)
  stopGitBroker(ref)
  gitShimsInstalled.delete(envKey(ref))
  if (env?.containerId) await dockerStop(env.containerId, log)
  await store.updateEnv(ref.workspace, ref.task, ref.repo, { status: 'stopped' })
  log('environment stopped')
  broadcast('tree-changed')
  // A freed repo may release queued sessions.
  sessions.schedule()
}

/** Delete the env infrastructure. Sessions are kept (they re-provision on run). */
async function deleteEnv(ref: EnvRef): Promise<void> {
  cancelIdleStop(ref)
  const env = await findEnv(ref)
  const log = logFor(ref)
  sessions.closeEnv(ref)
  stopGitBroker(ref)
  gitShimsInstalled.delete(envKey(ref))
  if (env?.containerId) await dockerRemove(env.containerId, log)
  // Drop the env record even if the clone can't be fully removed, so a filesystem
  // hiccup never leaves a ghost env in the tree pointing at a half-deleted clone.
  try {
    await removeClone(ref)
  } catch (e) {
    log(`clone removal failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  await store.removeEnv(ref.workspace, ref.task, ref.repo)
  broadcast('tree-changed')
  sessions.schedule()
}

/** Repos in this task whose clone has uncommitted changes. */
async function taskDirtyRepos(ws: string, task: string): Promise<string[]> {
  const data = await store.getTask(ws, task)
  const dirty: string[] = []
  for (const env of data.envs)
    if (await isDirty(cloneDir(ws, task, env.repo))) dirty.push(env.repo)
  return dirty
}

async function deleteTask(ws: string, task: string): Promise<void> {
  const data = await store.getTask(ws, task)
  for (const env of data.envs) {
    const ref = { workspace: ws, task, repo: env.repo }
    cancelIdleStop(ref)
    sessions.closeEnv(ref)
    stopGitBroker(ref)
    gitShimsInstalled.delete(envKey(ref))
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
  handle('mcp:list', () => MCP_DEFS)
  handle('agents:get', () => store.getAgents())
  handle('agents:set', (agents: AgentsFile) => store.setAgents(agents))
  handle('credentials:get', () => getCredentials())
  handle('credentials:set', (data: CredentialsFile) => setCredentials(data))
  handle('credentials:used-by', (id: string) => credentialUsedBy(id))
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
  handle('task:dirty-repos', (ws: string, name: string) => taskDirtyRepos(ws, name))

  handle('env:start', (ref: EnvRef) => startEnv(ref))
  handle('env:stop', (ref: EnvRef) => stopEnv(ref))
  handle('env:remove', (ref: EnvRef) => deleteEnv(ref))

  handle('changes:get', (ws: string, task: string, opts: { fetch?: boolean }) =>
    changes.getTaskChanges(ws, task, opts)
  )
  handle('changes:diff', (ws: string, task: string, repo: string, file: string) =>
    changes.getFileDiff(ws, task, repo, file)
  )
  handle('changes:commit-diff', (ws: string, task: string, repo: string, sha: string) =>
    changes.getCommitDiff(ws, task, repo, sha)
  )
  handle('changes:commit', (ws: string, task: string, repo: string, message: string) =>
    changes.commit(ws, task, repo, message)
  )
  handle('changes:push', (ws: string, task: string, repo: string) => changes.push(ws, task, repo))
  handle('changes:open-pr', (ws: string, task: string, repo: string) =>
    changes.openPr(ws, task, repo)
  )
  handle('changes:open-vscode', (ws: string, task: string, repo: string) =>
    changes.openInVscode(ws, task, repo)
  )

  handle(
    'session:create',
    (
      ref: EnvRef,
      agent: string,
      prompt: string,
      action: CreateAction,
      mcp: McpSelection[],
      autoAllow: boolean,
      gitAccess: boolean
    ) => sessions.createSession(ref, agent, prompt, action, mcp, autoAllow, gitAccess)
  )
  handle('session:run', (id: string) => sessions.run(id))
  handle('session:enqueue', (id: string) => sessions.enqueue(id))
  handle('session:cancel-queue', (id: string) => sessions.cancelQueue(id))
  handle('session:edit-prompt', (id: string, text: string) => sessions.editPrompt(id, text))
  handle('session:delete', (id: string) => sessions.deleteSession(id))
  handle('session:snapshot', (id: string) => sessions.snapshot(id))
  handle(
    'session:prompt',
    (id: string, text: string, context?: PromptContext[], images?: PromptImage[]) =>
      sessions.prompt(id, text, context, images)
  )
  handle('session:cancel', (id: string) => sessions.cancel(id))
  handle('session:set-mode', (id: string, modeId: string) => sessions.setMode(id, modeId))
  handle('session:set-config-option', (id: string, configId: string, value: string | boolean) =>
    sessions.setConfigOption(id, configId, value)
  )
  handle('session:permission', (id: string, entryId: number, optionId: string) =>
    sessions.respondPermission(id, entryId, optionId)
  )
  handle('session:activity', (id: string) => sessions.activity(id))

  restoreSessions().catch((e) => console.error('session restore failed:', e))
}
