// The whole Electron-facing surface: broadcast bridge, the `GurtApi`
// implementation over the kernel, and handler registration. Everything
// domain-shaped lives in kernel.ts and below.
import { BrowserWindow, ipcMain, shell } from 'electron'
import { API_METHODS, type GurtApi } from '../shared/api'
import { MCP_DEFS } from '../shared/mcp'
import { createKernel } from './kernel'
import { createLogger, dropSessionLog, enabled, logDir, logLevel, logRenderer } from './log'
import { getCredentials, setCredentials, credentialUsedBy } from './credentials'
import {
  discoverDevcontainer,
  discoverDockerfiles,
  envBuildImage,
  envImageStatus
} from './provision'
import * as store from './store'
import * as changes from './changes'
import { normalizeNotificationPrefs } from '../shared/notifications'

const log = createLogger('ipc')

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, ...args)
}

/**
 * Methods whose arguments carry user or agent prose — prompts, commit messages,
 * credential payloads, whole devcontainer configs. Their args are never logged,
 * not even at DBG: "no chat content in the log" has to hold at the boundary,
 * not at each call site's discretion.
 */
const OPAQUE_ARGS = new Set<keyof GurtApi>([
  'createSession',
  'sessionPrompt',
  'sessionEditPrompt',
  'sessionEditDraft',
  'renameSession',
  'changesCommit',
  'setCredentials',
  'setAgents',
  'addEnv',
  'updateEnv'
])

/** Args for the DBG trace: a count for the opaque methods, the (redacted,
 *  truncated) values for everything else. */
function argCtx(method: keyof GurtApi, args: unknown[]): unknown {
  return OPAQUE_ARGS.has(method) ? `${args.length} arg(s) [not logged]` : args
}

