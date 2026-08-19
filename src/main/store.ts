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
  PersistedSession,
  RepoConfig,
  ReviewFile,
  SessionInfo,
  SessionLogRecord,
  TaskFile,
  Tree,
  WorkspaceFile
} from '../shared/types'
import { agentDef } from '../shared/agents'
import { defaultAgentConfig } from '../shared/agentConfig'
import { validateEnvConfig } from '../shared/envConfig'
import type { NotificationPrefs } from '../shared/notifications'
import { NOTIFICATION_DEFAULTS } from '../shared/notifications'
import { createLogger } from './log'

const pexecFile = promisify(execFile)

const log = createLogger('store')

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
/** Host directory used as `--workspace-folder` by a session whose repos are
 *  bind-mounted individually — more than one repo, or a read-only role, see
 *  `usesRepoMounts` in containers.ts. Empty except for those mount points, and
 *  never the task dir itself, which also holds `task.json` / `sessions.json`.
 *  Fixed basename `repos` so the container-side default (`/workspaces/<basename>`)
 *  is predictable; the `.multirepo` segment predates read-only roles and is kept
 *  so existing sessions' containers keep pointing at the directory they were
 *  provisioned against. */
export const mountedWorkspaceDir = (ws: string, task: string, sessionId: string) =>
  path.join(gurtRoot, ws, task, '.multirepo', sessionId, 'repos')
/** Host-side file the env's materialized devcontainer config is written to. */
export const overrideConfigPath = (ws: string, env: string) =>
  path.join(gurtRoot, ws, '.devcontainers', `${env}.json`)

/** Path segments gurt itself owns inside the parent dir of each kind — a repo
 *  named `sessions` would collide with the task's session-log dir, etc.
 *  Compared case-insensitively (macOS default FS is case-insensitive). */
