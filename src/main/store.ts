import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import type {
  AgentsFile,
  EnvState,
  PersistedSession,
  RepoConfig,
  TaskFile,
  Tree,
  WorkspaceFile
} from '../shared/types'
import { AGENT_DEFS, agentDef } from '../shared/agents'

const pexecFile = promisify(execFile)

/**
 * Recursively remove a directory tree. Node's `fs.rm` walks entries then
 * `rmdir`s each parent; on the deep trees a cloned repo's `node_modules`
 * produces — the container's `npm install` writes into the bind-mounted clone —
 * that races on macOS and throws `ENOTEMPTY` even with `maxRetries`. On POSIX we
 * hand off to `rm -rf`, which does not have this problem. `fs.rm` remains the
 * win32 path and the fallback if spawning `rm` fails.
 */
export async function rmTree(dir: string): Promise<void> {
  if (process.platform !== 'win32') {
    try {
      await pexecFile('/bin/rm', ['-rf', '--', dir])
      return
    } catch {
      // fall through to fs.rm
    }
  }
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

export const gurtRoot = process.env.GURT_ROOT || path.join(os.homedir(), '.gurt')

export const wsDir = (ws: string) => path.join(gurtRoot, ws)
export const taskDir = (ws: string, task: string) => path.join(gurtRoot, ws, task)
export const cloneDir = (ws: string, task: string, repo: string) =>
  path.join(gurtRoot, ws, task, repo)
/** Host-side dir for user-provided inline devcontainer configs. */
export const overrideConfigPath = (ws: string, repo: string) =>
  path.join(gurtRoot, ws, '.devcontainers', `${repo}.json`)

/** Names become path segments on disk, so reject anything that isn't a single, safe segment. */
function validateName(kind: string, name: string): void {
  const n = name.trim()
  if (!n) throw new Error(`${kind} name must not be empty`)
  if (n === '.' || n === '..' || /[/\\]/.test(n))
    throw new Error(`${kind} name must not contain "/", "\\", "." or ".."`)
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n')
}

const agentsFile = () => path.join(gurtRoot, 'agents.json')

export async function getAgents(): Promise<AgentsFile> {
  const raw = await readJson<Record<string, any>>(agentsFile(), {})
  const agents: AgentsFile = {}
  for (const [id, a] of Object.entries(raw)) {
    if (!a || typeof a !== 'object') continue
    if (typeof a.kind === 'string') {
      // Current format: an instance carrying its own kind.
      agents[id] = {
        kind: a.kind,
        label: a.label || agentDef(a.kind)?.label || a.kind,
        enabled: !!a.enabled,
        secret: a.secret ?? '',
        secretEnv: a.secretEnv || undefined,
        env: a.env && typeof a.env === 'object' ? a.env : undefined,
        model: a.model || undefined
      }
    } else {
      // Legacy format: one config per built-in kind, keyed by the kind id. Lift
      // each into an instance of that kind (the kind id doubles as instance id).
      const def = agentDef(id)
      if (!def) continue
      agents[id] = {
        kind: id,
        label: def.label,
        enabled: a.enabled ?? id === 'claude-code',
        // migrate the pre-registry claude-only field name
        secret: a.secret ?? a.oauthToken ?? '',
        secretEnv: a.secretEnv || undefined
      }
    }
  }
  // Fresh install: seed the built-in kinds as starter instances.
  if (Object.keys(agents).length === 0) {
    for (const def of AGENT_DEFS)
      agents[def.id] = {
        kind: def.id,
        label: def.label,
        enabled: def.id === 'claude-code',
        secret: ''
      }
  }
  return agents
}

export async function setAgents(agents: AgentsFile): Promise<void> {
  await writeJson(agentsFile(), agents)
}

export async function createWorkspace(name: string): Promise<void> {
  validateName('workspace', name)
  const file = path.join(wsDir(name), 'workspace.json')
  if (existsSync(file)) throw new Error(`workspace "${name}" already exists`)
  await writeJson(file, { repos: [] } satisfies WorkspaceFile)
}

export async function getWorkspace(ws: string): Promise<WorkspaceFile> {
  return readJson<WorkspaceFile>(path.join(wsDir(ws), 'workspace.json'), { repos: [] })
}

async function saveWorkspace(ws: string, data: WorkspaceFile): Promise<void> {
  await writeJson(path.join(wsDir(ws), 'workspace.json'), data)
}

export async function addRepo(ws: string, repo: RepoConfig): Promise<void> {
  validateName('repo', repo.name)
  const data = await getWorkspace(ws)
  if (data.repos.some((r) => r.name === repo.name))
    throw new Error(`repo "${repo.name}" already exists in "${ws}"`)
  data.repos.push(repo)
  await saveWorkspace(ws, data)
}

export async function updateRepo(ws: string, repo: RepoConfig): Promise<void> {
  const data = await getWorkspace(ws)
  const i = data.repos.findIndex((r) => r.name === repo.name)
  if (i < 0) throw new Error(`repo "${repo.name}" not found in "${ws}"`)
  data.repos[i] = repo
  await saveWorkspace(ws, data)
}

/** Task names of this workspace that have an env for the repo. */
export async function tasksUsingRepo(ws: string, repo: string): Promise<string[]> {
  const used: string[] = []
  for (const task of await listTasks(ws)) {
    const data = await getTask(ws, task)
    if (data.envs.some((e) => e.repo === repo)) used.push(task)
  }
  return used
}

export async function removeRepo(ws: string, repo: string): Promise<void> {
  const used = await tasksUsingRepo(ws, repo)
  if (used.length)
    throw new Error(`repo "${repo}" is used by task(s): ${used.join(', ')} — delete those envs first`)
  const data = await getWorkspace(ws)
  data.repos = data.repos.filter((r) => r.name !== repo)
  await saveWorkspace(ws, data)
  await fs.rm(overrideConfigPath(ws, repo), { force: true })
}

export async function createTask(ws: string, task: string): Promise<void> {
  validateName('task', task)
  const file = path.join(taskDir(ws, task), 'task.json')
  if (existsSync(file)) throw new Error(`task "${task}" already exists in "${ws}"`)
  await writeJson(file, { envs: [] } satisfies TaskFile)
}

export async function listTasks(ws: string): Promise<string[]> {
  const tasks: string[] = []
  for (const entry of await fs.readdir(wsDir(ws), { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && existsSync(path.join(taskDir(ws, entry.name), 'task.json')))
      tasks.push(entry.name)
  }
  return tasks
}

export async function getTask(ws: string, task: string): Promise<TaskFile> {
  return readJson<TaskFile>(path.join(taskDir(ws, task), 'task.json'), { envs: [] })
}

export async function saveTask(ws: string, task: string, data: TaskFile): Promise<void> {
  await writeJson(path.join(taskDir(ws, task), 'task.json'), data)
}

export async function removeTaskDir(ws: string, task: string): Promise<void> {
  await rmTree(taskDir(ws, task))
}

/** Ensure a (stopped) env record exists for the repo; idempotent. */
export async function ensureEnv(ws: string, task: string, repo: string): Promise<void> {
  const data = await getTask(ws, task)
  if (data.envs.some((e) => e.repo === repo)) return
  data.envs.push({ repo, status: 'stopped' } satisfies EnvState)
  await saveTask(ws, task, data)
}

export async function removeEnv(ws: string, task: string, repo: string): Promise<void> {
  const data = await getTask(ws, task)
  data.envs = data.envs.filter((e) => e.repo !== repo)
  await saveTask(ws, task, data)
}

export async function updateEnv(
  ws: string,
  task: string,
  repo: string,
  patch: Partial<EnvState>
): Promise<void> {
  const data = await getTask(ws, task)
  const env = data.envs.find((e) => e.repo === repo)
  if (!env) throw new Error(`no env for repo "${repo}" in task "${task}"`)
  Object.assign(env, patch)
  await saveTask(ws, task, data)
}

const sessionsFile = (ws: string, task: string) => path.join(taskDir(ws, task), 'sessions.json')

export async function readSessions(ws: string, task: string): Promise<PersistedSession[]> {
  const records = await readJson<PersistedSession[]>(sessionsFile(ws, task), [])
  // Migration: pre-queue records have no state — treat them as started.
  for (const r of records) {
    if (!r.info.state) r.info.state = 'started'
    if (r.info.startPrompt == null) r.info.startPrompt = ''
    // `starting` is runtime-only; a crash mid-start restores as draft.
    if (r.info.state === 'starting') {
      r.info.state = 'draft'
      r.info.queuedAt = undefined
    }
  }
  return records
}

export async function writeSessions(
  ws: string,
  task: string,
  records: PersistedSession[]
): Promise<void> {
  await writeJson(sessionsFile(ws, task), records)
}

/** Tree without sessions; the session manager overlays those. */
export async function buildTree(): Promise<Tree> {
  await fs.mkdir(gurtRoot, { recursive: true })
  const tree: Tree = { workspaces: [] }
  for (const wsEntry of await fs.readdir(gurtRoot, { withFileTypes: true })) {
    if (!wsEntry.isDirectory()) continue
    const ws = wsEntry.name
    if (!existsSync(path.join(wsDir(ws), 'workspace.json'))) continue
    const wsData = await getWorkspace(ws)
    const tasks: Tree['workspaces'][number]['tasks'] = []
    for (const task of await listTasks(ws)) {
      const taskData = await getTask(ws, task)
      // `agent` on legacy env records is ignored (envs are agent-agnostic now).
      tasks.push({
        name: task,
        envs: taskData.envs.map((e) => ({
          repo: e.repo,
          containerId: e.containerId,
          remoteWorkspaceFolder: e.remoteWorkspaceFolder,
          status: e.status,
          error: e.error
        })),
        sessions: []
      })
    }
    tree.workspaces.push({ name: ws, repos: wsData.repos, tasks })
  }
  return tree
}
