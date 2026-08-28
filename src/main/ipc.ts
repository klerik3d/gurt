// The whole Electron-facing surface: broadcast bridge, the `GurtApi`
// implementation over the kernel, and handler registration. Everything
// domain-shaped lives in kernel.ts and below.
import { BrowserWindow, ipcMain, shell } from 'electron'
import { API_METHODS, type GurtApi } from '../shared/api'
import { isSessionRole, targetKey } from '../shared/types'
import { MCP_DEFS } from '../shared/mcp'
import { createKernel } from './kernel'
import { POLL_INTERVAL_MS } from './planUsage'
import { createLogger, dropSessionLog, enabled, logDir, logLevel, logRenderer } from './log'
import {
  getCredentials,
  setCredentials,
  credentialUsedBy,
  checkMcpEntryCredential
} from './credentials'
import { isLocalMcpEntry, mcpEntryKind } from '../shared/mcp'
import { checkMcpCommand, clearNpmInstall } from './mcp/stdioBridge'
import {
  discoverDevcontainer,
  discoverDockerfiles,
  envBuildImage,
  envImageStatus
} from './provision'
import { traffic } from './proxy/traffic'
import * as store from './store'
import * as changes from './changes'
import { normalizeNotificationPrefs } from '../shared/notifications'
import { sanitizeHotkeys } from '../shared/hotkeys'
import { initAppMenu } from './menu'
import { checkForUpdates } from './update'

const log = createLogger('ipc')

