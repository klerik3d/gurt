// The operator's admin surface (docs/requirements-session-operator.md §3):
// executes the `read`-annotated GurtApi methods on behalf of an operator
// session, bound to that session's workspace. Like preload and ipc.ts, this is
// a *binding* of the one annotated list in shared/api.ts, not a parallel
// surface: `reads()` is compile-checked against `Pick<GurtApi, ReadMethod>`,
// so annotating a method `read` without binding it here — or binding one that
// is not annotated — is a compile error.
//
// Three filters every call passes (§3.2, §3.3, §8):
//   1. the workspace binding — `ws` is injected host-side, never a parameter,
//      and ws-less reads that address a session verify its workspace;
//   2. the per-method narrowings written down in §3.2 (credential values,
//      snapshot-without-chat, probe-by-kind);
//   3. the scrub — every result passes `scrub()` before it crosses the tool
//      boundary.
import { promises as fs } from 'node:fs'
import type { GurtApi, ReadMethod } from '../shared/api'
import type { SessionSnapshot, Tree } from '../shared/types'
import type { CredentialsFile } from '../shared/credentials'
import { CREDENTIAL_KINDS } from '../shared/credentials'
import { MCP_DEFS, mcpEntryKind } from '../shared/mcp'
import { ADMIN_TOOLS } from '../shared/adminTools.generated'
import { getCredentials, credentialUsedBy } from './credentials'
import { probeMcpServer } from './mcp/probe'
import { discoverDevcontainer, discoverDockerfiles, envImageStatus } from './provision'
import { traffic } from './proxy/traffic'
import * as store from './store'
import * as changes from './changes'
import { sessionLogFilePath } from './log'
import { REDACTED } from './redact'
import { scrub } from './scrub'
import type { Kernel } from './kernel'

/** Tail default and cap for `get_provisioning_log` — enough to diagnose a
 *  failed provision, bounded so a runaway log cannot flood the model. */
const LOG_TAIL_DEFAULT = 200
const LOG_TAIL_MAX = 2000

/** What the `gurt` MCP server needs from this module (per operator session,
 *  ws-bound by the session manager — see `SessionEvents.adminCall`). */
export interface AdminSurface {
  /** Execute one admin call; `args` are the tool's named arguments. */
  call(ws: string, method: string, args: Record<string, unknown>): Promise<unknown>
  /** §3.2's one extra tool: the tail of a provisioning log file, scrubbed. */
  provisioningLog(ws: string, key: string, tail: number | undefined): Promise<string>
}

/** §5.1: ids, labels, kinds, link targets — never values. The renderer's mask
 *  keeps a last-4 hint; the operator's view does not even get that. */
function stripCredentialValues(file: CredentialsFile): CredentialsFile {
  const credentials = file.credentials.map((entry) => {
    const keys = (CREDENTIAL_KINDS.find((k) => k.kind === entry.kind)?.fields ?? [])
      .filter((f) => f.secret)
      .map((f) => f.key)
    if (!keys.length) return entry
    const data = { ...entry.data }
    for (const key of keys) data[key] = data[key] ? REDACTED : ''
    return { ...entry, data }
  })
  return { credentials, ...(file.plaintext ? { plaintext: true } : {}) }
}

