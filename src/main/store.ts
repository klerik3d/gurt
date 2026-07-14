import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
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
import { AGENT_DEFS } from '../shared/agents'

export const gurtRoot = process.env.GURT_ROOT || path.join(os.homedir(), '.gurt')

export const wsDir = (ws: string) => path.join(gurtRoot, ws)
export const taskDir = (ws: string, task: string) => path.join(gurtRoot, ws, task)
export const cloneDir = (ws: string, task: string, repo: string) =>
  path.join(gurtRoot, ws, task, repo)
/** Host-side dir for user-provided inline devcontainer configs. */
export const overrideConfigPath = (ws: string, repo: string) =>
  path.join(gurtRoot, ws, '.devcontainers', `${repo}.json`)

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
  for (const def of AGENT_DEFS) {
    const a = raw[def.id] ?? {}
    agents[def.id] = {
      enabled: a.enabled ?? def.id === 'claude-code',
      // migrate the pre-registry claude-only field name
      secret: a.secret ?? a.oauthToken ?? '',
      secretEnv: a.secretEnv || def.secretEnv
    }
  }
  return agents
}

export async function setAgents(agents: AgentsFile): Promise<void> {
  await writeJson(agentsFile(), agents)
}

export async function createWorkspace(name: string): Promise<void> {
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
  await fs.rm(taskDir(ws, task), { recursive: true, force: true })
}

export async function addEnv(ws: string, task: string, repo: string, agent: string): Promise<void> {
  const data = await getTask(ws, task)
  if (data.envs.some((e) => e.repo === repo))
    throw new Error(`env for repo "${repo}" already exists in task "${task}"`)
  data.envs.push({ repo, agent, status: 'stopped' } satisfies EnvState)
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
  return readJson<PersistedSession[]>(sessionsFile(ws, task), [])
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
      tasks.push({
        name: task,
        envs: taskData.envs.map((e) => ({ ...e, sessions: [] }))
      })
    }
    tree.workspaces.push({ name: ws, repos: wsData.repos, tasks })
  }
  return tree
}
