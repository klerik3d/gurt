import { randomUUID } from 'node:crypto'
import os from 'node:os'
import type { IPty, spawn } from 'node-pty'
import type { TerminalInfo, TerminalOutput, TerminalSnapshot } from '../shared/terminal'
import { taskDir, taskExists } from './store'

type Pty = Pick<IPty, 'onData' | 'onExit' | 'write' | 'resize' | 'kill'>
type Spawn = (...args: Parameters<typeof spawn>) => Pty
interface Entry {
  info: TerminalInfo
  pty: Pty
  sequence: number
  output: string[]
  size: number
  subscriptions: { dispose(): void }[]
}

// Only used while a renderer attaches. Mounted xterms retain their own screen,
// scrollback and selection even while hidden; none of this is written to disk.
const REPLAY_LIMIT = 1024 * 1024
const scopeKey = (ws: string, task: string) => JSON.stringify([ws, task])

function checkName(name: string): void {
  if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..' || /[/\\\0]/.test(name))
    throw new Error('Invalid terminal scope')
}

function dimensions(cols: number, rows: number): void {
  if (![cols, rows].every((n) => Number.isInteger(n) && n >= 2 && n <= 1000))
    throw new Error('Invalid terminal size')
}

export class TerminalManager {
  private entries = new Map<string, Entry>()
  private pending = new Map<string, Promise<TerminalInfo>>()
  private blocked = new Set<string>()
  private generations = new Map<string, number>()
  private nextNumber = new Map<string, number>()
  private closed = false

  constructor(
    private changed: (sessions: TerminalInfo[]) => void,
    private output: (event: TerminalOutput) => void,
    private loadPty: () => Promise<Spawn> = async () => (await import('node-pty')).spawn
  ) {}

  list(): TerminalInfo[] {
    return [...this.entries.values()].map((e) => ({ ...e.info }))
  }

  private checkScope(ws: string, task: string): void {
    checkName(ws)
    checkName(task)
    if (this.closed || this.blocked.has(ws) || this.blocked.has(scopeKey(ws, task)))
      throw new Error('Terminal scope is being removed or renamed')
    if (!taskExists(ws, task)) throw new Error('Terminal scope no longer exists')
  }

  /** Concurrent panel openings share one creation; the + button creates another. */
  async ensure(ws: string, task: string): Promise<TerminalInfo> {
    this.checkScope(ws, task)
    const existing = this.list().find((s) => s.workspace === ws && s.task === task)
    if (existing) return existing
    const key = scopeKey(ws, task)
    const pending = this.pending.get(key)
    if (pending) return pending
    const request = this.create(ws, task)
    this.pending.set(key, request)
    try {
      return await request
    } finally {
      if (this.pending.get(key) === request) this.pending.delete(key)
    }
  }

