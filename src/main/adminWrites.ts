// The write half of the operator's admin surface
// (docs/requirements-session-operator.md §3.5, §4, §5 — phase 2).
//
// Every `write`-annotated GurtApi method reaches the store through `write()`
// below, which is the one chokepoint §4.4(c) depends on. In order, a write:
//   1. names its entity (`ENTITY_OF`, compile-checked against the annotation)
//      and must carry that entity's current revision — derived, never stored:
//      a short hash of its canonical JSON as read (§3.5);
//   2. is refused outright if it would link, re-link or re-point a credential
//      (§5.2) — refused, not held, because a URL diff does not convey "this
//      host now receives your token";
//   3. is split: fields through which a write runs code on the host or opens
//      the host to a container (§4.1) are taken out and kept here, keyed by
//      (entity, resulting revision); the safe rest lands (§4.2);
//   4. runs attributed to the operator in the config journal (§7).
//
// `applyHeld()` releases held fields — by name only; the values are the ones
// stored here, never the caller's — and only after the user answered a
// confirmation the session raises itself, outside the ACP permission path and
// therefore out of auto-allow's reach (§4.3).
import { createHash } from 'node:crypto'
import { applyEdits, modify } from 'jsonc-parser'
import type { GurtApi, WriteMethod } from '../shared/api'
import type { EnvConfig, RepoConfig } from '../shared/types'
import type { McpRegistryEntry } from '../shared/mcp'
import { isLocalMcpEntry, mcpEntryKind } from '../shared/mcp'
import { canonicalJson, parseEnvDevcontainer } from '../shared/envConfig'
import { sanitizeSkillSelection } from '../shared/skills'
import { normalizeNotificationPrefs } from '../shared/notifications'
import { sanitizeHotkeys } from '../shared/hotkeys'
import { sanitizeWelcomeMode } from '../shared/doctor'
import { ADMIN_TOOLS } from '../shared/adminTools.generated'
import { checkMcpEntryCredential } from './credentials'
import { checkMcpCommand, clearNpmInstall } from './mcp/stdioBridge'
import { envBuildImage } from './provision'
import { createLocalRepo } from './localRepo'
import { dropSessionLog } from './log'
import * as store from './store'
import type { Kernel } from './kernel'

/** The revision of an entity that does not exist — what a create carries. */
export const ABSENT_REV = 'absent'

/** §3.5: derived, never stored — correct for an entity the user edited by
 *  hand, which will never carry a counter. */
export function revOf(value: unknown): string {
  if (value === undefined) return ABSENT_REV
  return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 12)
}

/** Who is writing: the bound workspace (§3.2) and the operator session —
 *  the journal's author and the session that raises the confirmation. */
export interface AdminCtx {
  ws: string
  sessionId: string
}

/** §4.2's result shape. */
export interface HeldField {
  field: string
  reason: string
}
export interface WriteResult {
  /** Revision after the safe part landed — what the next write must carry. */
  rev: string
  /** What did not land. Absent when nothing was held. */
  held?: HeldField[]
  /** The method's own return value, when it has one (a built image's tag, a
   *  created local repo). */
  result?: unknown
}

type Args = Record<string, unknown>

// --- entities ----------------------------------------------------------------

/**
 * Which entity each write touches — and so which revision it must carry.
 * `Record<WriteMethod, …>`: annotating a method `write` without naming its
 * entity here is a compile error, the same guarantee `reads()` gives.
 * Workspace-level setters share one `defaults` entity; the host-global
 * preferences are one entity each.
 */
