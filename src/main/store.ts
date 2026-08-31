import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type {
  AgentConfig,
  AgentConfigCache,
  AgentInstance,
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
import type { McpRegistryEntry } from '../shared/mcp'
import { agentDef } from '../shared/agents'
import { defaultAgentConfig } from '../shared/agentConfig'
import { validateEnvConfig } from '../shared/envConfig'
import { normalizeMcpEntry, validateMcpEntry } from '../shared/mcp'
import type { SkillEntry } from '../shared/skills'
import {
  SKILL_FILE,
  skillEntries,
  skillNameProblem,
  skillNames,
  validateSkillDoc
} from '../shared/skills'
import type { NotificationPrefs } from '../shared/notifications'
import type { TurnRecord } from '../shared/usage'
import { NOTIFICATION_DEFAULTS } from '../shared/notifications'
import type { HotkeyMap } from '../shared/hotkeys'
import { HOTKEY_DEFAULTS, sanitizeHotkeys } from '../shared/hotkeys'
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

export const gurtRoot = process.env['GURT_ROOT'] || path.join(os.homedir(), '.gurt')

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
  path.join(sessionScratchDir(ws, task, sessionId), 'repos')
/** Host-side file the env's materialized devcontainer config is written to. */
export const overrideConfigPath = (ws: string, env: string) =>
  path.join(gurtRoot, ws, '.devcontainers', `${env}.json`)

/** The workspace's skill registry: one directory per skill, each holding a
 *  `SKILL.md` and whatever supporting files it references
 *  (docs/requirements-skills.md §4.1). A sibling of `workspace.json` — the
 *  registry is workspace data, like repos and envs. */
export const skillsDir = (ws: string) => path.join(gurtRoot, ws, 'skills')
export const skillDir = (ws: string, name: string) => path.join(skillsDir(ws), name)

/** Per-session scratch: everything gurt stages for one session's container and
 *  nothing else, removed with the session (`deleteSessionScratch`). Holds the
 *  wrapper workspace dir, the merged devcontainer config, and the materialized
 *  skills. The `.multirepo` segment predates all three and is kept so existing
 *  sessions' containers keep pointing at the paths they were provisioned
 *  against. */
export const sessionScratchDir = (ws: string, task: string, sessionId: string) =>
  path.join(gurtRoot, ws, task, '.multirepo', sessionId)

/** Where a session's selected skills are copied before its container comes up,
 *  and the source of the read-only bind that delivers them
 *  (docs/requirements-skills.md §5). */
export const sessionSkillsDir = (ws: string, task: string, sessionId: string) =>
  path.join(sessionScratchDir(ws, task, sessionId), 'skills')

/** Path segments gurt itself owns inside the parent dir of each kind — a repo
 *  named `sessions` would collide with the task's session-log dir, etc.
 *  Compared case-insensitively (macOS default FS is case-insensitive). */
const RESERVED_NAMES: Record<string, string[]> = {
  workspace: ['agents.json', 'credentials.json', 'agent-config-cache.json'],
  task: ['workspace.json', '.devcontainers', 'skills'],
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

let degraded = false

/** True when a store file failed to parse this run and was quarantined. Boot
 *  paths that delete things on "nothing is known" must not run on that. */
export const storeDegraded = (): boolean => degraded

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch (e) {
    // A missing file is the normal "nothing stored yet" path. Anything else is
    // a file we are about to shadow with defaults: move it aside first, so the
    // next write cannot make the loss permanent and the bytes stay for recovery.
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return fallback
    degraded = true
    const quarantine = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
    try {
      await fs.rename(file, quarantine)
    } catch {
      // Quarantine is best-effort; the degraded flag is what gates the damage.
    }
    log.error('unreadable json — quarantined, using defaults', {
      file,
      quarantine,
      err: jsonParseErrCtx(e)
    })
    return fallback
  }
}

/** Per-file write chain, so overlapping writes never race on the temp file. */
const writeChains = new Map<string, Promise<void>>()

/**
 * Write JSON durably: a complete temp file, fsync'd, renamed over the target
 * (atomic on POSIX), then the directory fsync'd so the rename itself survives a
 * power loss. `fs.writeFile` truncates in place and never fsyncs — a crash
 * between the truncate and the flush leaves a 0-byte file, which is how one
 * task lost every session record on 2026-08-27.
 */
function writeJson(file: string, data: unknown): Promise<void> {
  const prev = writeChains.get(file) ?? Promise.resolve()
  const next = prev.then(async () => {
    const dir = path.dirname(file)
    await fs.mkdir(dir, { recursive: true })
    const tmp = path.join(dir, `.${path.basename(file)}.tmp`)
    const fh = await fs.open(tmp, 'w')
    try {
      await fh.writeFile(JSON.stringify(data, null, 2) + '\n')
      await fh.sync()
    } finally {
      await fh.close()
    }
    await fs.rename(tmp, file)
    if (process.platform !== 'win32') {
      const dh = await fs.open(dir, 'r')
      try {
        await dh.sync()
      } finally {
        await dh.close()
      }
    }
  })
  writeChains.set(
    file,
    next.catch(() => {})
  )
  return next
}

const agentsFile = () => path.join(gurtRoot, 'agents.json')

/**
 * One record of agents.json as it may actually be on disk. This file is written
 * by older gurt versions and hand-edited by users, so nothing here is trusted:
 * every field is optional, and one whose type is wrong degrades to "absent"
 * rather than costing the whole record. `secret`/`oauthToken`/`enabled` are the
 * pre-credentials layout, lifted by `migrateAgentSecrets` and dropped here.
 */
export const STORED_AGENT = z.looseObject({
  kind: z.string().optional().catch(undefined),
  label: z.string().optional().catch(undefined),
  credentialId: z.string().optional().catch(undefined),
  secretEnv: z.string().optional().catch(undefined),
  env: z.record(z.string(), z.string()).optional().catch(undefined),
  secret: z.string().optional().catch(undefined),
  oauthToken: z.string().optional().catch(undefined),
  enabled: z.boolean().optional().catch(undefined)
})
export type StoredAgent = z.infer<typeof STORED_AGENT>

/** agents.json itself: an id → record map. Records stay `unknown` so one bad
 *  entry is skipped instead of emptying the registry. */
export const STORED_AGENTS = z.record(z.string(), z.unknown()).catch({})

/**
 * One `workspace.json` MCP registry entry as it may actually be on disk —
 * hand-edited, like agents.json, so nothing is trusted. A malformed field
 * degrades to "absent" (`.catch`) and an entry missing what its kind requires
 * is dropped by `liftMcpServers` rather than emptying the registry.
 *
 * One schema per kind, dispatched on `kind` by hand rather than through a zod
 * discriminated union, because the discriminant is *optional*: a record with no
 * `kind` is an http entry written before the local kinds existed, and reading
 * those unchanged is the whole compatibility promise
 * (docs/requirements-mcp-stdio.md §3.1).
 */
const STORED_MCP_COMMON = {
  id: z.string(),
  label: z.string().optional().catch(undefined),
  credentialId: z.string().optional().catch(undefined)
}

const STORED_MCP_HTTP = z.looseObject({
  ...STORED_MCP_COMMON,
  kind: z.literal('http').optional().catch(undefined),
  url: z.string(),
  headers: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .optional()
    .catch(undefined)
})

/** The fields the two local kinds share. `env` degrades as a whole: a single
 *  non-string value makes the map unreadable, and half an environment is worse
 *  than none. */
const STORED_MCP_LOCAL = {
  ...STORED_MCP_COMMON,
  args: z.array(z.string()).optional().catch(undefined),
  env: z.record(z.string(), z.string()).optional().catch(undefined),
  credentialEnvVar: z.string().optional().catch(undefined)
}

const STORED_MCP_NPM = z.looseObject({
  ...STORED_MCP_LOCAL,
  kind: z.literal('npm'),
  package: z.string(),
  version: z.string().optional().catch(undefined)
})

const STORED_MCP_COMMAND = z.looseObject({
  ...STORED_MCP_LOCAL,
  kind: z.literal('command'),
  command: z.string(),
  cwd: z.string().optional().catch(undefined)
})

/** The `mcpServers` array itself: entries stay `unknown` so one bad record is
 *  skipped, and a non-array (or absent) field reads as "no registry". */
const STORED_MCP_SERVERS = z.array(z.unknown()).catch([])

/** Lift one stored record, or nothing when it is not a readable entry of any
 *  kind. An unknown `kind` is dropped rather than read as http: a record whose
 *  transport this build does not understand must not be spawned or called. */
function liftMcpServer(record: unknown): McpRegistryEntry | undefined {
  const kind = (record as { kind?: unknown } | null)?.kind ?? 'http'
  if (kind === 'npm') {
    const parsed = STORED_MCP_NPM.safeParse(record)
    if (!parsed.success || !parsed.data.package) return undefined
    return normalizeMcpEntry(parsed.data)
  }
  if (kind === 'command') {
    const parsed = STORED_MCP_COMMAND.safeParse(record)
    if (!parsed.success || !parsed.data.command) return undefined
    return normalizeMcpEntry(parsed.data)
  }
  if (kind !== 'http') return undefined
  const parsed = STORED_MCP_HTTP.safeParse(record)
  if (!parsed.success || !parsed.data.url) return undefined
  return normalizeMcpEntry(parsed.data)
}

/** Lift the stored array into entries, dropping records that are not one. */
function liftMcpServers(raw: unknown): McpRegistryEntry[] {
  const out: McpRegistryEntry[] = []
  const seen = new Set<string>()
  for (const record of STORED_MCP_SERVERS.parse(raw)) {
    const entry = liftMcpServer(record)
    // A duplicate id would make `mcpServers` ambiguous for every consumer; the
    // first one wins, exactly as `mcpEntries` resolves it.
    if (!entry || !entry.id || seen.has(entry.id)) continue
    seen.add(entry.id)
    out.push(entry)
  }
  return out
}

/**
 * Lift one stored record into an agent instance, or nothing when it is not one.
 * Current format carries its own `kind`; the legacy per-kind format keyed each
 * entry by the kind id, which is the fallback. Shared with the credential
 * migration so both readers agree on what a record means.
 */
export function liftAgent(id: string, raw: unknown): { data: StoredAgent; instance: AgentInstance } | undefined {
  const parsed = STORED_AGENT.safeParse(raw)
  if (!parsed.success) return undefined
  const a = parsed.data
  const kind = a.kind ?? (agentDef(id) ? id : undefined)
  if (!kind) return undefined
  return {
    data: a,
    instance: {
      kind,
      label: a.label || agentDef(kind)?.label || kind,
      ...(a.credentialId ? { credentialId: a.credentialId } : {}),
      ...(a.secretEnv ? { secretEnv: a.secretEnv } : {}),
      ...(a.env ? { env: a.env } : {})
    }
  }
}

export async function getAgents(): Promise<AgentsFile> {
  const raw = STORED_AGENTS.parse(await readJson<unknown>(agentsFile(), {}))
  const agents: AgentsFile = {}
  for (const [id, a] of Object.entries(raw)) {
    // Inline secrets and the `enabled` flag are dropped here — the on-disk
    // migration (migrateAgentSecrets) moves secrets into credentials before
    // this runs.
    const lifted = liftAgent(id, a)
    if (lifted) agents[id] = lifted.instance
  }
  return agents
}

export async function setAgents(agents: AgentsFile): Promise<void> {
  await writeJson(agentsFile(), agents)
}

/** Per-key promise chain for read-modify-write cycles on one JSON file — two
 *  overlapping mutations would otherwise both read, then last-write-wins away
 *  one of them. Same shape as review.ts's `edit()`. */
const rmwChains = new Map<string, Promise<unknown>>()

function chained<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = Promise.resolve(rmwChains.get(key))
    .catch(() => {})
    .then(fn)
  rmwChains.set(
    key,
    next.catch(() => {})
  )
  return next
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

export function setAgentConfig(agentId: string, cfg: AgentConfig): Promise<void> {
  // Serialized: two sessions starting at once each cache their own agent's
  // config, and unchained read-modify-writes would drop one of the entries.
  return chained('agent-config', async () => {
    const cache = await getAgentConfigs()
    cache[agentId] = cfg
    await writeJson(agentConfigFile(), cache)
  })
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

const hotkeysFile = () => path.join(gurtRoot, 'hotkeys.json')

/** A missing/partial file (fresh install, or an action added later) falls
 *  back per-action to the built-in default, the same tolerance as
 *  `getNotificationPrefs`. */
export async function getHotkeys(): Promise<HotkeyMap> {
  const raw = await readJson<Partial<HotkeyMap>>(hotkeysFile(), {})
  return sanitizeHotkeys(raw, HOTKEY_DEFAULTS)
}

export async function setHotkeys(map: HotkeyMap): Promise<void> {
  await writeJson(hotkeysFile(), map)
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
  // Absent stays absent: an untouched workspace.json is not rewritten with an
  // empty array just because it was read (§3.1 — `getWorkspace` stays tolerant).
  const mcpServers = raw.mcpServers === undefined ? undefined : liftMcpServers(raw.mcpServers)
  // Hand-edited like everything else here: a wrong-typed value degrades to
  // "absent" rather than throwing.
  const defaultAgent = typeof raw.defaultAgent === 'string' ? raw.defaultAgent : undefined
  const deniedAgents = Array.isArray(raw.deniedAgents)
    ? raw.deniedAgents.filter((a): a is string => typeof a === 'string')
    : undefined
  const defaultSkills = Array.isArray(raw.defaultSkills)
    ? raw.defaultSkills.filter((n): n is string => typeof n === 'string')
    : undefined
  const data: WorkspaceFile = {
    repos,
    envs,
    ...(mcpServers ? { mcpServers } : {}),
    ...(defaultAgent ? { defaultAgent } : {}),
    ...(deniedAgents?.length ? { deniedAgents } : {}),
    ...(defaultSkills?.length ? { defaultSkills } : {})
  }
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

/** Serialize one workspace.json read-modify-write against its siblings — every
 *  mutator below goes through this, so concurrent IPC calls cannot lose each
 *  other's edits. Reads (`getWorkspace`) stay unchained. */
function editWorkspace<T>(ws: string, fn: () => Promise<T>): Promise<T> {
  return chained(`workspace:${ws}`, fn)
}

export function addRepo(ws: string, repo: RepoConfig): Promise<void> {
  return editWorkspace(ws, async () => {
    validateName('repo', repo.name)
    const data = await getWorkspace(ws)
    if (data.repos.some((r) => r.name === repo.name))
      throw new Error(`repo "${repo.name}" already exists in "${ws}"`)
    data.repos.push(repo)
    await saveWorkspace(ws, data)
  })
}

export function updateRepo(ws: string, repo: RepoConfig): Promise<void> {
  return editWorkspace(ws, async () => {
    const data = await getWorkspace(ws)
    const i = data.repos.findIndex((r) => r.name === repo.name)
    if (i < 0) throw new Error(`repo "${repo.name}" not found in "${ws}"`)
    data.repos[i] = repo
    await saveWorkspace(ws, data)
  })
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

/**
 * Env definitions that name this repo as their default (`EnvConfig.repo`) — the
 * reverse of the only link the registry stores, since an env points at a repo
 * and never the other way round. Two readers, one rule: deleting a repo an env
 * still claims is refused here, and `create_session` resolves a drafted
 * session's container through it (sessions.ts `resolveDraftEnv`).
 */
export const envsDefaultingToRepo = (data: WorkspaceFile, repo: string): string[] =>
  data.envs.filter((e) => e.repo === repo).map((e) => e.name)

export function removeRepo(ws: string, repo: string): Promise<void> {
  return editWorkspace(ws, async () => {
    const data = await getWorkspace(ws)
    const defaultOf = envsDefaultingToRepo(data, repo)
    if (defaultOf.length)
      throw new Error(
        `repo "${repo}" is the default of env(s): ${defaultOf.join(', ')} — change those first`
      )
    const used = await tasksUsingRepo(ws, repo)
    if (used.length)
      throw new Error(`repo "${repo}" has a clone in task(s): ${used.join(', ')} — delete those tasks first`)
    data.repos = data.repos.filter((r) => r.name !== repo)
    await saveWorkspace(ws, data)
  })
}

// --- env definitions (workspace registry) -------------------------------

export function addEnv(ws: string, env: EnvConfig): Promise<void> {
  return editWorkspace(ws, async () => {
    validateName('env', env.name)
    const invalid = validateEnvConfig(env)
    if (invalid) throw new Error(`env "${env.name}": ${invalid}`)
    const data = await getWorkspace(ws)
    if (data.envs.some((e) => e.name === env.name))
      throw new Error(`env "${env.name}" already exists in "${ws}"`)
    data.envs.push(env)
    await saveWorkspace(ws, data)
  })
}

/** Update an env definition. The name is immutable — it only matches an
 *  existing env; renaming is not supported. */
export function updateEnv(ws: string, env: EnvConfig): Promise<void> {
  return editWorkspace(ws, async () => {
    const invalid = validateEnvConfig(env)
    if (invalid) throw new Error(`env "${env.name}": ${invalid}`)
    const data = await getWorkspace(ws)
    const i = data.envs.findIndex((e) => e.name === env.name)
    if (i < 0) throw new Error(`env "${env.name}" not found in "${ws}"`)
    data.envs[i] = env
    await saveWorkspace(ws, data)
  })
}

export function removeEnv(ws: string, name: string): Promise<void> {
  return editWorkspace(ws, async () => {
    const used = await tasksUsingEnv(ws, name)
    if (used.length)
      throw new Error(
        `env "${name}" is used by session(s) in task(s): ${used.join(', ')} — delete those first`
      )
    const data = await getWorkspace(ws)
    data.envs = data.envs.filter((e) => e.name !== name)
    await saveWorkspace(ws, data)
    await fs.rm(overrideConfigPath(ws, name), { force: true })
  })
}

// --- per-workspace agent policy: default agent + deny-list -----------------

/** Set (or clear, passing `undefined`) the workspace's default agent — used to
 *  resolve a session created here without an explicit `agent` (sessions.ts
 *  `createAgentDraft`, ipc.ts `createSession`). Rejected if the id is on the
 *  workspace's own deny-list — a default that is itself denied could never
 *  actually be used. */
export function setDefaultAgent(ws: string, agentId: string | undefined): Promise<void> {
  return editWorkspace(ws, async () => {
    const data = await getWorkspace(ws)
    if (agentId && data.deniedAgents?.includes(agentId))
      throw new Error(`agent "${agentId}" is denied in "${ws}" — allow it first`)
    if (agentId) data.defaultAgent = agentId
    else delete data.defaultAgent
    await saveWorkspace(ws, data)
  })
}

/** Replace the workspace's agent deny-list wholesale (empty = deny nothing).
 *  Rejected if it would deny the workspace's own default agent — clear the
 *  default first, so a workspace never ends up defaulting to an agent no
 *  session of it may use. */
export function setDeniedAgents(ws: string, agentIds: string[]): Promise<void> {
  return editWorkspace(ws, async () => {
    const data = await getWorkspace(ws)
    if (data.defaultAgent && agentIds.includes(data.defaultAgent))
      throw new Error(`"${data.defaultAgent}" is this workspace's default agent — change that first`)
    if (agentIds.length) data.deniedAgents = agentIds
    else delete data.deniedAgents
    await saveWorkspace(ws, data)
  })
}

// --- MCP registry (workspace registry, docs/requirements-mcp-proxy.md §3) ---

/** The workspace's user-configured MCP servers ([] when the field is absent). */
export async function getMcpServers(ws: string): Promise<McpRegistryEntry[]> {
  return (await getWorkspace(ws)).mcpServers ?? []
}

/** Task names with a session whose MCP selection names this entry — the same
 *  delete-blocking rule a linked credential gets (§3.1). */
export async function tasksUsingMcp(ws: string, id: string): Promise<string[]> {
  const used: string[] = []
  for (const task of await listTasks(ws)) {
    const sessions = await readJson<PersistedSession[]>(sessionsFile(ws, task), [])
    if (sessions.some((s) => s.info.mcp?.some((m) => m.id === id))) used.push(task)
  }
  return used
}

/** Reject an entry the registry cannot hold: bad id/url/headers, a reserved
 *  built-in id, or an id another entry already has (§3.3). The credential link
 *  is checked by the caller — see `checkMcpCredential` in main/credentials.ts. */
function assertValidMcp(entry: McpRegistryEntry, others: McpRegistryEntry[]): void {
  const invalid = validateMcpEntry(entry, { takenIds: others.map((e) => e.id) })
  if (invalid) throw new Error(`mcp server "${entry.id}": ${invalid}`)
}

export function addMcpServer(ws: string, entry: McpRegistryEntry): Promise<void> {
  return editWorkspace(ws, async () => {
    const data = await getWorkspace(ws)
    const servers = data.mcpServers ?? []
    assertValidMcp(entry, servers)
    data.mcpServers = [...servers, normalizeMcpEntry(entry)]
    await saveWorkspace(ws, data)
  })
}

/** Update an entry, matched by its (immutable) id — renaming is not supported,
 *  the id is what a session's selection and the proxy route are keyed by. */
export function updateMcpServer(ws: string, entry: McpRegistryEntry): Promise<void> {
  return editWorkspace(ws, async () => {
    const data = await getWorkspace(ws)
    const servers = data.mcpServers ?? []
    const i = servers.findIndex((e) => e.id === entry.id)
    if (i < 0) throw new Error(`mcp server "${entry.id}" not found in "${ws}"`)
    assertValidMcp(entry, servers.filter((_, j) => j !== i))
    servers[i] = normalizeMcpEntry(entry)
    data.mcpServers = servers
    await saveWorkspace(ws, data)
  })
}

export function removeMcpServer(ws: string, id: string): Promise<void> {
  return editWorkspace(ws, async () => {
    const used = await tasksUsingMcp(ws, id)
    if (used.length)
      throw new Error(
        `mcp server "${id}" is selected by session(s) in task(s): ${used.join(', ')} — unselect it there first`
      )
    const data = await getWorkspace(ws)
    if (!data.mcpServers?.some((e) => e.id === id))
      throw new Error(`mcp server "${id}" not found in "${ws}"`)
    data.mcpServers = data.mcpServers.filter((e) => e.id !== id)
    await saveWorkspace(ws, data)
  })
}

// --- skill registry (workspace registry, docs/requirements-skills.md §4.1) ---
//
// The directory listing *is* the registry: a skill is a directory under
// `~/.gurt/<ws>/skills/` holding a `SKILL.md`. There is no index file to keep
// in sync with the tree, which is the whole reason a user may drop a skill in
// by hand — copy the directory, and it is offered.
//
// `workspace.json` holds only `defaultSkills`, which is names.

/** Read one skill directory. A directory that is there but does not parse comes
 *  back as an entry carrying `problem`, never as nothing: it is still selected
 *  by whatever selected it, still deletable, and the user cannot fix what the
 *  UI refuses to show (§4.1). */
async function readSkill(ws: string, name: string): Promise<SkillEntry> {
  const dir = skillDir(ws, name)
  let doc: string
  try {
    doc = await fs.readFile(path.join(dir, SKILL_FILE), 'utf8')
  } catch {
    return { name, description: '', files: [], problem: `no ${SKILL_FILE} in this directory` }
  }
  const files: string[] = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.name !== SKILL_FILE) files.push(entry.isDirectory() ? `${entry.name}/` : entry.name)
  }
  files.sort()
  const { frontmatter, error } = validateSkillDoc(name, doc)
  return {
    name,
    description: frontmatter?.description ?? '',
    files,
    ...(error ? { problem: error } : {})
  }
}

/** The workspace's skills ([] when the registry directory does not exist). */
export async function getSkills(ws: string): Promise<SkillEntry[]> {
  const names: string[] = []
  for (const entry of await fs.readdir(skillsDir(ws), { withFileTypes: true }).catch(() => []))
    if (entry.isDirectory() && !skillNameProblem(entry.name)) names.push(entry.name)
  return skillEntries(await Promise.all(names.map((n) => readSkill(ws, n))))
}

/** One skill's `SKILL.md`, verbatim — what the editor opens and rewrites. */
export async function getSkillDoc(ws: string, name: string): Promise<string> {
  assertSkillName(name)
  try {
    return await fs.readFile(path.join(skillDir(ws, name), SKILL_FILE), 'utf8')
  } catch {
    throw new Error(`skill "${name}" has no ${SKILL_FILE} in "${ws}"`)
  }
}

/** Task names with a session whose skill selection names this skill — the same
 *  delete-blocking rule an MCP entry gets (`tasksUsingMcp`). */
export async function tasksUsingSkill(ws: string, name: string): Promise<string[]> {
  const used: string[] = []
  for (const task of await listTasks(ws)) {
    const sessions = await readJson<PersistedSession[]>(sessionsFile(ws, task), [])
    if (sessions.some((s) => s.info.skills?.some((k) => k.name === name))) used.push(task)
  }
  return used
}

/** Reject a name the registry cannot hold. Split out from the document check
 *  because a delete and a read need it too, and they have no document. */
function assertSkillName(name: string, takenNames: readonly string[] = []): void {
  const bad = skillNameProblem(name, takenNames)
  if (bad) throw new Error(bad)
}

/** Write `SKILL.md` after checking that its frontmatter agrees with the name it
 *  is being filed under — the one rule that cannot be checked from the name
 *  alone (docs/requirements-skills.md §4.1). */
async function writeSkillDoc(ws: string, name: string, doc: string): Promise<void> {
  const { error } = validateSkillDoc(name, doc)
  if (error) throw new Error(`skill "${name}": ${error}`)
  const dir = skillDir(ws, name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, SKILL_FILE), doc)
}

/** Serialized against the registry, not against `workspace.json`: two adds
 *  racing would otherwise both see "name is free". `defaultSkills` writes go
 *  through `editWorkspace` as usual. */
function editSkills<T>(ws: string, fn: () => Promise<T>): Promise<T> {
  return chained(`skills:${ws}`, fn)
}

export function addSkill(ws: string, name: string, doc: string): Promise<void> {
  return editSkills(ws, async () => {
    const clean = name.trim()
    assertSkillName(clean, (await getSkills(ws)).map((s) => s.name))
    await writeSkillDoc(ws, clean, doc)
  })
}

/** Update a skill, matched by its (immutable) name — renaming is not supported,
 *  the name is what a session's selection stores and what the mount copies.
 *  Only `SKILL.md` is written; supporting files beside it are left alone. */
export function updateSkill(ws: string, name: string, doc: string): Promise<void> {
  return editSkills(ws, async () => {
    const clean = name.trim()
    assertSkillName(clean)
    if (!existsSync(skillDir(ws, clean))) throw new Error(`skill "${clean}" not found in "${ws}"`)
    await writeSkillDoc(ws, clean, doc)
  })
}

/** Delete a skill and everything in its directory. Blocked while a session
 *  selects it: a materialization reads the registry at start, and a selection
 *  pointing at nothing is a start that quietly delivers less than it says. */
export function removeSkill(ws: string, name: string): Promise<void> {
  return editSkills(ws, async () => {
    const clean = name.trim()
    assertSkillName(clean)
    const used = await tasksUsingSkill(ws, clean)
    if (used.length)
      throw new Error(
        `skill "${clean}" is selected by session(s) in task(s): ${used.join(', ')} — unselect it there first`
      )
    if (!existsSync(skillDir(ws, clean))) throw new Error(`skill "${clean}" not found in "${ws}"`)
    await rmTree(skillDir(ws, clean))
    // A deleted skill cannot stay on the default-on list: every new draft would
    // seed a name that resolves to nothing.
    await editWorkspace(ws, async () => {
      const data = await getWorkspace(ws)
      if (!data.defaultSkills?.includes(clean)) return
      const next = data.defaultSkills.filter((n) => n !== clean)
      if (next.length) data.defaultSkills = next
      else delete data.defaultSkills
      await saveWorkspace(ws, data)
    })
  })
}

/**
 * Stage a session's selected skills for its container: wipe
 * `.multirepo/<id>/skills/` and copy each *resolvable* selected skill directory
 * into it. Returns the names that resolved to nothing, for the caller to report
 * on the session's provision log (docs/requirements-skills.md §5).
 *
 * Copied rather than symlinked, and staged rather than bound straight off the
 * registry, for one reason each: a bind follows the host directory, so a
 * registry edit would reach into a running session's read-only mount, and a
 * symlink farm would resolve to paths that do not exist inside the container.
 * A copy is the only shape where "what this session got" is a fact fixed at
 * start.
 *
 * The directory is (re)created even when nothing resolves — the mount's source
 * has to exist, and an empty one is the honest answer to a selection that
 * resolves to nothing.
 */
export async function materializeSessionSkills(
  ws: string,
  task: string,
  sessionId: string,
  selection: readonly { name: string }[] | undefined
): Promise<{ missing: string[] }> {
  const dir = sessionSkillsDir(ws, task, sessionId)
  await rmTree(dir)
  await fs.mkdir(dir, { recursive: true })
  const missing: string[] = []
  for (const name of skillNames(selection)) {
    const src = skillDir(ws, name)
    if (skillNameProblem(name) || !existsSync(path.join(src, SKILL_FILE))) {
      missing.push(name)
      continue
    }
    await fs.cp(src, path.join(dir, name), { recursive: true })
  }
  return { missing }
}

/** Replace the workspace's default-on skill set wholesale (empty = none).
 *  Rejected if it names a skill the registry does not hold — the mirror of
 *  `setDeniedAgents` refusing to deny the default agent: a default nothing
 *  resolves to would seed every new draft with an error row. */
export function setDefaultSkills(ws: string, names: string[]): Promise<void> {
  return editWorkspace(ws, async () => {
    const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))]
    const known = new Set((await getSkills(ws)).map((s) => s.name))
    for (const name of clean)
      if (!known.has(name)) throw new Error(`skill "${name}" is not in this workspace's registry`)
    const data = await getWorkspace(ws)
    if (clean.length) data.defaultSkills = clean
    else delete data.defaultSkills
    await saveWorkspace(ws, data)
  })
}