  async create(ws: string, task: string): Promise<TerminalInfo> {
    this.checkScope(ws, task)
    const key = scopeKey(ws, task)
    const generation = this.generations.get(key) ?? 0
    const workspaceGeneration = this.generations.get(ws) ?? 0
    const spawn = await this.loadPty()
    this.checkScope(ws, task)
    if ((this.generations.get(key) ?? 0) !== generation ||
        (this.generations.get(ws) ?? 0) !== workspaceGeneration)
      throw new Error('Terminal scope changed while opening')
    const shell = process.platform === 'win32'
      ? process.env['COMSPEC'] || 'cmd.exe'
      : process.env['SHELL'] || os.userInfo().shell || '/bin/sh'
    const env: NodeJS.ProcessEnv = {
      ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'gurt'
    }
    // A shell inside gurt must not attach to the launching terminal's session
    // or source its terminal-specific startup integration (notably on macOS).
    for (const key of ['ELECTRON_RUN_AS_NODE', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID', 'ITERM_SESSION_ID'])
      delete env[key]
    const pty = spawn(shell, process.platform === 'win32' ? [] : ['-l'], {
      name: 'xterm-256color', cwd: taskDir(ws, task), cols: 80, rows: 24, env
    })
    const number = this.nextNumber.get(key) ?? 1
    this.nextNumber.set(key, number + 1)
    const info: TerminalInfo = {
      id: randomUUID(), workspace: ws, task, title: `Terminal ${number}`,
      cols: 80, rows: 24, exitCode: null
    }
    const entry: Entry = { info, pty, sequence: 0, output: [], size: 0, subscriptions: [] }
    this.entries.set(info.id, entry)
    entry.subscriptions.push(pty.onData((data) => {
      if (!this.entries.has(info.id)) return
      entry.output.push(data)
      entry.size += data.length
      while (entry.size > REPLAY_LIMIT && entry.output.length > 1)
        entry.size -= entry.output.shift()!.length
      // An unusually large single write must not defeat the bound.
      if (entry.size > REPLAY_LIMIT) {
        entry.output = [data.slice(-REPLAY_LIMIT)]
        entry.size = REPLAY_LIMIT
      }
      this.output({ id: info.id, sequence: ++entry.sequence, data })
    }), pty.onExit(({ exitCode }) => {
      if (!this.entries.has(info.id)) return
      info.exitCode = exitCode
      this.changed(this.list())
    }))
    this.changed(this.list())
    return { ...info }
  }

  snapshot(id: string): TerminalSnapshot {
    const entry = this.get(id)
    return { info: { ...entry.info }, sequence: entry.sequence, data: entry.output.join('') }
  }

  private get(id: string): Entry {
    const entry = this.entries.get(id)
    if (!entry) throw new Error('Terminal session no longer exists')
    return entry
  }

  write(id: string, data: string): void {
    const entry = this.get(id)
    if (typeof data !== 'string' || data.length > REPLAY_LIMIT) throw new Error('Invalid terminal input')
    if (entry.info.exitCode !== null) return
    entry.pty.write(data)
  }

  rename(id: string, title: string): void {
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 80 || /\p{Cc}/u.test(title))
      throw new Error('Terminal name must contain 1–80 characters without control characters')
    this.get(id).info.title = title.trim()
    this.changed(this.list())
  }

  resize(id: string, cols: number, rows: number): void {
    dimensions(cols, rows)
    const entry = this.get(id)
    if (entry.info.exitCode !== null) return
    entry.pty.resize(cols, rows)
    entry.info.cols = cols
    entry.info.rows = rows
  }

  close(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    for (const sub of entry.subscriptions) sub.dispose()
    if (entry.info.exitCode === null) entry.pty.kill()
    this.changed(this.list())
  }

  /** Blocks new shells throughout async deletion/rename, including pending spawns. */
  async withScopeBlocked<T>(ws: string, task: string | undefined, action: () => Promise<T>): Promise<T> {
    const key = task === undefined ? ws : scopeKey(ws, task)
    if (this.blocked.has(key)) throw new Error('Terminal scope is already changing')
    this.blocked.add(key)
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1)
    try {
      return await action()
    } finally {
      this.blocked.delete(key)
    }
  }

  dropScope(ws: string, task?: string): void {
    for (const key of this.nextNumber.keys()) {
      const [workspace, scope] = JSON.parse(key) as [string, string]
      if (workspace === ws && (task === undefined || scope === task)) this.nextNumber.delete(key)
    }
    for (const session of this.list())
      if (session.workspace === ws && (task === undefined || session.task === task)) this.close(session.id)
  }

  renameScope(ws: string, task: string, newName: string): void {
    const key = scopeKey(ws, task)
    const next = this.nextNumber.get(key)
    if (next !== undefined) this.nextNumber.set(scopeKey(ws, newName), next)
    this.nextNumber.delete(key)
    for (const entry of this.entries.values())
      if (entry.info.workspace === ws && entry.info.task === task) entry.info.task = newName
    this.changed(this.list())
  }

  dispose(): void {
    this.closed = true
    this.nextNumber.clear()
    for (const id of this.entries.keys()) this.close(id)
  }
}