const ENTITY_OF: Record<WriteMethod, (a: Args) => string> = {
  setAgents: () => 'agents',
  addRepo: (a) => `repo:${(a['repo'] as RepoConfig).name}`,
  createLocalRepo: (a) => `repo:${String(a['name'])}`,
  envBuildImage: (a) => `env:${String(a['env'])}`,
  updateRepo: (a) => `repo:${(a['repo'] as RepoConfig).name}`,
  removeRepo: (a) => `repo:${String(a['name'])}`,
  addEnv: (a) => `env:${(a['env'] as EnvConfig).name}`,
  updateEnv: (a) => `env:${(a['env'] as EnvConfig).name}`,
  removeEnv: (a) => `env:${String(a['name'])}`,
  setDefaultAgent: () => 'defaults',
  setDeniedAgents: () => 'defaults',
  addMcpServer: (a) => `mcp:${(a['entry'] as McpRegistryEntry).id}`,
  updateMcpServer: (a) => `mcp:${(a['entry'] as McpRegistryEntry).id}`,
  removeMcpServer: (a) => `mcp:${String(a['id'])}`,
  addSkill: (a) => `skill:${String(a['name'])}`,
  updateSkill: (a) => `skill:${String(a['name'])}`,
  removeSkill: (a) => `skill:${String(a['name'])}`,
  setDefaultSkills: () => 'defaults',
  setOperatorEnv: () => 'defaults',
  reinstallMcpServer: (a) => `mcp:${String(a['id'])}`,
  createTask: (a) => `task:${String(a['name'])}`,
  setTaskMaxConcurrentSessions: (a) => `task:${String(a['name'])}`,
  setNotificationPrefs: () => 'notification-prefs',
  setHotkeys: () => 'hotkeys',
  setWelcomeMode: () => 'welcome-mode'
}

/** The entity as read — `undefined` when it does not exist. */
async function readEntity(ws: string, entity: string): Promise<unknown> {
  const colon = entity.indexOf(':')
  const kind = colon < 0 ? entity : entity.slice(0, colon)
  const name = colon < 0 ? '' : entity.slice(colon + 1)
  switch (kind) {
    case 'repo':
      return (await store.getWorkspace(ws)).repos.find((r) => r.name === name)
    case 'env':
      return (await store.getWorkspace(ws)).envs.find((e) => e.name === name)
    case 'mcp':
      return (await store.getMcpServers(ws)).find((e) => e.id === name)
    case 'skill':
      if (!(await store.getSkills(ws)).some((s) => s.name === name)) return undefined
      return store.getSkillDoc(ws, name)
    case 'task':
      if (!name || !store.taskExists(ws, name)) return undefined
      // Only what a write can change — `createdAt` is the store's.
      return { maxConcurrentSessions: (await store.getTask(ws, name)).maxConcurrentSessions }
    case 'defaults': {
      const w = await store.getWorkspace(ws)
      return {
        defaultAgent: w.defaultAgent,
        deniedAgents: w.deniedAgents ?? [],
        defaultSkills: w.defaultSkills ?? [],
        operatorEnv: w.operatorEnv
      }
    }
    case 'agents':
      return store.getAgents()
    case 'notification-prefs':
      return store.getNotificationPrefs()
    case 'hotkeys':
      return store.getHotkeys()
    case 'welcome-mode':
      return store.getWelcomeMode()
  }
  throw new Error(
    `unknown entity "${entity}" — one of repo:<name>, env:<name>, mcp:<id>, skill:<name>, ` +
      'task:<name>, defaults, agents, notification-prefs, hotkeys, welcome-mode'
  )
}

/** Every entity the bound workspace has, plus the host-global ones. */
async function allEntities(ws: string): Promise<string[]> {
  const w = await store.getWorkspace(ws)
  return [
    ...w.repos.map((r) => `repo:${r.name}`),
    ...w.envs.map((e) => `env:${e.name}`),
    ...(await store.getMcpServers(ws)).map((e) => `mcp:${e.id}`),
    ...(await store.getSkills(ws)).map((s) => `skill:${s.name}`),
    ...(await store.listTasks(ws)).map((t) => `task:${t}`),
    'defaults',
    'agents',
    'notification-prefs',
    'hotkeys',
    'welcome-mode'
  ]
}

// --- §5.2: credential refusals ------------------------------------------------

function refuse(what: string): never {
  throw new Error(
    `${what} — refused, not held: linking a credential, or re-pointing an entity that ` +
      'carries one, decides which host receives a secret, and that is not something a ' +
      'confirmation diff conveys. Ask the user to make this change in Settings.'
  )
}

const sameLink = (a: string | undefined, b: string | undefined): boolean => (a ?? '') === (b ?? '')

function checkRepoLinks(next: RepoConfig, prev: RepoConfig | undefined): void {
  if (!prev) {
    if (next.credentialId) refuse(`repo "${next.name}" may not be created with a credential link`)
    return
  }
  if (!sameLink(next.credentialId, prev.credentialId))
    refuse(`the credential link of repo "${next.name}" may not be changed`)
  // A local repo's url is its storage path and the store keeps it whatever an
  // edit sends — only a real change is a re-point.
  if (prev.credentialId && !prev.local && next.url !== prev.url)
    refuse(`repo "${next.name}" carries a credential, so its url may not be changed`)
}

