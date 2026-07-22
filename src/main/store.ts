import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import type {
  AgentConfig,
  AgentConfigCache,
  AgentsFile,
  EnvConfig,
  EnvState,
  PersistedSession,
  RepoConfig,
  SessionInfo,
  SessionLogRecord,
  TaskFile,
  Tree,
  WorkspaceFile
} from '../shared/types'
import { agentDef } from '../shared/agents'
import { defaultAgentConfig } from '../shared/agentConfig'

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
/** Host-side dir for an env's user-provided inline devcontainer config. */
export const overrideConfigPath = (ws: string, env: string) =>
  path.join(gurtRoot, ws, '.devcontainers', `${env}.json`)

/** Path segments gurt itself owns inside the parent dir of each kind — a repo
 *  named `sessions` would collide with the task's session-log dir, etc.
 *  Compared case-insensitively (macOS default FS is case-insensitive). */
const RESERVED_NAMES: Record<string, string[]> = {
  workspace: ['agents.json', 'credentials.json', 'agent-config-cache.json'],
  task: ['workspace.json', '.devcontainers'],
  repo: ['task.json', 'sessions.json', 'sessions'],
  // Env names only ever become `.devcontainers/<env>.json` — segment rules only.
  env: []
}

/** Names become path segments on disk, so reject anything that isn't a single, safe segment. */
function validateName(kind: string, name: string): void {
  const n = name.trim()
  if (!n) throw new Error(`${kind} name must not be empty`)
  if (n === '.' || n === '..' || /[/\\]/.test(n))
    throw new Error(`${kind} name must not contain "/", "\\", "." or ".."`)
  if (RESERVED_NAMES[kind]?.includes(n.toLowerCase()))
    throw new Error(`"${n}" is reserved — pick another ${kind} name`)
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
    // Current format is an instance carrying its own kind; the legacy per-kind
    // format keyed each entry by the kind id and is lifted the same way. Inline
    // secrets and the `enabled` flag are dropped here — the on-disk migration
    // (migrateAgentSecrets) moves secrets into credentials before this runs.
    const kind = typeof a.kind === 'string' ? a.kind : agentDef(id) ? id : undefined
    if (!kind) continue
    agents[id] = {
      kind,
      label: a.label || agentDef(kind)?.label || kind,
      credentialId: typeof a.credentialId === 'string' ? a.credentialId : undefined,
      secretEnv: a.secretEnv || undefined,
      env: a.env && typeof a.env === 'object' ? a.env : undefined
    }
  }
  return agents
}

export async function setAgents(agents: AgentsFile): Promise<void> {
  await writeJson(agentsFile(), agents)
}

const agentConfigFile = () => path.join(gurtRoot, 'agent-config-cache.json')

/** The whole per-agent config cache (empty object when the file is absent). */
export async function getAgentConfigs(): Promise<AgentConfigCache> {
  return readJson<AgentConfigCache>(agentConfigFile(), {})
}

/**
 * Cached config for one agent instance, or its kind's hardcoded default when the
 * cache has no entry yet. Pure read: the default is NOT written back — it stays
 * deterministic in code, so improving `defaultAgentConfig` reaches every
 * not-yet-run agent immediately instead of being shadowed by a stale on-disk
 * seed. The cache file only ever holds configs a live session actually reported.
 */
export async function getAgentConfig(agentId: string): Promise<AgentConfig> {
  const cache = await getAgentConfigs()
  const hit = cache[agentId]
  if (hit) return hit
  const agents = await getAgents()
  return defaultAgentConfig(agents[agentId]?.kind ?? agentId)
}

export async function setAgentConfig(agentId: string, cfg: AgentConfig): Promise<void> {
  const cache = await getAgentConfigs()
  cache[agentId] = cfg
  await writeJson(agentConfigFile(), cache)
}

export async function createWorkspace(name: string): Promise<void> {
  validateName('workspace', name)
  const file = path.join(wsDir(name), 'workspace.json')
  if (existsSync(file)) throw new Error(`workspace "${name}" already exists`)
  await writeJson(file, { repos: [], envs: [] } satisfies WorkspaceFile)
}

/** A pre-split RepoConfig carried an inline `devcontainer`; it moves to the env. */
type LegacyRepo = RepoConfig & { devcontainer?: string }

/**
 * Read workspace.json, lazily migrating the pre-split shape (no `envs`, repos
 * carrying `devcontainer`) once: one env per repo with the same name, seeded
 * with the repo's devcontainer + itself as default; repos are stripped of
 * `devcontainer`. The write-back happens only on that first read.
 */
export async function getWorkspace(ws: string): Promise<WorkspaceFile> {
  const file = path.join(wsDir(ws), 'workspace.json')
  const raw = await readJson<Partial<WorkspaceFile> | null>(file, null)
  if (!raw) return { repos: [], envs: [] }
  const legacyRepos = (raw.repos ?? []) as LegacyRepo[]
  const repos: RepoConfig[] = legacyRepos.map(({ name, url, credentialId }) => ({
    name,
    url,
    ...(credentialId ? { credentialId } : {})
  }))
  if (Array.isArray(raw.envs)) return { repos, envs: raw.envs }
  const envs: EnvConfig[] = legacyRepos.map((r) => ({
    name: r.name,
    devcontainer: r.devcontainer ?? '',
    repo: r.name
  }))
  const migrated: WorkspaceFile = { repos, envs }
  await saveWorkspace(ws, migrated)
  return migrated
}