/** Whether the task exists: `task.json` is the fact, a bare directory is not
 *  (that is what a stray log or session write leaves behind). */
export function taskExists(ws: string, task: string): boolean {
  return existsSync(path.join(taskDir(ws, task), 'task.json'))
}

export async function createTask(ws: string, task: string): Promise<void> {
  validateName('task', task)
  if (taskExists(ws, task)) throw new Error(`task "${task}" already exists in "${ws}"`)
  await writeJson(path.join(taskDir(ws, task), 'task.json'), {
    createdAt: new Date().toISOString()
  } satisfies TaskFile)
}

/** Creation time of a task whose `task.json` predates {@link TaskFile.createdAt}:
 *  the marker file's own birth time. Filesystems that record none report 0 —
 *  mtime stands in there, and the epoch if even the stat fails, which only puts
 *  the task first in oldest-first order rather than dropping it from the tree. */
async function taskBirthTime(ws: string, task: string): Promise<string> {
  const st = await fs.stat(path.join(taskDir(ws, task), 'task.json')).catch(() => null)
  return new Date(st ? st.birthtimeMs || st.mtimeMs : 0).toISOString()
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
  const taskFile = await getTask(ws, task)
  const legacy = taskFile.envs
  if (legacy?.length) {
    for (const e of legacy) {
      const owner = e.session ? records.find((r) => r.info.id === e.session) : undefined
      if (!owner || owner.info.container) continue
      owner.info.container = {
        status: e.status,
        ...(e.containerId ? { id: e.containerId } : {}),
        ...(e.remoteWorkspaceFolder
          ? { remoteWorkspaceFolder: e.remoteWorkspaceFolder }
          : {}),
        repos: e.repo ? [e.repo] : [],
        // Carried through as-is, undefined included: env-split-migration.test.mjs
        // pins the exact record this migration produces.
        error: e.error
      }
    }
    // Drop the migrated `envs` but keep whatever else task.json carries.
    const { envs: _envs, ...rest } = taskFile
    await saveTask(ws, task, rest)
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
    // Pre-MCP-proxy records carried `gitAccess` — the container's native git
    // broker toggle. The broker is gone (docs/requirements-mcp-proxy.md §10.2)
    // and authenticated git is the host-side github MCP only, so the flag is
    // dropped from disk rather than left as a setting nothing reads.
    if ('gitAccess' in info) {
      delete info['gitAccess']
      migrated = true
    }
    // Pre-multirepo records carried a single `repo?: string` field; fold it
    // into the now-plural `repos`.
    if (!Array.isArray(info.repos)) {
      const legacyRepo = info['repo'] as string | undefined
      info.repos = legacyRepo ? [legacyRepo] : []
      delete info['repo']
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
        const legacyContainerRepo = c['repo'] as string | undefined
        c.repos = legacyContainerRepo ? [legacyContainerRepo] : []
        delete c['repo']
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

/** Append records as JSONL lines, serialized per file so overlapping flushes
 *  never interleave. The file is only ever appended to — a rewrite (the usage
 *  ledger's prune) has to go through `rewriteJsonl`, which takes the same chain. */
function appendJsonl(file: string, records: unknown[]): Promise<void> {
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

/** Replace a JSONL file's contents, waiting for pending appends first so a
 *  rewrite can never land between an append's mkdir and its write. Same
 *  tmp+fsync+rename durability as `writeJson` — `fs.writeFile` in place would
 *  be just as vulnerable to a crash leaving a 0-byte file. */
function rewriteJsonl(file: string, records: unknown[]): Promise<void> {
  const prev = appendChains.get(file) ?? Promise.resolve()
  const next = prev.then(async () => {
    const dir = path.dirname(file)
    await fs.mkdir(dir, { recursive: true })
    const tmp = path.join(dir, `.${path.basename(file)}.tmp`)
    const fh = await fs.open(tmp, 'w')
    try {
      await fh.writeFile(records.map((r) => JSON.stringify(r) + '\n').join(''))
      await fh.sync()
    } finally {
      await fh.close()
    }
    await fs.rename(tmp, file)
    if (process.platform !== 'win32') {
      const dh = await fs.open(dir, 'r')
      try {
        await dh.sync()
      } finally {
        await dh.close()
      }
    }
  })
  appendChains.set(
    file,
    next.catch(() => {})
  )
  return next
}

/** Append records as JSONL lines. The file is only ever appended to, never rewritten. */
export function appendSessionLog(
  ws: string,
  task: string,
  sessionId: string,
  records: SessionLogRecord[]
): Promise<void> {
  return appendJsonl(sessionLogFile(ws, task, sessionId), records)
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

/** Remove the scratch directory gurt staged a session's own mounts in
 *  (`.multirepo/<id>`, see {@link sessionScratchDir}): its repo mount points,
 *  its merged devcontainer config and its materialized skills. All gurt's own,
 *  with no owner once the session is deleted. A session that needed none of
 *  them hits a missing path, which `force` makes a no-op. */
export async function deleteSessionScratch(
  ws: string,
  task: string,
  sessionId: string
): Promise<void> {
  await fs.rm(sessionScratchDir(ws, task, sessionId), { recursive: true, force: true })
}

export async function deleteSessionLog(ws: string, task: string, sessionId: string): Promise<void> {
  const file = sessionLogFile(ws, task, sessionId)
  // Let an in-flight append settle first so it can't recreate the file after
  // the rm. The stored chain never rejects.
  await appendChains.get(file)
  appendChains.delete(file)
  await fs.rm(file, { force: true })
}

// --- usage ledger: ~/.gurt/usage.jsonl -------------------------------------
// One line per finished agent turn, host-wide rather than per workspace: the
// limits it accounts for belong to the agent's credential, which every
// workspace shares.

const usageFile = () => path.join(gurtRoot, 'usage.jsonl')

export function appendUsage(records: TurnRecord[]): Promise<void> {
  return appendJsonl(usageFile(), records)
}

/** The whole ledger, oldest first. A missing file is an empty ledger; a torn
 *  trailing line from a crash mid-append is skipped, as in `readSessionLog`. */
export async function readUsage(): Promise<TurnRecord[]> {
  const raw = await fs.readFile(usageFile(), 'utf8').catch(() => '')
  const out: TurnRecord[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line) as TurnRecord
      if (typeof rec?.ts === 'string' && typeof rec?.ms === 'number') out.push(rec)
    } catch {
      // torn line — drop it
    }
  }
  return out
}

/** Rewrite the ledger with exactly `records` — the prune's only writer. */
export function writeUsage(records: TurnRecord[]): Promise<void> {
  return rewriteJsonl(usageFile(), records)
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
      const taskFile = await getTask(ws, task)
      tasks.push({
        name: task,
        createdAt: taskFile.createdAt ?? (await taskBirthTime(ws, task)),
        repos: await taskClones(ws, task),
        sessions: [],
        ...(taskFile.maxConcurrentSessions ? { maxConcurrentSessions: taskFile.maxConcurrentSessions } : {})
      })
    }
    tree.workspaces.push({
      name: ws,
      repos: wsData.repos,
      envs: wsData.envs,
      ...(wsData.defaultAgent ? { defaultAgent: wsData.defaultAgent } : {}),
      ...(wsData.deniedAgents?.length ? { deniedAgents: wsData.deniedAgents } : {}),
      ...(wsData.defaultSkills?.length ? { defaultSkills: wsData.defaultSkills } : {}),
      tasks
    })
  }
  return tree
}