function checkMcpLinks(
  next: McpRegistryEntry,
  prev: McpRegistryEntry | undefined,
  heldFields: string[]
): void {
  if (!prev) {
    if (next.credentialId)
      refuse(`MCP server "${next.id}" may not be created with a credential link`)
    return
  }
  if (!sameLink(next.credentialId, prev.credentialId))
    refuse(`the credential link of MCP server "${next.id}" may not be changed`)
  if (!prev.credentialId) return
  if (mcpEntryKind(next) !== mcpEntryKind(prev))
    refuse(`MCP server "${next.id}" carries a credential, so its kind may not be changed`)
  if (!isLocalMcpEntry(prev) && !isLocalMcpEntry(next) && next.url !== prev.url)
    refuse(`MCP server "${next.id}" carries a credential, so its url may not be changed`)
  // A local entry's credential is handed to whatever process the command
  // fields name: changing them is re-pointing, not merely host execution.
  if (heldFields.length)
    refuse(
      `MCP server "${next.id}" carries a credential, so what it runs ` +
        `(${heldFields.join(', ')}) may not be changed`
    )
}

function checkAgentLinks(next: Record<string, { credentialId?: string | undefined }>, prev: typeof next): void {
  for (const [id, agent] of Object.entries(next))
    if (!sameLink(agent.credentialId, prev[id]?.credentialId))
      refuse(
        prev[id]
          ? `the credential link of agent "${id}" may not be changed`
          : `agent "${id}" may not be created with a credential link`
      )
}

// --- §4.1: held fields --------------------------------------------------------

/**
 * The env deny list: devcontainer.json members through which a write runs code
 * on the host or opens the host to the container. §4.1's five, plus the
 * members that turned out to reach the host the same way once the provisioning
 * code was read against the rule — `build.dockerfile` is a host path gurt
 * writes the Dockerfile *to*, `build.context` a host directory sent into a
 * build, `workspaceMount` a bind like `mounts`, `securityOpt` the isolation
 * `privileged` drops wholesale, and a compose file can declare all of them.
 * Dotted names are paths into the JSON.
 */
const ENV_HELD: Record<string, string> = {
  initializeCommand: 'runs on your user’s machine, outside every container, before anything is built',
  mounts: 'binds host paths into the container',
  runArgs: 'is raw `docker run` arguments — `--privileged`, `-v /:/host`, the docker socket',
  privileged: 'gives the container full access to the host',
  capAdd: 'grants the container host capabilities',
  securityOpt: 'relaxes the container’s isolation from the host',
  workspaceMount: 'binds a host path as the container’s workspace',
  dockerComposeFile: 'names a compose file, which can mount host paths and run privileged services',
  'build.dockerfile': 'is a host path gurt writes the Dockerfile to',
  'build.context': 'sends a host directory into the image build'
}

/** The command-bearing fields of a local MCP entry — a process gurt spawns on
 *  the host, unsandboxed (§4.1). `env` too: `NODE_OPTIONS` and `LD_PRELOAD`
 *  are commands by another name. The npm `version` pin is not here — §13
 *  records that the package identity, not its version, is the boundary. */
const MCP_HELD: Record<string, string> = {
  command: 'is a program gurt runs on your user’s machine, unsandboxed',
  package: 'is an npm package gurt installs and runs on your user’s machine, unsandboxed',
  args: 'is the argv of a process on your user’s machine',
  cwd: 'is where a host process runs, which decides what a relative path executes',
  env: 'is the environment of a host process (`NODE_OPTIONS`, `LD_PRELOAD`, …)'
}

const heldReason = (field: string, why: string): string =>
  `\`${field}\` ${why} — it needs your user’s explicit confirmation: call apply_held`

const differs = (a: unknown, b: unknown): boolean => canonicalJson(a) !== canonicalJson(b)