/** Names of every workspace on disk (a dir under gurtRoot with a workspace.json). */
export async function listWorkspaces(): Promise<string[]> {
  const out: string[] = []
  for (const entry of await fs.readdir(gurtRoot, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && existsSync(path.join(wsDir(entry.name), 'workspace.json')))
      out.push(entry.name)
  }
  return out
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

/** Task names holding a live clone of this repo (a `<task>/<repo>/.git` on disk).
 *  Disk-based, not record-based: instance records are per-session and released
 *  with their session, while the clone (and any uncommitted work) stays. */
export async function tasksUsingRepo(ws: string, repo: string): Promise<string[]> {
  const used: string[] = []
  for (const task of await listTasks(ws))
    if (existsSync(path.join(cloneDir(ws, task, repo), '.git'))) used.push(task)
  return used
}

/** Repo clones of a task present on disk (any task-dir subdirectory with a .git). */
export async function taskCloneRepos(ws: string, task: string): Promise<string[]> {
  const dir = taskDir(ws, task)
  const out: string[] = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
    if (entry.isDirectory() && existsSync(path.join(dir, entry.name, '.git'))) out.push(entry.name)
  return out
}

/** Task names using this env definition — an instance record of it, or a
 *  session that runs on it (sessions outlive their instances). */
export async function tasksUsingEnv(ws: string, env: string): Promise<string[]> {
  const used: string[] = []
  for (const task of await listTasks(ws)) {
    const data = await getTask(ws, task)
    if (
      data.envs.some((e) => e.env === env) ||
      (await readSessions(ws, task)).some((r) => r.info.env === env)
    )
      used.push(task)
  }
  return used
}

export async function removeRepo(ws: string, repo: string): Promise<void> {
  const data = await getWorkspace(ws)
  const defaultOf = data.envs.filter((e) => e.repo === repo).map((e) => e.name)
  if (defaultOf.length)
    throw new Error(
      `repo "${repo}" is the default of env(s): ${defaultOf.join(', ')} — change those first`
    )
  const used = await tasksUsingRepo(ws, repo)
  if (used.length)
    throw new Error(`repo "${repo}" has a clone in task(s): ${used.join(', ')} — delete those envs first`)
  data.repos = data.repos.filter((r) => r.name !== repo)
  await saveWorkspace(ws, data)
}

// --- env definitions (workspace registry) -------------------------------

export async function addEnv(ws: string, env: EnvConfig): Promise<void> {
  validateName('env', env.name)
  const data = await getWorkspace(ws)
  if (data.envs.some((e) => e.name === env.name))
    throw new Error(`env "${env.name}" already exists in "${ws}"`)
  data.envs.push(env)
  await saveWorkspace(ws, data)
}

/** Update an env definition. The name is immutable — it only matches an
 *  existing env; renaming is not supported. */
export async function updateEnv(ws: string, env: EnvConfig): Promise<void> {
  const data = await getWorkspace(ws)
  const i = data.envs.findIndex((e) => e.name === env.name)
  if (i < 0) throw new Error(`env "${env.name}" not found in "${ws}"`)
  data.envs[i] = env
  await saveWorkspace(ws, data)
}

export async function removeEnv(ws: string, name: string): Promise<void> {
  const used = await tasksUsingEnv(ws, name)
  if (used.length)
    throw new Error(`env "${name}" is used by task(s): ${used.join(', ')} — delete those envs first`)
  const data = await getWorkspace(ws)
  data.envs = data.envs.filter((e) => e.name !== name)
  await saveWorkspace(ws, data)
  await fs.rm(overrideConfigPath(ws, name), { force: true })
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

/** Read task.json, shedding pre-per-session records once: instances are now
 *  keyed by their owning session (stamped when the record is created for a
 *  concrete session), so an entry without a `session` belongs to no session
 *  and cannot be addressed — drop it. Such entries never carry a container
 *  (the session was stamped at `up` in every model that created one). */
export async function getTask(ws: string, task: string): Promise<TaskFile> {
  const file = path.join(taskDir(ws, task), 'task.json')
  const data = await readJson<TaskFile>(file, { envs: [] })
  const kept = data.envs.filter((e) => typeof e.session === 'string' && e.session)
  if (kept.length !== data.envs.length) {
    data.envs = kept
    await saveTask(ws, task, data)
  }
  return data
}

export async function saveTask(ws: string, task: string, data: TaskFile): Promise<void> {
  await writeJson(path.join(taskDir(ws, task), 'task.json'), data)
}

export async function removeTaskDir(ws: string, task: string): Promise<void> {
  await rmTree(taskDir(ws, task))
}

/** Ensure a (stopped) env instance record exists for `session`; idempotent.
 *  `env` is adopted on an existing record too — a re-pointed draft may reuse
 *  the record its failed start left behind. */
export async function ensureTaskEnv(
  ws: string,
  task: string,
  env: string,
  session: string
): Promise<void> {
  const data = await getTask(ws, task)
  const inst = data.envs.find((e) => e.session === session)
  if (inst) {
    if (inst.env === env) return
    inst.env = env
  } else {
    data.envs.push({ session, env, status: 'stopped' } satisfies EnvState)
  }
  await saveTask(ws, task, data)
}

export async function removeTaskEnv(ws: string, task: string, session: string): Promise<void> {
  const data = await getTask(ws, task)
  data.envs = data.envs.filter((e) => e.session !== session)
  await saveTask(ws, task, data)
}

export async function updateTaskEnv(
  ws: string,
  task: string,
  session: string,
  patch: Partial<EnvState>
): Promise<void> {
  const data = await getTask(ws, task)
  const inst = data.envs.find((e) => e.session === session)
  if (!inst) throw new Error(`no env instance for session "${session}" in task "${task}"`)
  Object.assign(inst, patch)
  await saveTask(ws, task, data)
}

const sessionsFile = (ws: string, task: string) => path.join(taskDir(ws, task), 'sessions.json')

export async function readSessions(ws: string, task: string): Promise<PersistedSession[]> {
  const records = await readJson<PersistedSession[]>(sessionsFile(ws, task), [])
  let migrated = false
  // Migration: pre-queue records have no state — treat them as started.
  for (const r of records) {
    // Pre-split records fused the env and repo into one field; a migrated session
    // gets both. The legacy key is read/dropped by name so the live model carries
    // no reference to it (assembled to keep that identifier out of the source).
    const legacyKey = 'env' + 'Repo'
    const info = r.info as SessionInfo & Record<string, unknown>
    const fused = info[legacyKey]
    if (info.env === undefined && typeof fused === 'string') {
      info.env = fused
      info.repo = fused
    }
    if (legacyKey in info) {
      delete info[legacyKey]
      migrated = true
    }
    if (!r.info.state) r.info.state = 'started'
    if (r.info.startPrompt == null) r.info.startPrompt = ''
    // `starting` is runtime-only; a crash mid-start restores as draft.
    if (r.info.state === 'starting') {
      r.info.state = 'draft'
      r.info.queuedAt = undefined
    }
  }
  // Write the env/repo split back once, so the legacy key leaves the disk too.
  if (migrated) await writeSessions(ws, task, records)
  return records
}

export async function writeSessions(
  ws: string,
  task: string,
  records: PersistedSession[]
): Promise<void> {
  await writeJson(sessionsFile(ws, task), records)
}

// --- per-session append-only log: <ws>/<task>/sessions/<sessionId>.jsonl ----

const sessionLogFile = (ws: string, task: string, sessionId: string) =>
  path.join(taskDir(ws, task), 'sessions', `${sessionId}.jsonl`)

/** Per-file append chain, so overlapping flushes never interleave lines. */
const appendChains = new Map<string, Promise<void>>()

/** Append records as JSONL lines. The file is only ever appended to, never rewritten. */
export function appendSessionLog(
  ws: string,
  task: string,
  sessionId: string,
  records: SessionLogRecord[]
): Promise<void> {
  const file = sessionLogFile(ws, task, sessionId)
  const prev = appendChains.get(file) ?? Promise.resolve()
  const next = prev.then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.appendFile(file, records.map((r) => JSON.stringify(r) + '\n').join(''))
  })
  // Keep the chain alive past a failed link; the caller sees the rejection.
  appendChains.set(
    file,
    next.catch(() => {})
  )
  return next
}