export function createAdminSurface(kernel: Kernel): AdminSurface {
  /** §3.2 narrowing 3: the operator's diagnostic need is state — container
   *  status, `startError`, timings — never another session's conversation.
   *  The chat entries, the pending prompt texts, the proposal's commit prose,
   *  the plan and the start prompt all stay behind. */
  const narrowedSnapshot = (ws: string, id: string): SessionSnapshot | undefined => {
    const info = kernel.sessions.sessionInfo(id)
    // An unknown id and another workspace's id read the same — the binding
    // must not leak which sessions exist elsewhere.
    if (!info || info.workspace !== ws) return undefined
    const snap = kernel.sessions.snapshot(id)
    if (!snap) return undefined
    return {
      info: { ...snap.info, startPrompt: '' },
      busy: snap.busy,
      resuming: snap.resuming,
      startError: snap.startError,
      queuePosition: snap.queuePosition,
      pendingBlocked: snap.pendingBlocked,
      usage: snap.usage
    }
  }

  /** The ws-bound read set. Compile-checked to cover the `read` annotations
   *  exactly (see the module header) — the `ws` each entry receives is the
   *  bound one, injected by `call()` below for `bindWs` methods. */
  const reads = (ws: string): Pick<GurtApi, ReadMethod> => ({
    // Bound, not filtered by the caller: the operator's authority is
    // workspace-scoped (§3.2), so the tree it reads *is* its workspace.
    getTree: async (): Promise<Tree> => ({
      workspaces: (await kernel.tree()).workspaces.filter((w) => w.name === ws)
    }),
    getMcpDefs: async () => MCP_DEFS,
    getAgents: () => store.getAgents(),
    getAgentConfig: async (agentId) => {
      const agents = await store.getAgents()
      const live = kernel.sessions.agentConfig(agentId, agents[agentId]?.kind)
      if (live.updatedAt) return live
      return store.getAgentConfig(agentId)
    },
    getCredentials: async () => stripCredentialValues(await getCredentials()),
    credentialUsedBy: (id) => credentialUsedBy(id),
    discoverDevcontainer: (w, repo) => discoverDevcontainer(w, repo),
    discoverDockerfiles: (w, repo) => discoverDockerfiles(w, repo),
    envImageStatus: (w, env) => envImageStatus(w, env),
    getMcpServers: (w) => store.getMcpServers(w),
    getSkills: (w) => store.getSkills(w),
    getSkillDoc: (w, name) => store.getSkillDoc(w, name),
    skillUsedBy: (w, name) => store.tasksUsingSkill(w, name),
    // §3.2 narrowing 4 (§6's rule, applied where the schema cannot carry it):
    // an http entry may be probed by value, unsaved — probing one is an HTTP
    // request the proxy could make anyway. A local (npm/command) entry is
    // arbitrary host execution, so it resolves by id against the *saved*
    // registry — the command that runs is the one the user configured, never
    // one the agent composed.
    probeMcpServer: async (w, entry) => {
      if (mcpEntryKind(entry) === 'http') return probeMcpServer(entry)
      const saved = (await store.getMcpServers(w)).find((e) => e.id === entry.id)
      if (!saved)
        throw new Error(
          `a local (npm/command) MCP entry runs on the host, so it may only be probed once it ` +
            `is saved — "${entry.id}" is not in this workspace's registry. Ask the user to save ` +
            'it in Settings first.'
        )
      return probeMcpServer(saved)
    },
    taskDirtyRepos: (w, name) => kernel.taskDirtyRepos(w, name),
    getTaskChanges: (w, task, opts) => changes.getTaskChanges(w, task, opts ?? {}),
    getReviewLocks: (w, task) => kernel.review.locks(w, task),
    // Deliberately without ipc.ts's markSessionRead side effect: the
    // notification read-state is the user's own (§3.4), and an operator
    // reading diagnostics must not clear it.
    sessionSnapshot: async (id) => narrowedSnapshot(ws, id),
    sessionTraffic: async (id) => {
      const info = kernel.sessions.sessionInfo(id)
      if (!info || info.workspace !== ws) throw new Error(`unknown session "${id}"`)
      return traffic.get(id, info.network?.internal === true)
    },
    getNotifications: async () =>
      kernel.notifications.list().filter((n) => n.ref.workspace === ws),
    getNotificationPrefs: () => store.getNotificationPrefs(),
    getHotkeys: () => store.getHotkeys(),
    getUsage: async () => {
      await kernel.usage.ready
      return kernel.usage.list().filter((r) => r.workspace === ws)
    },
    getPlanUsage: () => kernel.planUsage.get(),
    getBootProgress: async () => kernel.bootProgress()
  })

  return {
    async call(ws, method, args) {
      const def = ADMIN_TOOLS.find((d) => d.method === method)
      if (!def) throw new Error(`unknown admin method "${method}"`)
      // Phase 1 of docs/requirements-session-operator.md §11: every annotation
      // that is not `read` is treated as `none` — the operator sees everything
      // and changes nothing. Registration already filters (gurtServer.ts);
      // this is the chokepoint saying it again.
      if (def.exposure !== 'read')
        throw new Error(
          `"${def.name}" is not available: the admin surface is read-only in this phase — ` +
            'tell the user what to change in Settings instead'
        )
      const bound = reads(ws)
      const fn = bound[def.method as ReadMethod] as (...a: unknown[]) => Promise<unknown>
      const positional = def.params.map((p) => args[p])
      const result = await fn(...(def.bindWs ? [ws, ...positional] : positional))
      return scrub(result)
    },

    async provisioningLog(ws, key, tail) {
      let fileKey = key
      if (key.startsWith('env-build:')) {
        // The agent cannot express another workspace (§3.2): a bare
        // `env-build:<env>` is prefixed with the bound one, and a full
        // `env-build:<ws>/<env>` must name it.
        const rest = key.slice('env-build:'.length)
        fileKey = rest.includes('/') ? key : `env-build:${ws}/${rest}`
        if (!fileKey.startsWith(`env-build:${ws}/`))
          throw new Error(`unknown provisioning log "${key}"`)
      } else {
        const info = kernel.sessions.sessionInfo(key)
        if (!info || info.workspace !== ws) throw new Error(`unknown session "${key}"`)
      }
      const raw = await fs.readFile(sessionLogFilePath(fileKey), 'utf8').catch(() => '')
      // An answer, not a throw — a session that never provisioned has no log,
      // and that is a diagnostic finding in itself.
      if (!raw) return `no provisioning log for "${key}"`
      const lines = raw.split('\n').filter((l) => l.length > 0)
      const n = Math.max(1, Math.min(Math.floor(tail ?? LOG_TAIL_DEFAULT), LOG_TAIL_MAX))
      // The file was sanitized line by line as it was written; scrubbed again
      // on the way out, because §8's rule is on the read path, not a hope
      // about the write path.
      return scrub(lines.slice(-n).join('\n')) as string
    }
  }
}
