import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { writeJsonDurable, syncDirectory } from './durableWrite'
import type { Kernel } from './kernel'
import * as store from './store'
import { packScope, unpackScope } from './archiveFormat'
import { applyLog, isActionable, type ChatEntry } from '../shared/types'
import { canAutoArchive, normalizeArchiveSettings, type ArchiveSettings, type ScopeArchive } from '../shared/archive'
import { getTaskChanges, withTaskChangesPaused } from './changes'
import { createLogger, dropSessionLog } from './log'
import { revealTokens, type PiiTable } from '../shared/pii'

const log = createLogger('archive')
const compress = promisify(gzip)
const decompress = promisify(gunzip)
const root = () => path.join(store.gurtRoot, '.archives')
const settingsFile = () => path.join(store.gurtRoot, 'archive-settings.json')
const validId = (id: string): string => {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid archive id')
  return id
}
const dataFile = (id: string) => path.join(root(), `${validId(id)}.jsonl.gz`)
const metaFile = (id: string) => path.join(root(), `${validId(id)}.json`)
const previewDir = (id: string) => path.join(root(), `${validId(id)}.previews`)

export class ArchiveManager {
  private progress: import('../shared/archive').ArchiveProgress | undefined

  private report(stage: string, bytes?: number): void {
    if (!this.progress) return
    this.progress = { ...this.progress, stage, bytes }
    this.kernel.bus.emit('archive.progress', this.progress)
  }

  busy = false
  private activeScope: { workspace: string; task: string; sessions: Set<string> } | undefined
  private policyInFlight: Promise<{ archived: number; deleted: number; errors: string[] }> | undefined

  constructor(private kernel: Kernel) {}

  private async exclusive<T>(action: () => Promise<T>, label?: string): Promise<T> {
    if (this.busy) throw new Error('An archive operation is already in progress')
    this.busy = true
    if (label) {
      this.progress = { id: randomUUID(), label, stage: 'Preparing archive…', done: false }
      this.kernel.bus.emit('archive.progress', this.progress)
    }
    try {
      const result = await action()
      if (this.progress) this.kernel.bus.emit('archive.progress', { ...this.progress, stage: 'Archived', done: true })
      return result
    } catch (e) {
      if (this.progress) this.kernel.bus.emit('archive.progress', {
        ...this.progress, stage: 'Archiving failed', done: true, error: e instanceof Error ? e.message : String(e)
      })
      throw e
    } finally { this.busy = false; this.activeScope = undefined; this.progress = undefined }
  }

  blocksCall(method: string, args: unknown[]): boolean {
    const scope = this.activeScope
    if (!scope || ['syncArchiveRead', 'sessionSnapshot'].includes(method)) return false
    if (args[0] === scope.workspace && (args[1] === scope.task || method === 'removeWorkspace')) return true
    if (typeof args[0] === 'string' && scope.sessions.has(args[0])) return true
    const ref = args[0] as { workspace?: unknown; task?: unknown } | null
    return !!ref && typeof ref === 'object' && ref.workspace === scope.workspace && ref.task === scope.task
  }

  private protect(ws: string, task: string): void {
    this.activeScope = { workspace: ws, task, sessions: new Set(this.kernel.sessions.listForTask(ws, task).map((s) => s.id)) }
  }