function broadcast(channel: string, ...args: unknown[]): void {
  // A window mid-close can still be listed while its webContents is already
  // destroyed; sending there throws (the background poll's usage.changed is
  // the common trigger).
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send(channel, ...args)
  }
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
  // Review prose: the note itself, and the fix prompt built out of the notes.
  'addReviewComment',
  'launchReviewFix',
  'setCredentials',
  'setAgents',
  'addEnv',
  'updateEnv',
  // An MCP registry entry is a config payload: its static headers are the
  // user's to fill, and "never a secret" is a rule the store states, not one
  // the wire can enforce.
  'addMcpServer',
  'updateMcpServer'
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
  kernel.bus.on('proxy.traffic', (t) => broadcast('proxy-traffic', t))
  kernel.bus.on('mcp.fail', (f) => broadcast('mcp-fail', f))
  kernel.bus.on('notification.created', (record) => broadcast('notification', record))
  kernel.bus.on('notification.read', (e) => broadcast('notification-read', e))
  kernel.bus.on('usage.changed', () => broadcast('usage-changed'))
  kernel.bus.on('boot.progress', (p) => broadcast('boot-progress', p))

  // Plan limits move with usage from every Claude surface, not just gurt's own
  // turns — so keep them fresh in the background instead of waiting for the
  // dashboard to be open. Each completed sweep announces itself over
  // `usage.changed`, which the renderer answers with a cache read.
  void kernel.planUsage.get()
  setInterval(() => void kernel.planUsage.get(), POLL_INTERVAL_MS)

  const impl: GurtApi = {
    getTree: () => kernel.tree(),
    getMcpDefs: async () => MCP_DEFS,
    getAgents: () => store.getAgents(),
    setAgents: async (agents) => {
      await store.setAgents(agents)
      kernel.sessions.loadAgentKinds(agents)
    },
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
    removeWorkspace: (name) => kernel.deleteWorkspace(name),
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
    setDefaultAgent: async (ws, agentId) => {
      await store.setDefaultAgent(ws, agentId)
      kernel.bus.emit('tree.changed', undefined)
    },
    setDeniedAgents: async (ws, agentIds) => {
      await store.setDeniedAgents(ws, agentIds)
      kernel.bus.emit('tree.changed', undefined)
    },
    getMcpServers: (ws) => store.getMcpServers(ws),
    addMcpServer: async (ws, entry) => {
      // Two checks that need main, done here rather than in the store
      // validator, which is shared with the renderer and knows neither the
      // credential store nor this machine's PATH.
      await checkMcpEntryCredential(entry)
      if (isLocalMcpEntry(entry)) checkMcpCommand(entry)
      await store.addMcpServer(ws, entry)
      kernel.bus.emit('tree.changed', undefined)
    },
    updateMcpServer: async (ws, entry) => {
      await checkMcpEntryCredential(entry)
      if (isLocalMcpEntry(entry)) checkMcpCommand(entry)
      await store.updateMcpServer(ws, entry)
      kernel.bus.emit('tree.changed', undefined)
    },
    removeMcpServer: async (ws, id) => {
      await store.removeMcpServer(ws, id)
      kernel.bus.emit('tree.changed', undefined)
    },
    reinstallMcpServer: async (ws, id) => {
      // Read the entry rather than trusting the caller's word for its kind:
      // "reinstall" means nothing for a command or an http entry, and clearing
      // a stamp that belongs to neither would be a silent no-op.
      const entry = (await store.getMcpServers(ws)).find((e) => e.id === id)
      if (!entry) throw new Error(`MCP server "${id}" is not in this workspace's registry`)
      if (mcpEntryKind(entry) !== 'npm')
        throw new Error(`MCP server "${id}" is not an npm entry — there is nothing to reinstall`)
      await clearNpmInstall(id)
    },
    createTask: async (ws, name) => {
      await store.createTask(ws, name)
      kernel.bus.emit('tree.changed', undefined)
    },
    removeTask: (ws, name) => kernel.deleteTask(ws, name),
    renameTask: (ws, name, newName) => kernel.renameTask(ws, name, newName),
    taskDirtyRepos: (ws, name) => kernel.taskDirtyRepos(ws, name),
    setTaskMaxConcurrentSessions: (ws, name, max) =>
      kernel.setTaskMaxConcurrentSessions(ws, name, max),
    stopContainer: (sessionId) => kernel.containers.stop(sessionId),
    releaseContainer: (sessionId) => kernel.containers.release(sessionId),
    sessionOpenVscode: (sessionId) => kernel.containers.openVscode(sessionId),
    getTaskChanges: (ws, task, opts) => changes.getTaskChanges(ws, task, opts ?? {}),
    getFileDiff: (ws, task, repo, file) => changes.getFileDiff(ws, task, repo, file),
    getCommitDiff: (ws, task, repo, sha) => changes.getCommitDiff(ws, task, repo, sha),
    getDiffFiles: (ws, task, repo, target) => changes.getDiffFiles(ws, task, repo, target),
    getDiffPair: (ws, task, repo, target, file) =>
      changes.getDiffPair(ws, task, repo, target, file),
    getReviewState: (ws, task, repo, target) => kernel.reviewState(ws, task, repo, target),
    getReviewLocks: (ws, task) => kernel.review.locks(ws, task),
    setReviewLock: (ws, task, repo, locked) => kernel.setReviewLock(ws, task, repo, !!locked),
    addReviewComment: (ws, task, repo, target, path, side, line, text, endLine) => {
      // Straight off the wire and straight onto disk — the anchor has to be a
      // real anchor, and an empty note is a UI slip, not a comment.
      if (side !== 'before' && side !== 'after')
        // `side` is typed, but this is the wire: what arrives is whatever the
        // renderer sent, so the message has to be able to name a value the
        // type says cannot exist.
        throw new Error(`unknown diff side "${String(side)}"`)
      if (!Number.isInteger(line) || line < 1) throw new Error(`not a line number: ${line}`)
      if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < line))
        throw new Error(`not a valid range end: ${endLine}`)
      if (!text.trim()) throw new Error('comment is empty')
      return kernel.review.addComment(ws, task, repo, targetKey(target), {
        path,
        side,
        line,
        ...(endLine !== undefined && endLine > line ? { endLine } : {}),
        text: text.trim()
      })
    },
    resolveReviewComment: (ws, task, id, resolved) =>
      kernel.review.resolveComment(ws, task, id, !!resolved),
    deleteReviewComment: (ws, task, id) => kernel.review.deleteComment(ws, task, id),
    launchReviewFix: (ws, task, repo, target, prompt) =>
      kernel.launchReviewFix(ws, task, repo, target, prompt),
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
      repos,
      agent,
      prompt,
      action,
      mcp,
      autoAllow,
      configValues,
      role,
      network
    ) => {
      // Anything that can bring a container up waits out the boot restore: the
      // reconcile rewrites container records from a pre-start snapshot, and a
      // container born mid-reconcile can have its record erased — which reads
      // as "clone free" and lets a second session onto one working tree. The
      // wait is surfaced by the footer's boot-progress bar.
      await kernel.ready
      // The session's first persist mkdir -p's its way into the task directory,
      // so a stale or in-flight task name from the renderer would silently
      // recreate a deleted task — a directory with sessions and no `task.json`,
      // invisible in the tree. The task has to exist *before* the session does.
      if (!store.taskExists(ref.workspace, ref.task))
        throw new Error(`task "${ref.task}" not found in "${ref.workspace}"`)
      if (role !== undefined && !isSessionRole(role))
        throw new Error(`unknown session role "${String(role)}"`)
      // A fresh draft (App.tsx) names no agent up front — it falls back to the
      // workspace's default, same as an agent's own `create_session` request
      // that leaves `agent` out. An explicit pick (a re-post, a duplicate) is
      // checked against the deny-list either way: silently swapping it for the
      // default would hide the denial instead of rejecting it.
      const wsData = await store.getWorkspace(ref.workspace)
      const agentId = agent || wsData.defaultAgent || ''
      if (agentId && wsData.deniedAgents?.includes(agentId))
        throw new Error(`agent "${agentId}" is not allowed in workspace "${ref.workspace}"`)
      return kernel.sessions.createSession(
        ref,
        repos,
        agentId,
        prompt,
        action,
        mcp,
        autoAllow,
        configValues,
        role,
        // Not validated here: `SessionManager.createSession` sanitizes it, and
        // it has to — the agent-drafted and duplicate paths never pass this
        // boundary at all.
        network
      )
    },
    // Same boot gate as createSession — see the comment there.
    sessionRun: async (id) => {
      await kernel.ready
      kernel.sessions.run(id)
    },
    sessionEnqueue: async (id) => {
      await kernel.ready
      kernel.sessions.enqueue(id)
    },
    sessionCancelQueue: async (id) => kernel.sessions.cancelQueue(id),
    sessionEditPrompt: async (id, text) => kernel.sessions.editPrompt(id, text),
    renameSession: async (id, title) => kernel.sessions.renameSession(id, title),
    sessionEditDraft: async (id, patch) => kernel.editDraft(id, patch),
    sessionDuplicate: async (id) => kernel.sessions.duplicateSession(id),
    sessionDelete: async (id) => kernel.sessions.deleteSession(id),
    sessionSnapshot: async (id) => {
      // Opening a session (sidebar click, palette jump, a notification row)
      // reads its own awaiting/turn state directly — clears its pending
      // notifications the same way (§4.2), not just an explicit panel dismiss.
      kernel.notifications.markSessionRead(id)
      return kernel.sessions.snapshot(id)
    },
    // The session's own `internal` flag is the fallback, so a pane that opens
    // before the proxy has logged anything still says which mode it is reading.
    sessionTraffic: async (id) =>
      traffic.get(id, kernel.sessions.sessionInfo(id)?.network?.internal === true),
    // Prompt and config changes can wake a detached session's container — the
    // same boot gate as createSession applies.
    sessionPrompt: async (id, text, context, images) => {
      await kernel.ready
      return kernel.sessions.prompt(id, text, context, images)
    },
    sessionCancel: async (id) => kernel.sessions.cancel(id),
    sessionSetMode: (id, modeId) => kernel.sessions.setMode(id, modeId),
    sessionSetConfigOption: async (id, configId, value) => {
      await kernel.ready
      return kernel.sessions.setConfigOption(id, configId, value)
    },
    sessionPermission: async (id, entryId, optionId) =>
      kernel.sessions.respondPermission(id, entryId, optionId),
    sessionActivity: async (id) => kernel.sessions.activity(id),
    openLogsFolder: async () => {
      const err = await shell.openPath(logDir())
      if (err) throw new Error(err)
    },
    checkForUpdates: () => checkForUpdates(),
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
    },
    getHotkeys: () => store.getHotkeys(),
    setHotkeys: async (map) => {
      // Same untrusted-boundary treatment as notification prefs: a bad/partial
      // payload falls back per-action to what's already persisted, never wipes
      // every other action's remap.
      const normalized = sanitizeHotkeys(map, await store.getHotkeys())
      await store.setHotkeys(normalized)
      // Live-rebuild the hidden accelerators macOS's window-cycle reservation
      // needs (menu.ts) — otherwise a remap away from ⌘`/⌘⇧` would leave the
      // old combination silently hijacked until the next launch.
      initAppMenu(normalized)
    },
    getUsage: async () => {
      // The first read can beat the ledger's own load off disk; waiting on it
      // costs one tick and keeps the dashboard from rendering empty cards.
      await kernel.usage.ready
      return kernel.usage.list()
    },
    getPlanUsage: () => kernel.planUsage.get(),
    getBootProgress: async () => kernel.bootProgress()
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
    ipcMain.handle(`api:${m}`, async (_e, ...args: unknown[]) => {
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