/** Read a session's log; a missing file is an empty log, torn lines are skipped. */
export async function readSessionLog(
  ws: string,
  task: string,
  sessionId: string
): Promise<SessionLogRecord[]> {
  const raw = await fs.readFile(sessionLogFile(ws, task, sessionId), 'utf8').catch(() => '')
  const out: SessionLogRecord[] = []
  let lastSeq = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line) as SessionLogRecord
      // seq is strictly increasing; a batch retried after a partial write can
      // re-append records already on disk — skip anything non-advancing.
      if (typeof rec.seq !== 'number' || rec.seq <= lastSeq) continue
      lastSeq = rec.seq
      out.push(rec)
    } catch {
      // a torn trailing line from a crash mid-append — drop it
    }
  }
  return out
}

export async function deleteSessionLog(ws: string, task: string, sessionId: string): Promise<void> {
  const file = sessionLogFile(ws, task, sessionId)
  // Let an in-flight append settle first so it can't recreate the file after
  // the rm. The stored chain never rejects.
  await appendChains.get(file)
  appendChains.delete(file)
  await fs.rm(file, { force: true })
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
        envs: taskData.envs.map((e) => ({
          session: e.session,
          env: e.env,
          repo: e.repo,
          containerId: e.containerId,
          remoteWorkspaceFolder: e.remoteWorkspaceFolder,
          status: e.status,
          error: e.error
        })),
        sessions: []
      })
    }
    tree.workspaces.push({ name: ws, repos: wsData.repos, envs: wsData.envs, tasks })
  }
  return tree
}