  async settings(): Promise<ArchiveSettings> {
    try { return normalizeArchiveSettings(JSON.parse(await fs.readFile(settingsFile(), 'utf8')) as unknown) }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      return normalizeArchiveSettings({})
    }
  }

  async setSettings(settings: ArchiveSettings): Promise<void> {
    await writeJsonDurable(settingsFile(), normalizeArchiveSettings(settings), { mode: 0o600, pretty: false })
  }

  private async metadata(id: string): Promise<ScopeArchive> {
    const meta = JSON.parse(await fs.readFile(metaFile(id), 'utf8')) as ScopeArchive
    if (meta.id !== id || !['scope', 'session'].includes(meta.kind) || typeof meta.workspace !== 'string' || typeof meta.task !== 'string' ||
        typeof meta.pinned !== 'boolean' || !Array.isArray(meta.sessions) ||
        !Number.isFinite(Date.parse(meta.archivedAt))) throw new Error('Invalid archive metadata')
    store.validateName('workspace', meta.workspace)
    store.validateName('task', meta.task)
    return meta
  }

  async list(): Promise<ScopeArchive[]> {
    const out: ScopeArchive[] = []
    const files = await fs.readdir(root()).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e
      return [] as string[]
    })
    for (const file of files) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue
      const id = file.slice(0, -5)
      if (existsSync(dataFile(id))) out.push(await this.metadata(id))
    }
    return out.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt))
  }

  private async savePreviews(meta: ScopeArchive): Promise<void> {
    await fs.mkdir(previewDir(meta.id), { recursive: true, mode: 0o700 })
    for (const session of meta.sessions) {
      const table = this.kernel.pii.table(session.id)
      // Persist this alongside the opaque native history before drop() retires
      // the live table outside the scope directory.
      await writeJsonDurable(path.join(store.sessionScratchDir(meta.workspace, meta.task, session.id), 'archive-pii.json'), table, { mode: 0o600, pretty: false })
      const entries = applyLog([], await store.readSessionLog(meta.workspace, meta.task, session.id))
      const file = path.join(previewDir(meta.id), `${validId(session.id)}.json.gz`)
      const data = await compress(JSON.stringify({ entries, table }))
      const handle = await fs.open(file, 'wx', 0o600)
      try { await handle.writeFile(data); await handle.sync() } finally { await handle.close() }
    }
  }

  private async restoreTables(ws: string, task: string, ids: string[], source = store.taskDir(ws, task)): Promise<void> {
    for (const id of ids) {
      const file = path.join(source, '.multirepo', validId(id), 'archive-pii.json')
      if (!existsSync(file)) continue
      const table = JSON.parse(await fs.readFile(file, 'utf8')) as PiiTable
      if (table.v !== 1 || !table.tokens || typeof table.tokens !== 'object') throw new Error('Invalid archived masking table')
      await this.kernel.pii.restoreTable(id, table)
      await fs.rm(file)
    }
  }

  private async cleanUncommitted(meta: ScopeArchive): Promise<void> {
    await fs.rm(`${dataFile(meta.id)}.tmp`, { force: true })
    if (!existsSync(metaFile(meta.id))) {
      await fs.rm(dataFile(meta.id), { force: true })
      await store.rmTree(previewDir(meta.id))
    }
    if (store.taskExists(meta.workspace, meta.task)) for (const s of meta.sessions)
      await fs.rm(path.join(store.sessionScratchDir(meta.workspace, meta.task, s.id), 'archive-pii.json'), { force: true })
  }

  async archive(ws: string, task: string, automatic = false): Promise<ScopeArchive> {
    await this.kernel.ready
    return this.exclusive(async () => {
      store.validateName('workspace', ws)
      store.validateName('task', task)
      this.protect(ws, task)
      if (!store.taskExists(ws, task)) throw new Error('Scope no longer exists')
      const config = await store.getTask(ws, task)
      if (config.proactive) throw new Error('Proactive agents cannot be archived')
      return this.kernel.sessions.withTaskFrozen(ws, task, () =>
        this.kernel.terminals.withScopeBlocked(ws, task, () => withTaskChangesPaused(ws, task, async () => {
          if (this.kernel.reviewLoop.live(ws, task))
            throw new Error('A review loop is running in this scope; stop it or wait for it to end before archiving')
          if (this.kernel.sessions.taskHasPendingWork(ws, task))
            throw new Error('Finish or cancel queued/running work and remove unsent draft images before archiving this scope')
          if (automatic && !(await this.eligible(ws, task))) throw new Error('Scope is no longer eligible for auto-archive')
          this.kernel.terminals.dropScope(ws, task)
          this.report('Stopping containers…')
          await this.kernel.containers.teardownTask(ws, task)
          await this.kernel.sessions.flushTask(ws, task)
          const sessions = this.kernel.sessions.listForTask(ws, task)
          if (!sessions.length) await store.writeSessions(ws, task, [])
          for (const s of sessions) await store.appendSessionLog(ws, task, s.id, [])
          const meta: ScopeArchive = {
            kind: 'scope',
            id: randomUUID(), workspace: ws, task,
            createdAt: config.createdAt ?? new Date().toISOString(),
            archivedAt: new Date().toISOString(), pinned: false,
            sessions, originalBytes: 0, compressedBytes: 0
          }
          await fs.mkdir(root(), { recursive: true, mode: 0o700 })
          const temp = `${dataFile(meta.id)}.tmp`
          try {
            this.report('Saving chats…')
            await this.savePreviews(meta)
            this.report('Compressing files…', 0)
            meta.originalBytes = await packScope(store.taskDir(ws, task), temp, (bytes) => this.report('Compressing files…', bytes))
            // Validate the full archive before retiring any source data.
            this.report('Verifying archive…')
            await unpackScope(temp)
            const handle = await fs.open(temp, 'r')
            try { await handle.sync() } finally { await handle.close() }
            meta.compressedBytes = (await fs.stat(temp)).size
            for (const file of await fs.readdir(previewDir(meta.id))) meta.compressedBytes += (await fs.stat(path.join(previewDir(meta.id), file))).size
            await fs.rename(temp, dataFile(meta.id))
            await writeJsonDurable(metaFile(meta.id), meta, { mode: 0o600, pretty: false })
            // A crash before this rename leaves a harmless archive copy beside
            // the live scope. A crash after it leaves a complete usable archive.
            this.report('Finishing archive…')
            const retired = path.join(root(), `${meta.id}.source`)
            await fs.rename(store.taskDir(ws, task), retired)
            this.kernel.sessions.dropTaskSessions(ws, task)
            for (const s of sessions) dropSessionLog(s.id)
            await syncDirectory(store.wsDir(ws))
            await syncDirectory(root())
            await this.kernel.proactive.onScopeDeleted(ws, task)
            await store.rmTree(retired).catch((e: unknown) => log.warn('archive.cleanup.fail', { err: e }))
            this.kernel.bus.emit('tree.changed', undefined)
            return meta
          } finally { await this.cleanUncommitted(meta) }
        }))
      )
    }, `${ws} / ${task}`)
  }

  async readSession(id: string, sessionId: string): Promise<ChatEntry[]> {
    const meta = await this.metadata(id)
    if (!meta.sessions.some((s) => s.id === sessionId)) throw new Error('Session is not in this archive')
    const raw = await decompress(await fs.readFile(path.join(previewDir(id), `${validId(sessionId)}.json.gz`)))
    const { entries, table } = JSON.parse(raw.toString('utf8')) as { entries: ChatEntry[]; table: PiiTable }
    return entries.map((entry) => {
      if ('text' in entry) return { ...entry, text: revealTokens(entry.text, table) }
      return { ...entry, title: revealTokens(entry.title, table),
        ...(entry.detail === undefined ? {} : { detail: revealTokens(entry.detail, table) }) }
    })
  }

  async archiveSession(sessionId: string): Promise<ScopeArchive> {
    await this.kernel.ready
    return this.exclusive(async () => {
      const info = this.kernel.sessions.sessionInfo(sessionId)
      if (!info) throw new Error('Session no longer exists')
      const { workspace: ws, task } = info
      this.protect(ws, task)
      if ((await store.getTask(ws, task)).proactive) throw new Error('Proactive runs cannot be archived separately')
      return this.kernel.sessions.withTaskFrozen(ws, task, async () => {
        if (this.kernel.reviewLoop.live(ws, task))
          throw new Error('A review loop is running in this scope; stop it or wait for it to end before archiving')
        if (this.kernel.sessions.taskHasPendingWork(ws, task))
          throw new Error('Finish or cancel queued and running work in this scope before archiving')
        this.report('Stopping container…')
        await this.kernel.containers.release(sessionId, 'archived')
        await this.kernel.sessions.flushTask(ws, task)
        const record = (await store.readSessions(ws, task)).find((r) => r.info.id === sessionId)
        if (!record) throw new Error('Could not persist session before archiving')
        await fs.mkdir(root(), { recursive: true, mode: 0o700 })
        const staging = await fs.mkdtemp(path.join(root(), '.session-'))
        const meta: ScopeArchive = {
          kind: 'session', id: randomUUID(), workspace: ws, task,
          createdAt: (await store.getTask(ws, task)).createdAt ?? new Date().toISOString(),
          archivedAt: new Date().toISOString(), pinned: false, sessions: [record.info],
          originalBytes: 0, compressedBytes: 0
        }
        const temp = `${dataFile(meta.id)}.tmp`
        try {
          this.report('Saving chats…')
          await this.savePreviews(meta)
          await writeJsonDurable(path.join(staging, 'task.json'), await store.getTask(ws, task), { mode: 0o600, pretty: false })
          await writeJsonDurable(path.join(staging, 'sessions.json'), [record], { mode: 0o600, pretty: false })
          await fs.mkdir(path.join(staging, 'sessions'))
          await store.appendSessionLog(ws, task, sessionId, [])
          await fs.copyFile(path.join(store.taskDir(ws, task), 'sessions', `${sessionId}.jsonl`), path.join(staging, 'sessions', `${sessionId}.jsonl`))
          const history = store.sessionHistoryDir(ws, task, sessionId)
          if (existsSync(history)) await fs.cp(history, path.join(staging, '.multirepo', sessionId, 'history'), { recursive: true, verbatimSymlinks: true })
          await fs.mkdir(path.join(staging, '.multirepo', sessionId), { recursive: true })
          await fs.copyFile(path.join(store.sessionScratchDir(ws, task, sessionId), 'archive-pii.json'), path.join(staging, '.multirepo', sessionId, 'archive-pii.json'))
          this.report('Compressing files…', 0)
          meta.originalBytes = await packScope(staging, temp, (bytes) => this.report('Compressing files…', bytes))
          this.report('Verifying archive…')
          await unpackScope(temp)
          const handle = await fs.open(temp, 'r')
          try { await handle.sync() } finally { await handle.close() }
          meta.compressedBytes = (await fs.stat(temp)).size
          for (const file of await fs.readdir(previewDir(meta.id))) meta.compressedBytes += (await fs.stat(path.join(previewDir(meta.id), file))).size
          await fs.rename(temp, dataFile(meta.id))
          await writeJsonDurable(metaFile(meta.id), meta, { mode: 0o600, pretty: false })
          this.report('Finishing archive…')
          await this.kernel.sessions.dropArchivedSession(sessionId)
          dropSessionLog(sessionId)
          await this.kernel.sessions.flushTask(ws, task)
          if (!this.kernel.sessions.listForTask(ws, task).length) await store.writeSessions(ws, task, [])
          await store.deleteSessionLog(ws, task, sessionId)
          await store.deleteSessionScratch(ws, task, sessionId)
          this.kernel.bus.emit('tree.changed', undefined)
          return meta
        } finally {
          await this.cleanUncommitted(meta)
          await store.rmTree(staging)
        }
      })
    }, this.kernel.sessions.sessionInfo(sessionId)?.title ?? 'Session')
  }

  async pin(id: string, pinned: boolean): Promise<void> {
    return this.exclusive(async () => {
      const meta = await this.metadata(id)
      meta.pinned = pinned === true
      await writeJsonDurable(metaFile(id), meta, { mode: 0o600, pretty: false })
      this.kernel.bus.emit('tree.changed', undefined)
    })
  }

  async delete(id: string): Promise<void> {
    return this.exclusive(async () => {
      if ((await this.metadata(id)).pinned) throw new Error('Unpin the archive before deleting it')
      await this.removeFiles(id)
      this.kernel.bus.emit('tree.changed', undefined)
    })
  }

  private async removeFiles(id: string): Promise<void> {
    await fs.rm(dataFile(id))
    await fs.rm(metaFile(id))
    await store.rmTree(previewDir(id))
    await store.rmTree(path.join(root(), `${validId(id)}.source`))
  }

  async restore(id: string): Promise<void> {
    await this.kernel.ready
    return this.exclusive(async () => {
      const meta = await this.metadata(id)
      const { workspace: ws, task } = meta
      this.protect(ws, task)
      if (!existsSync(path.join(store.wsDir(ws), 'workspace.json')))
        throw new Error(`Restore workspace "${ws}" before restoring its scope`)
      if (meta.kind === 'session' && store.taskExists(ws, task)) {
        await this.restoreSessionIntoScope(meta)
        return
      }
      store.validateNewTaskName(ws, task)
      const destination = store.taskDir(ws, task)
      if (existsSync(destination)) throw new Error('A scope or directory with this name already exists')
      const staging = await fs.mkdtemp(path.join(root(), '.restore-'))
      try {
        await unpackScope(dataFile(id), staging)
        if (!existsSync(path.join(staging, 'task.json'))) throw new Error('Archive has no scope configuration')
        const stored = JSON.parse(await fs.readFile(path.join(staging, 'sessions.json'), 'utf8')) as Awaited<ReturnType<typeof store.readSessions>>
        for (const r of stored) {
          if (this.kernel.sessions.sessionInfo(r.info.id)) throw new Error('A session from this archive already exists')
          delete r.info.container
          r.info.lastActivityAt = new Date().toISOString()
          r.info.archiveSeenAt = undefined
        }
        await writeJsonDurable(path.join(staging, 'sessions.json'), stored, { mode: 0o600, pretty: false })
        await this.restoreTables(ws, task, stored.map((r) => r.info.id), staging)
        await fs.rename(staging, destination)
        const restored = []
        for (const r of stored) restored.push({ ...r, log: await store.readSessionLog(ws, task, r.info.id) })
        this.kernel.sessions.restore(restored)
        this.kernel.sessions.setTaskCap(ws, task, (await store.getTask(ws, task)).maxConcurrentSessions)
        await syncDirectory(store.wsDir(ws))
        // The restored scope is durable before the compressed copy is removed.
        await this.removeFiles(id)
        this.kernel.bus.emit('tree.changed', undefined)
      } finally { await store.rmTree(staging) }
    })
  }

  private async restoreSessionIntoScope(meta: ScopeArchive): Promise<void> {
    const { workspace: ws, task, id } = meta
    await this.kernel.sessions.withTaskFrozen(ws, task, async () => {
      if (this.kernel.sessions.taskHasPendingWork(ws, task)) throw new Error('Wait for this scope to become idle before restoring a session')
      const staging = await fs.mkdtemp(path.join(root(), '.restore-'))
      try {
        await unpackScope(dataFile(id), staging)
        const records = JSON.parse(await fs.readFile(path.join(staging, 'sessions.json'), 'utf8')) as Awaited<ReturnType<typeof store.readSessions>>
        if (records.length !== 1 || records[0]?.info.id !== meta.sessions[0]?.id) throw new Error('Invalid session archive')
        const record = records[0]!
        const sessionId = validId(record.info.id)
        if (this.kernel.sessions.sessionInfo(sessionId)) throw new Error('This session already exists')
        await this.kernel.sessions.flushTask(ws, task)
        delete record.info.container
        record.info.lastActivityAt = new Date().toISOString()
        record.info.archiveSeenAt = undefined
        const sessionDir = path.join(store.taskDir(ws, task), 'sessions')
        await fs.mkdir(sessionDir, { recursive: true })
        await fs.copyFile(path.join(staging, 'sessions', `${sessionId}.jsonl`), path.join(sessionDir, `${sessionId}.jsonl`))
        const scratch = path.join(staging, '.multirepo', sessionId)
        if (existsSync(scratch)) await fs.cp(scratch, store.sessionScratchDir(ws, task, sessionId), { recursive: true, verbatimSymlinks: true })
        await this.restoreTables(ws, task, [sessionId])
        await store.writeSessions(ws, task, [...await store.readSessions(ws, task), record])
        this.kernel.sessions.restore([{ ...record, log: await store.readSessionLog(ws, task, sessionId) }])
        await this.removeFiles(id)
        this.kernel.bus.emit('tree.changed', undefined)
      } finally { await store.rmTree(staging) }
    })
  }

  private async eligible(ws: string, task: string): Promise<boolean> {
    if (this.kernel.sessions.taskHasPendingWork(ws, task)) return false
    if (this.kernel.terminals.list().some((t) => t.workspace === ws && t.task === task)) return false
    const settings = await this.settings()
    if (!settings.autoArchive || !canAutoArchive(this.kernel.sessions.listForTask(ws, task), Date.now() - settings.inactiveHours * 3_600_000)) return false
    const clones = await store.taskClones(ws, task)
    const repos = await getTaskChanges(ws, task)
    // getTaskChanges skips repositories it cannot inspect. Fail closed.
    return repos.length === clones.length && repos.every((r) => !isActionable(r) && !r.conflicted)
  }

  runPolicy(): Promise<{ archived: number; deleted: number; errors: string[] }> {
    this.policyInFlight ??= this.policy().finally(() => { this.policyInFlight = undefined })
    return this.policyInFlight
  }

  private async policy(): Promise<{ archived: number; deleted: number; errors: string[] }> {
    await this.kernel.ready
    const result = { archived: 0, deleted: 0, errors: [] as string[] }
    const settings = await this.settings()
    if (settings.autoArchive) {
      for (const ws of (await this.kernel.tree()).workspaces) for (const task of ws.tasks) {
        try {
          if (!this.busy && await this.eligible(ws.name, task.name)) {
            await this.archive(ws.name, task.name, true)
            result.archived++
          }
        } catch (e) {
          result.errors.push(`${ws.name} / ${task.name}: ${e instanceof Error ? e.message : String(e)}`)
          log.warn('archive.auto.fail', { ws: ws.name, task: task.name, err: e })
        }
      }
    }
    for (const archive of await this.list()) {
      // Re-read immediately before each deletion: disabling the policy takes
      // effect during a long pass, and delete() re-checks the pin under lock.
      const latest = await this.settings()
      if (!latest.autoDelete) break
      if (!archive.pinned && Date.parse(archive.archivedAt) < Date.now() - latest.retentionDays * 86_400_000) {
        try { await this.delete(archive.id); result.deleted++ }
        catch (e) {
          result.errors.push(`${archive.workspace} / ${archive.task}: ${e instanceof Error ? e.message : String(e)}`)
          log.warn('archive.retention.fail', { id: archive.id, err: e })
        }
      }
    }
    return result
  }

  start(): void {
    const tick = (): void => { void this.runPolicy().catch((e: unknown) => log.warn('archive.policy.fail', { err: e })) }
    setTimeout(tick, 60_000).unref()
    setInterval(tick, 5 * 60_000).unref()
  }
}