const RESERVED_NAMES: Record<string, string[]> = {
  workspace: ['agents.json', 'credentials.json', 'agent-config-cache.json'],
  task: ['workspace.json', '.devcontainers'],
  repo: ['task.json', 'sessions.json', 'review.json', 'sessions', '.multirepo'],
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

/** `JSON.parse`'s `SyntaxError` embeds a snippet of the offending content in
 *  `message` (Node 20+) — unsafe to log here, since a store file may hold
 *  session timeline content the log must never contain. Keep only the name,
 *  code, and — when the message happens to carry one — the numeric position. */
function jsonParseErrCtx(e: unknown): { name: string; code?: string | number; pos?: number } {
  const err = e as { name?: unknown; code?: unknown; message?: unknown }
  const message = typeof err.message === 'string' ? err.message : ''
  const pos = /position (\d+)/.exec(message)
  return {
    name: typeof err.name === 'string' ? err.name : 'Error',
    ...(typeof err.code === 'string' || typeof err.code === 'number' ? { code: err.code } : {}),
    ...(pos ? { pos: Number(pos[1]) } : {})
  }
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch (e) {
    // A missing file is the normal "nothing stored yet" path; anything else is
    // a file we are about to silently replace with the fallback — say so.
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT')
      log.warn('unreadable json — falling back to defaults', { file, err: jsonParseErrCtx(e) })
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

const notificationsFile = () => path.join(gurtRoot, 'notifications.json')

/** A missing key (fresh install, or a type added later) falls back to its
 *  default — tolerates a partial file the same way `getAgents` does. */
export async function getNotificationPrefs(): Promise<NotificationPrefs> {
  const raw = await readJson<Partial<NotificationPrefs>>(notificationsFile(), {})
  const prefs = {} as NotificationPrefs
  for (const type of Object.keys(NOTIFICATION_DEFAULTS) as (keyof NotificationPrefs)[])
    prefs[type] = { ...NOTIFICATION_DEFAULTS[type], ...raw[type] }
  return prefs
}

export async function setNotificationPrefs(prefs: NotificationPrefs): Promise<void> {
  await writeJson(notificationsFile(), prefs)
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
 * Read workspace.json, lazily migrating stale shapes once (write-back on the
 * first read that changes anything):
 * - pre-split (no `envs`, repos carrying `devcontainer`): one env per repo with
 *   the same name, seeded with the repo's devcontainer + itself as default;
 *   repos are stripped of `devcontainer`.
 * - old Dockerfile mode (`dockerfile` set, `devcontainer` blank): the env gets
 *   a synthesized `{ build: { dockerfile: 'Dockerfile' } }` devcontainer —
 *   dockerfile/dockerfilePath are kept as-is. An env with both fields blank
 *   stays as-is (now invalid; the next start throws and the editor guides).
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
  let migrated = !Array.isArray(raw.envs)
  const envs: EnvConfig[] = Array.isArray(raw.envs)
    ? raw.envs
    : legacyRepos.map((r) => ({
        name: r.name,
        devcontainer: r.devcontainer ?? '',
        repo: r.name
      }))
  for (const env of envs) {
    if (env.dockerfile && !env.devcontainer?.trim()) {
      env.devcontainer = JSON.stringify({ build: { dockerfile: 'Dockerfile' } }, null, 2)
      migrated = true
    }
  }
  const data: WorkspaceFile = { repos, envs }
  if (migrated) await saveWorkspace(ws, data)
  return data
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

/** Task names holding a clone of this repo — the work that would be destroyed. */
export async function tasksUsingRepo(ws: string, repo: string): Promise<string[]> {
  const used: string[] = []
  for (const task of await listTasks(ws))
    if ((await taskClones(ws, task)).includes(repo)) used.push(task)
  return used
}

/** Task names with a session that runs this env definition. */
export async function tasksUsingEnv(ws: string, env: string): Promise<string[]> {
  const used: string[] = []
  for (const task of await listTasks(ws)) {
    const sessions = await readJson<PersistedSession[]>(sessionsFile(ws, task), [])
    if (sessions.some((s) => s.info.env === env)) used.push(task)
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
    throw new Error(`repo "${repo}" has a clone in task(s): ${used.join(', ')} — delete those tasks first`)
  data.repos = data.repos.filter((r) => r.name !== repo)
  await saveWorkspace(ws, data)
}

// --- env definitions (workspace registry) -------------------------------

export async function addEnv(ws: string, env: EnvConfig): Promise<void> {
  validateName('env', env.name)
  const invalid = validateEnvConfig(env)
  if (invalid) throw new Error(`env "${env.name}": ${invalid}`)
  const data = await getWorkspace(ws)
  if (data.envs.some((e) => e.name === env.name))
    throw new Error(`env "${env.name}" already exists in "${ws}"`)
  data.envs.push(env)
  await saveWorkspace(ws, data)
}

/** Update an env definition. The name is immutable — it only matches an
 *  existing env; renaming is not supported. */
export async function updateEnv(ws: string, env: EnvConfig): Promise<void> {
  const invalid = validateEnvConfig(env)
  if (invalid) throw new Error(`env "${env.name}": ${invalid}`)
  const data = await getWorkspace(ws)
  const i = data.envs.findIndex((e) => e.name === env.name)
  if (i < 0) throw new Error(`env "${env.name}" not found in "${ws}"`)
  data.envs[i] = env
  await saveWorkspace(ws, data)
}

export async function removeEnv(ws: string, name: string): Promise<void> {
  const used = await tasksUsingEnv(ws, name)
  if (used.length)
    throw new Error(
      `env "${name}" is used by session(s) in task(s): ${used.join(', ')} — delete those first`
    )
  const data = await getWorkspace(ws)
  data.envs = data.envs.filter((e) => e.name !== name)
  await saveWorkspace(ws, data)
  await fs.rm(overrideConfigPath(ws, name), { force: true })
}

/** Whether the task exists: `task.json` is the fact, a bare directory is not
 *  (that is what a stray log or session write leaves behind). */
export function taskExists(ws: string, task: string): boolean {
  return existsSync(path.join(taskDir(ws, task), 'task.json'))
}

export async function createTask(ws: string, task: string): Promise<void> {
  validateName('task', task)
  if (taskExists(ws, task)) throw new Error(`task "${task}" already exists in "${ws}"`)
  await writeJson(path.join(taskDir(ws, task), 'task.json'), {} satisfies TaskFile)
}

/** Renames the task's whole directory (config, clones, session logs move with
 *  it). Caller stops the task's envs first — a running container's bind mount
 *  is pinned to the old path and would be orphaned by the move — and re-persists
 *  `sessions.json` under the new name afterwards. */
export async function renameTask(ws: string, task: string, newName: string): Promise<void> {
  validateName('task', newName)
  if (newName === task) return
  const from = taskDir(ws, task)
  if (!taskExists(ws, task)) throw new Error(`task "${task}" not found in "${ws}"`)
  const to = taskDir(ws, newName)
  if (existsSync(to)) throw new Error(`task "${newName}" already exists in "${ws}"`)
  // An append landing mid-rename would recreate the old directory and take the
  // records with it, so let the in-flight ones finish first. Their chain keys
  // are the old paths — drop them; the next append rebuilds them under the new.
  await drainAppends(from)
  await fs.rename(from, to)
}

export async function listTasks(ws: string): Promise<string[]> {
  const tasks: string[] = []
  for (const entry of await fs.readdir(wsDir(ws), { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && taskExists(ws, entry.name)) tasks.push(entry.name)
  }
  return tasks
}

/** Read task.json. Legacy `envs` entries are returned as-is; `readSessions`
 *  folds them onto their owning session and clears them from disk. */
export async function getTask(ws: string, task: string): Promise<TaskFile> {
  return readJson<TaskFile>(path.join(taskDir(ws, task), 'task.json'), {})
}

/**
 * Repos with a clone in this task, discovered on disk rather than recorded: the
 * clone directory *is* the fact. A clone outlives every session that used it
 * (it holds their uncommitted work), so nothing session-scoped may own this.
 */
export async function taskClones(ws: string, task: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await fs
    .readdir(taskDir(ws, task), { withFileTypes: true })
    .catch(() => []))
    if (entry.isDirectory() && existsSync(path.join(taskDir(ws, task), entry.name, '.git')))
      out.push(entry.name)
  return out
}

export async function saveTask(ws: string, task: string, data: TaskFile): Promise<void> {
  await writeJson(path.join(taskDir(ws, task), 'task.json'), data)
}

export async function removeTaskDir(ws: string, task: string): Promise<void> {
  // Same reason as the rename: an append that lands after the tree is gone
  // recreates the directory (`appendSessionLog` mkdir -p's its way back in),
  // leaving a task dir with logs and no `task.json` — invisible in the tree.
  const dir = taskDir(ws, task)
  await drainAppends(dir)
  await rmTree(dir)
}

/** Remove the whole workspace directory — every task, clone and session log
 *  with it. Same append-drain reasoning as `removeTaskDir`, scaled to the
 *  workspace root (which is every task's parent, so one drain covers them all). */
export async function removeWorkspaceDir(ws: string): Promise<void> {
  const dir = wsDir(ws)
  await drainAppends(dir)
  await rmTree(dir)
}

const sessionsFile = (ws: string, task: string) => path.join(taskDir(ws, task), 'sessions.json')

export async function readSessions(ws: string, task: string): Promise<PersistedSession[]> {
  const records = await readJson<PersistedSession[]>(sessionsFile(ws, task), [])
  let migrated = false
  // Containers used to be tracked per env in task.json, one slot reused by
  // successive sessions. Hand each record to the session that owned it — that
  // binding already existed as `EnvState.session`, it was just stored on the
  // wrong entity. A record whose owner is gone describes a container no session
  // can claim; it is dropped here and reaped by the boot reconcile.
  const legacy = (await getTask(ws, task)).envs
  if (legacy?.length) {
    for (const e of legacy) {
      const owner = e.session ? records.find((r) => r.info.id === e.session) : undefined
      if (!owner || owner.info.container) continue
      owner.info.container = {
        status: e.status,
        id: e.containerId,
        remoteWorkspaceFolder: e.remoteWorkspaceFolder,
        repos: e.repo ? [e.repo] : [],
        error: e.error
      }
    }
    await saveTask(ws, task, {})
    migrated = true
  }
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
      info.repos = [fused]
    }
    if (legacyKey in info) {
      delete info[legacyKey]
      migrated = true
    }
    // Pre-multirepo records carried a single `repo?: string` field; fold it
    // into the now-plural `repos`.
    if (!Array.isArray(info.repos)) {
      const legacyRepo = info.repo as string | undefined
      info.repos = legacyRepo ? [legacyRepo] : []
      delete info.repo
      migrated = true
    }
    // Pre-roles records inferred the role from the repo count: more than one
    // repo was a read-only discovery session, anything else a read-write
    // worker. Write the same fold `sessionRole` applies in memory to disk once,
    // so the role stops being derived from repo count anywhere.
    if (!r.info.role) {
      r.info.role = r.info.repos.length > 1 ? 'researcher' : 'executor'
      migrated = true
    }
    if (!r.info.state) r.info.state = 'started'
    if (r.info.startPrompt == null) r.info.startPrompt = ''
    // `starting` is runtime-only; a crash mid-start restores as draft.
    if (r.info.state === 'starting') {
      r.info.state = 'draft'
      r.info.queuedAt = undefined
    }
    // Same for the container's provisioning phases (and the legacy `starting`):
    // nothing is building any more, so the record restores as stopped and the
    // boot reconcile decides from Docker whether it is actually up.
    const c = r.info.container as (SessionInfo['container'] & Record<string, unknown>) | undefined
    if (c) {
      if (!Array.isArray(c.repos)) {
        const legacyContainerRepo = c.repo as string | undefined
        c.repos = legacyContainerRepo ? [legacyContainerRepo] : []
        delete c.repo
        migrated = true
      }
      if (c.status !== 'running' && c.status !== 'error') c.status = 'stopped'
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

// --- manual review state: <ws>/<task>/review.json ---------------------------

const reviewFile = (ws: string, task: string) => path.join(taskDir(ws, task), 'review.json')

/** Read review.json, tolerating a partial or hand-edited file the way
 *  `getNotificationPrefs` does — a missing half is an empty one, never a throw. */
export async function readReview(ws: string, task: string): Promise<ReviewFile> {
  const raw = await readJson<Partial<ReviewFile>>(reviewFile(ws, task), {})
  return {
    locked: raw.locked && typeof raw.locked === 'object' ? raw.locked : {},
    comments: Array.isArray(raw.comments) ? raw.comments : []
  }
}

export async function writeReview(ws: string, task: string, data: ReviewFile): Promise<void> {
  await writeJson(reviewFile(ws, task), data)
}

/** Every task that has a review.json, as `[ws, task]` pairs — the boot scan
 *  that seeds the in-memory lock set (see review.ts). */
export async function tasksWithReview(): Promise<[string, string][]> {
  const out: [string, string][] = []
  for (const ws of await listWorkspaces())
    for (const task of await listTasks(ws))
      if (existsSync(reviewFile(ws, task))) out.push([ws, task])
  return out
}

// --- per-session append-only log: <ws>/<task>/sessions/<sessionId>.jsonl ----

const sessionLogFile = (ws: string, task: string, sessionId: string) =>
  path.join(taskDir(ws, task), 'sessions', `${sessionId}.jsonl`)

/** Per-file append chain, so overlapping flushes never interleave lines. */
const appendChains = new Map<string, Promise<void>>()

/** Let every in-flight append under `dir` settle, then forget its chain — the
 *  caller is about to move or remove that directory out from under them. */
async function drainAppends(dir: string): Promise<void> {
  const prefix = dir + path.sep
  for (const [file, chain] of appendChains) {
    if (!file.startsWith(prefix)) continue
    await chain
    appendChains.delete(file)
  }
}

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
    for (const task of await listTasks(ws))
      tasks.push({ name: task, repos: await taskClones(ws, task), sessions: [] })
    tree.workspaces.push({ name: ws, repos: wsData.repos, envs: wsData.envs, tasks })
  }
  return tree
}