export function registerIpc(): void {
  const kernel = createKernel()

  kernel.bus.on('tree.changed', () => broadcast('tree-changed'))
  kernel.bus.on('session.changed', ({ sessionId }) => {
    const snap = kernel.sessions.snapshot(sessionId)
    // The per-change broadcast never carries history — timeline deltas ride
    // the session-log channel; the full fold comes from session:snapshot.
    if (snap) broadcast('session-changed', { ...snap, entries: undefined })
  })
  kernel.bus.on('session.log', (e) => broadcast('session-log', e))
  kernel.bus.on('session.turn', (e) => broadcast('session-turn', e))
  kernel.bus.on('provision.log', (e) => broadcast('provision-log', e))
  kernel.bus.on('notification.created', (record) => broadcast('notification', record))
  kernel.bus.on('notification.read', (e) => broadcast('notification-read', e))

  const impl: GurtApi = {
    getTree: () => kernel.tree(),
    getMcpDefs: async () => MCP_DEFS,
    getAgents: () => store.getAgents(),
    setAgents: (agents) => store.setAgents(agents),
    getAgentConfig: async (agentId) => {
      // Prefer the live in-memory cache (freshest); fall back to the persisted
      // file / hardcoded default when no session has refreshed it this run.
      const agents = await store.getAgents()
      const kind = agents[agentId]?.kind
      const live = kernel.sessions.agentConfig(agentId, kind)
      if (live.updatedAt) return live
      return store.getAgentConfig(agentId)
    },
    getCredentials: () => getCredentials(),
    setCredentials: (data) => setCredentials(data),
    credentialUsedBy: (id) => credentialUsedBy(id),
    // Store CRUD announces over the bus, not straight to the windows, so
    // headless bus subscribers (orchestrator, extensions) see these too.
    createWorkspace: async (name) => {
      await store.createWorkspace(name)
      kernel.bus.emit('tree.changed', undefined)
    },
    addRepo: async (ws, repo) => {
      await store.addRepo(ws, repo)
      kernel.bus.emit('tree.changed', undefined)
    },
    discoverDevcontainer: (ws, repo) => discoverDevcontainer(ws, repo),
    discoverDockerfiles: (ws, repo) => discoverDockerfiles(ws, repo),
    envImageStatus: (ws, env) => envImageStatus(ws, env),
    envBuildImage: async (ws, env) => {
      // The renderer subscribes to this key for the streamed build-log tail.
      const key = `env-build:${ws}/${env}`
      const log = (line: string) => kernel.bus.emit('provision.log', { key, line })
      try {
        return await envBuildImage(ws, env, log)
      } catch (e) {
        log(`error: ${e instanceof Error ? e.message : String(e)}`)
        throw e
      }
    },
    updateRepo: async (ws, repo) => {
      await store.updateRepo(ws, repo)
      kernel.bus.emit('tree.changed', undefined)
    },
    removeRepo: async (ws, name) => {
      await store.removeRepo(ws, name)
      kernel.bus.emit('tree.changed', undefined)
    },
    addEnv: async (ws, env) => {
      await store.addEnv(ws, env)
      kernel.bus.emit('tree.changed', undefined)
    },
    updateEnv: async (ws, env) => {
      await store.updateEnv(ws, env)
      kernel.bus.emit('tree.changed', undefined)
    },
    removeEnv: async (ws, name) => {
      await store.removeEnv(ws, name)
      // The env's build log (`logs/session-env-build-….log`) goes with the env —
      // same lifecycle rule as a session's file going with the session.
      dropSessionLog(`env-build:${ws}/${name}`)
      kernel.bus.emit('tree.changed', undefined)
    },
    createTask: async (ws, name) => {
      await store.createTask(ws, name)
      kernel.bus.emit('tree.changed', undefined)
    },
    removeTask: (ws, name) => kernel.deleteTask(ws, name),
    renameTask: (ws, name, newName) => kernel.renameTask(ws, name, newName),
    taskDirtyRepos: (ws, name) => kernel.taskDirtyRepos(ws, name),
    stopContainer: (sessionId) => kernel.containers.stop(sessionId),
    releaseContainer: (sessionId) => kernel.containers.release(sessionId),
    sessionOpenVscode: (sessionId) => kernel.containers.openVscode(sessionId),
    getTaskChanges: (ws, task, opts) => changes.getTaskChanges(ws, task, opts ?? {}),
    getFileDiff: (ws, task, repo, file) => changes.getFileDiff(ws, task, repo, file),
    getCommitDiff: (ws, task, repo, sha) => changes.getCommitDiff(ws, task, repo, sha),
    changesCommit: (ws, task, repo, message) => changes.commit(ws, task, repo, message),
    changesPush: (ws, task, repo) => changes.push(ws, task, repo),
    changesUpdateFromMain: (ws, task, repo) => changes.updateFromMain(ws, task, repo),
    latestProposal: async (ws, task, repo) => kernel.sessions.latestProposal(ws, task, repo),
    changesOpenPr: async (ws, task, repo) => {
      await shell.openExternal(await kernel.prUrl(ws, task, repo))
    },
    changesOpenVscode: (ws, task, repo) => changes.openInVscode(ws, task, repo),
    createSession: async (
      ref,
      repo,
      agent,
      prompt,
      action,
      mcp,
      autoAllow,
      gitAccess,
      configValues
    ) => {
      // The session's first persist mkdir -p's its way into the task directory,
      // so a stale or in-flight task name from the renderer would silently
      // recreate a deleted task — a directory with sessions and no `task.json`,
      // invisible in the tree. The task has to exist *before* the session does.
      if (!store.taskExists(ref.workspace, ref.task))
        throw new Error(`task "${ref.task}" not found in "${ref.workspace}"`)
      return kernel.sessions.createSession(
        ref,
        repo,
        agent,
        prompt,
        action,
        mcp,
        autoAllow,
        gitAccess,
        configValues
      )
    },
    sessionRun: async (id) => kernel.sessions.run(id),
    sessionEnqueue: async (id) => kernel.sessions.enqueue(id),
    sessionCancelQueue: async (id) => kernel.sessions.cancelQueue(id),
    sessionEditPrompt: async (id, text) => kernel.sessions.editPrompt(id, text),
    renameSession: async (id, title) => kernel.sessions.renameSession(id, title),
    sessionEditDraft: async (id, patch) => kernel.editDraft(id, patch),
    sessionDelete: async (id) => kernel.sessions.deleteSession(id),
    sessionSnapshot: async (id) => {
      // Opening a session (sidebar click, palette jump, a notification row)
      // reads its own awaiting/turn state directly — clears its pending
      // notifications the same way (§4.2), not just an explicit panel dismiss.
      kernel.notifications.markSessionRead(id)
      return kernel.sessions.snapshot(id)
    },
    sessionPrompt: (id, text, context, images) => kernel.sessions.prompt(id, text, context, images),
    sessionCancel: async (id) => kernel.sessions.cancel(id),
    sessionSetMode: (id, modeId) => kernel.sessions.setMode(id, modeId),
    sessionSetConfigOption: (id, configId, value) =>
      kernel.sessions.setConfigOption(id, configId, value),
    sessionPermission: async (id, entryId, optionId) =>
      kernel.sessions.respondPermission(id, entryId, optionId),
    sessionActivity: async (id) => kernel.sessions.activity(id),
    openLogsFolder: async () => {
      const err = await shell.openPath(logDir())
      if (err) throw new Error(err)
    },
    getNotifications: async () => kernel.notifications.list(),
    markNotificationRead: async (id) => kernel.notifications.markRead(id),
    markAllRead: async () => kernel.notifications.markAllRead(),
    dismissNotification: async (id) => kernel.notifications.dismiss(id),
    getNotificationPrefs: () => store.getNotificationPrefs(),
    setNotificationPrefs: async (prefs) => {
      // The renderer's payload is untrusted at this boundary — normalize
      // before it ever reaches disk or the live subscriber. Garbage/missing
      // fields fall back to what's already persisted, not hardcoded
      // defaults, so a bad write can't silently discard a prior toggle.
      const normalized = normalizeNotificationPrefs(prefs, await store.getNotificationPrefs())
      await store.setNotificationPrefs(normalized)
      kernel.notifications.setPrefs(normalized)
    }
  }

  // Renderer records: validated, rate-limited and truncated inside `logRenderer`
  // — everything arriving here is untrusted input.
  ipcMain.on('log', (_e, level: unknown, scope: unknown, msg: unknown, ctx: unknown, ts: unknown) =>
    logRenderer(level, scope, msg, ctx, ts)
  )
  // The effective threshold, mirrored to the renderer once at preload time so a
  // filtered-out debug call costs a comparison there, not an IPC message main
  // throws away. Main keeps filtering regardless — this is an optimization,
  // never the authority.
  ipcMain.on('log:level', (e) => {
    e.returnValue = logLevel
  })

  // One wrapper for the whole API surface: every call is timed, every rejection
  // is recorded once — here, at the boundary — and then rethrown unchanged so
  // the renderer still sees the original error.
  for (const m of API_METHODS)
    ipcMain.handle(`api:${m}`, async (_e, ...args) => {
      const started = Date.now()
      try {
        const result = await (impl[m] as (...a: unknown[]) => unknown)(...args)
        log.debug('ipc.call', { method: m, ms: Date.now() - started, args: argCtx(m, args) })
        return result
      } catch (e) {
        log.error('ipc.fail', {
          method: m,
          ms: Date.now() - started,
          err: e,
          ...(enabled('debug') ? { args: argCtx(m, args) } : {})
        })
        throw e
      }
    })
}