function getPath(obj: unknown, field: string): unknown {
  let cur = obj
  for (const key of field.split('.')) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

/** Set (or, with `undefined`, remove) one member of a JSONC text, keeping its
 *  comments and layout. */
function setJsonc(text: string, field: string, value: unknown): string {
  const edits = modify(text, field.split('.'), value, {
    formattingOptions: { insertSpaces: true, tabSize: 2 }
  })
  return applyEdits(text, edits)
}

/** What a held fragment holds — the agent's values, kept host-side so
 *  `applyHeld` can name fields without carrying them (§4.3). */
interface Held {
  kind: 'env' | 'mcp'
  /** The entity's revision after the safe part landed; the fragment is valid
   *  only while the entity still reads at it. */
  rev: string
  /** field → the agent's value (`undefined` = the agent removed it). */
  values: Map<string, unknown>
  /** Set when nothing could land: a new local MCP entry, or one changing
   *  kind, is not an entry without its command — the whole entry is held,
   *  and released whole. */
  replace?: McpRegistryEntry
}

interface Plan {
  /** Positional arguments for the method, with held fields taken out. */
  args: unknown[]
  held?: Omit<Held, 'rev'>
}

function heldList(kind: Held['kind'], fields: Iterable<string>): HeldField[] {
  const reasons = kind === 'env' ? ENV_HELD : MCP_HELD
  return [...fields].map((field) => ({ field, reason: heldReason(field, reasons[field] ?? '') }))
}

/** Split an env write: the agent's text with every deny-listed member put
 *  back to what it is now (or removed, for a new env). */
function planEnv(env: EnvConfig, prev: EnvConfig | undefined): Plan['held'] & { env: EnvConfig } | { env: EnvConfig } {
  const next = parseEnvDevcontainer(env.devcontainer)
  // Unparseable: nothing can be read out of it, so nothing can be smuggled
  // through it — the store's own validation refuses it with the parse error.
  if (!next.config) return { env }
  const before = prev ? parseEnvDevcontainer(prev.devcontainer).config : undefined
  const values = new Map<string, unknown>()
  let text = env.devcontainer
  for (const field of Object.keys(ENV_HELD)) {
    const want = getPath(next.config, field)
    const have = getPath(before, field)
    if (!differs(want, have)) continue
    values.set(field, want)
    text = setJsonc(text, field, have)
  }
  if (!values.size) return { env }
  return { env: { ...env, devcontainer: text }, kind: 'env', values }
}

function planMcp(entry: McpRegistryEntry, prev: McpRegistryEntry | undefined): Plan['held'] & { entry: McpRegistryEntry | undefined } | { entry: McpRegistryEntry } {
  if (!isLocalMcpEntry(entry)) return { entry }
  const fields = Object.keys(MCP_HELD)
  const values = new Map<string, unknown>()
  if (!prev || mcpEntryKind(prev) !== mcpEntryKind(entry)) {
    for (const f of fields) {
      const v = (entry as unknown as Args)[f]
      if (v !== undefined) values.set(f, v)
    }
    return { entry: undefined, kind: 'mcp', values, replace: entry }
  }
  const safe: Args = { ...entry }
  for (const f of fields) {
    const want = (entry as unknown as Args)[f]
    const have = (prev as unknown as Args)[f]
    if (!differs(want, have)) continue
    values.set(f, want)
    if (have === undefined) delete safe[f]
    else safe[f] = have
  }
  if (!values.size) return { entry }
  return { entry: safe as unknown as McpRegistryEntry, kind: 'mcp', values }
}

// --- the surface ---------------------------------------------------------------

export interface AdminWrites {
  /** Execute one `write`-annotated method (§3.5, §4.2, §5.2). */
  write(ctx: AdminCtx, method: WriteMethod, args: Args): Promise<WriteResult>
  /** Current revisions — of the named entities, or of everything. */
  revisions(ws: string, entities: string[] | undefined): Promise<Record<string, string>>
  /** Release held fields by name, after the user confirmed them (§4.3). */
  applyHeld(ctx: AdminCtx, entity: string, fields: string[], rev: string): Promise<WriteResult & { applied: string[] }>
  /** What is held right now — tests and diagnostics only. */
  pending(ws: string, entity: string): { rev: string; fields: string[] } | undefined
}

export function createAdminWrites(kernel: Kernel): AdminWrites {
  /** `${ws}\0${entity}` → the held fragment. In memory only: an app restart
   *  drops every pending apply rather than resuming it (§4.3, fail closed). */
  const held = new Map<string, Held>()
  const key = (ws: string, entity: string): string => `${ws}\0${entity}`

  // "Dropped the moment the entity changes again" (§4.3) — by anyone: the
  // journal's entity is `<ws>/<kind>/<name>`, which maps onto ours.
  store.onConfigMutation((_op, journalEntity) => {
    const [ws, kind, ...rest] = journalEntity.split('/')
    if (ws && kind && rest.length) held.delete(key(ws, `${kind}:${rest.join('/')}`))
  })

  /** One admin write per workspace at a time: the revision check and the write
   *  it guards must not interleave with a sibling's. */
  const chains = new Map<string, Promise<unknown>>()
  const serial = <T>(ws: string, fn: () => Promise<T>): Promise<T> => {
    const next = Promise.resolve(chains.get(ws))
      .catch(() => {})
      .then(fn)
    chains.set(
      ws,
      next.catch(() => {})
    )
    return next
  }

  /** The write binding — the same side effects ipc.ts's `impl` performs, so a
   *  change made by the operator is indistinguishable downstream from one
   *  made in Settings. Compile-checked against the `write` annotations. */
  const writes = (): Pick<GurtApi, WriteMethod> => {
    const changed = () => kernel.bus.emit('tree.changed', undefined)
    return {
      setAgents: async (agents) => {
        await store.setAgents(agents)
        kernel.sessions.loadAgentKinds(agents)
      },
      addRepo: async (w, repo) => {
        await store.addRepo(w, repo)
        changed()
      },
      createLocalRepo: async (w, name) => {
        const repo = await createLocalRepo(w, name)
        changed()
        return repo
      },
      envBuildImage: async (w, env) => {
        const logKey = `env-build:${w}/${env}`
        const log = (line: string) => kernel.bus.emit('provision.log', { key: logKey, line })
        try {
          return await envBuildImage(w, env, log)
        } catch (e) {
          log(`error: ${e instanceof Error ? e.message : String(e)}`)
          throw e
        }
      },
      updateRepo: async (w, repo) => {
        await store.updateRepo(w, repo)
        changed()
      },
      removeRepo: async (w, name) => {
        await store.removeRepo(w, name)
        changed()
      },
      addEnv: async (w, env) => {
        await store.addEnv(w, env)
        changed()
      },
      updateEnv: async (w, env) => {
        await store.updateEnv(w, env)
        changed()
      },
      removeEnv: async (w, name) => {
        await store.removeEnv(w, name)
        dropSessionLog(`env-build:${w}/${name}`)
        changed()
      },
      setDefaultAgent: async (w, agentId) => {
        await store.setDefaultAgent(w, agentId)
        changed()
      },
      setDeniedAgents: async (w, agentIds) => {
        await store.setDeniedAgents(w, agentIds)
        changed()
      },
      addMcpServer: async (w, entry) => {
        await checkMcpEntryCredential(entry)
        if (isLocalMcpEntry(entry)) checkMcpCommand(entry)
        await store.addMcpServer(w, entry)
        changed()
      },
      updateMcpServer: async (w, entry) => {
        await checkMcpEntryCredential(entry)
        if (isLocalMcpEntry(entry)) checkMcpCommand(entry)
        await store.updateMcpServer(w, entry)
        changed()
      },
      removeMcpServer: async (w, id) => {
        await store.removeMcpServer(w, id)
        changed()
      },
      addSkill: async (w, name, doc) => {
        await store.addSkill(w, name, doc)
        changed()
      },
      updateSkill: async (w, name, doc) => {
        await store.updateSkill(w, name, doc)
        changed()
      },
      removeSkill: async (w, name) => {
        await store.removeSkill(w, name)
        changed()
      },
      setDefaultSkills: async (w, names) => {
        await store.setDefaultSkills(w, sanitizeSkillSelection(names).map((k) => k.name))
        changed()
      },
      setOperatorEnv: async (w, env) => {
        await store.setOperatorEnv(w, env)
        changed()
      },
      reinstallMcpServer: async (w, id) => {
        const entry = (await store.getMcpServers(w)).find((e) => e.id === id)
        if (!entry) throw new Error(`MCP server "${id}" is not in this workspace's registry`)
        if (mcpEntryKind(entry) !== 'npm')
          throw new Error(`MCP server "${id}" is not an npm entry — there is nothing to reinstall`)
        await clearNpmInstall(id)
      },
      createTask: async (w, name) => {
        await store.createTask(w, name)
        changed()
      },
      setTaskMaxConcurrentSessions: (w, name, max) =>
        kernel.setTaskMaxConcurrentSessions(w, name, max),
      setNotificationPrefs: async (prefs) => {
        const normalized = normalizeNotificationPrefs(prefs, await store.getNotificationPrefs())
        await store.setNotificationPrefs(normalized)
        kernel.notifications.setPrefs(normalized)
      },
      setHotkeys: async (map) => {
        const normalized = sanitizeHotkeys(map, await store.getHotkeys())
        await store.setHotkeys(normalized)
        // The app menu is Electron's; ipc.ts rebuilds it on this event.
        kernel.bus.emit('hotkeys.changed', normalized)
      },
      setWelcomeMode: (mode) => store.setWelcomeMode(sanitizeWelcomeMode(mode))
    }
  }

  /** Refusals (§5.2) and the held split (§4.2) for one write, given the
   *  entity as it reads now. Returns the arguments the method actually gets. */
  const plan = async (ws: string, method: WriteMethod, args: Args, positional: unknown[], before: unknown): Promise<Plan> => {
    switch (method) {
      case 'addRepo':
      case 'updateRepo':
        checkRepoLinks(args['repo'] as RepoConfig, before as RepoConfig | undefined)
        return { args: positional }
      case 'setAgents':
        checkAgentLinks(
          args['agents'] as Record<string, { credentialId?: string }>,
          before as Record<string, { credentialId?: string }>
        )
        return { args: positional }
      case 'addEnv':
      case 'updateEnv': {
        const split = planEnv(args['env'] as EnvConfig, before as EnvConfig | undefined)
        return {
          args: [ws, split.env],
          ...('values' in split ? { held: { kind: 'env', values: split.values } } : {})
        }
      }
      case 'addMcpServer':
      case 'updateMcpServer': {
        const entry = args['entry'] as McpRegistryEntry
        const prev = before as McpRegistryEntry | undefined
        const split = planMcp(entry, prev)
        checkMcpLinks(entry, prev, 'values' in split ? [...split.values.keys()] : [])
        if (!('values' in split)) return { args: positional }
        return {
          args: split.entry ? [ws, split.entry] : [],
          held: { kind: 'mcp', values: split.values, ...(split.replace ? { replace: split.replace } : {}) }
        }
      }
      default:
        return { args: positional }
    }
  }

  const mismatch = (entity: string, rev: string, current: string): Error =>
    new Error(
      `revision mismatch on ${entity}: you hold "${rev}", it is now "${current}"` +
        (current === ABSENT_REV
          ? ' — it does not exist (pass "absent" to create it).'
          : ' — it changed since you read it (possibly by the user, in Settings). Re-read it, ' +
            'reconsider the change against what is there now, and write again with the new rev.')
    )

  /** The kernel's own rendering of what `fields` would change — the bytes the
   *  user confirms are these, never anything the agent phrased (§4.3). */
  const describe = (entity: string, h: Held, fields: string[], current: unknown): string => {
    const show = (v: unknown): string =>
      v === undefined ? '(absent)' : JSON.stringify(v, null, 2).replace(/\n/g, '\n    ')
    const currentOf = (f: string): unknown =>
      h.kind === 'env'
        ? getPath(current ? parseEnvDevcontainer((current as EnvConfig).devcontainer).config : undefined, f)
        : (current as Args | undefined)?.[f]
    const lines = [`${entity}${h.replace ? (current ? ' — replaced whole' : ' — created') : ''}`]
    for (const f of fields) {
      const reasons = h.kind === 'env' ? ENV_HELD : MCP_HELD
      lines.push('', `${f} — ${reasons[f] ?? ''}`, `  - ${show(currentOf(f))}`, `  + ${show(h.values.get(f))}`)
    }
    return lines.join('\n')
  }

  return {
    async write(ctx, method, args) {
      const rev = args['rev']
      if (typeof rev !== 'string' || !rev)
        throw new Error('`rev` is required: the entity’s current revision from get_revisions ("absent" to create)')
      const entity = ENTITY_OF[method](args)
      return serial(ctx.ws, async () => {
        const before = await readEntity(ctx.ws, entity)
        const current = revOf(before)
        if (current !== rev) throw mismatch(entity, rev, current)
        const def = ADMIN_TOOLS.find((d) => d.method === method)
        if (!def) throw new Error(`unknown admin method "${method}"`)
        const named = def.params.map((p) => args[p])
        const positional = def.bindWs ? [ctx.ws, ...named] : named
        const p = await plan(ctx.ws, method, args, positional, before)
        const fn = writes()[method] as (...a: unknown[]) => Promise<unknown>
        const result = p.args.length
          ? await store.withJournalActor({ kind: 'operator', id: ctx.sessionId }, () => fn(...p.args))
          : undefined
        const after = revOf(await readEntity(ctx.ws, entity))
        if (p.held) held.set(key(ctx.ws, entity), { ...p.held, rev: after })
        return {
          rev: after,
          ...(p.held ? { held: heldList(p.held.kind, p.held.values.keys()) } : {}),
          ...(result !== undefined ? { result } : {})
        }
      })
    },

    async revisions(ws, entities) {
      const out: Record<string, string> = {}
      for (const e of entities?.length ? entities : await allEntities(ws))
        out[e] = revOf(await readEntity(ws, e))
      return out
    },

    async applyHeld(ctx, entity, fields, rev) {
      const k = key(ctx.ws, entity)
      const h = held.get(k)
      if (!h || h.rev !== rev)
        throw new Error(
          `nothing is held for ${entity} at revision "${rev}" — a held field is dropped as soon ` +
            'as its entity changes again (or gurt restarts); write it again to re-hold it'
        )
      const unknown = fields.filter((f) => !h.values.has(f))
      if (!fields.length || unknown.length)
        throw new Error(
          `held for ${entity}: ${[...h.values.keys()].join(', ')}` +
            (unknown.length ? ` — not held: ${unknown.join(', ')}` : ' — name at least one')
        )
      if (h.replace && fields.length !== h.values.size)
        throw new Error(
          `${entity} is held whole (a local MCP server is not an entry without what it runs) — ` +
            `name all of: ${[...h.values.keys()].join(', ')}`
        )
      const current = await readEntity(ctx.ws, entity)
      if (revOf(current) !== rev) {
        held.delete(k)
        throw mismatch(entity, rev, revOf(current))
      }
      const what = h.kind === 'env' ? 'environment' : 'MCP server'
      const answer = await kernel.sessions.confirmHeld(
        ctx.sessionId,
        `The operator asks to apply held settings to ${what} "${entity.slice(entity.indexOf(':') + 1)}" — ` +
          'these run on, or reach into, this machine',
        describe(entity, h, fields, current)
      )
      if (!answer.ok) {
        if (held.get(k) === h) for (const f of fields) h.values.delete(f)
        if (!h.values.size || h.replace) held.delete(k)
        return { rev, applied: [], ...(h.values.size && !h.replace ? { held: heldList(h.kind, h.values.keys()) } : {}) }
      }
      return serial(ctx.ws, async () => {
        // The prompt has no timeout: whatever changed while it was open wins,
        // and nothing is applied over it.
        const now = await readEntity(ctx.ws, entity)
        if (held.get(k) !== h || revOf(now) !== rev)
          throw new Error(`${entity} changed while the confirmation was open — nothing was applied; re-read it`)
        const actor = {
          kind: 'operator' as const,
          id: ctx.sessionId,
          confirmation: `${ctx.sessionId}#${answer.entryId}`
        }
        const w = writes()
        await store.withJournalActor(actor, async () => {
          if (h.kind === 'env') {
            const env = now as EnvConfig
            let text = env.devcontainer
            for (const f of fields) text = setJsonc(text, f, h.values.get(f))
            await w.updateEnv(ctx.ws, { ...env, devcontainer: text })
          } else if (h.replace) {
            if (now) await w.updateMcpServer(ctx.ws, h.replace)
            else await w.addMcpServer(ctx.ws, h.replace)
          } else {
            const entry: Args = { ...(now as Args) }
            for (const f of fields) {
              const v = h.values.get(f)
              if (v === undefined) delete entry[f]
              else entry[f] = v
            }
            await w.updateMcpServer(ctx.ws, entry as unknown as McpRegistryEntry)
          }
        })
        const after = revOf(await readEntity(ctx.ws, entity))
        const remaining = new Map([...h.values].filter(([f]) => !fields.includes(f)))
        if (remaining.size) held.set(k, { ...h, rev: after, values: remaining })
        return {
          rev: after,
          applied: fields,
          ...(remaining.size ? { held: heldList(h.kind, remaining.keys()) } : {})
        }
      })
    },

    pending(ws, entity) {
      const h = held.get(key(ws, entity))
      return h ? { rev: h.rev, fields: [...h.values.keys()] } : undefined
    }
  }
}
