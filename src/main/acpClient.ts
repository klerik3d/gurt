// The ACP *client* methods gurt answers for one masked session — `fs/read_text_file`,
// `fs/write_text_file` and `terminal/*` (docs/requirements-pii-mask.md §9).
//
// Gurt used to tell every agent it supported none of them, so agents read, wrote
// and ran things for themselves and nothing crossed a seam gurt could see. For a
// session that masks, gurt now advertises them and does the work itself, in the
// session's container, with the same barrier the chat has: what goes *to* the
// agent (a file's content, a command's output) is encoded, what comes *from* it
// (a file's new content, a command line) is revealed. That is what keeps an
// agent from writing `[email:1]` into your code, or from reading the real value
// back out of a file.
//
// This module is transport-free on purpose: the caller hands it an `exec` that
// runs an argv in the container (`provision.spawnInContainer` in the app, a
// plain local spawn in the test), and the encode/reveal pair.
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  FS_READ_REQUEST,
  FS_WRITE_REQUEST,
  TERMINAL_CREATE_REQUEST,
  TERMINAL_REF_REQUEST,
  parseOrDrop
} from './acp'
import { RpcError } from './jsonrpc'
import { createLogger } from './log'

const log = createLogger('acp-client')

/** ACP's "resource not found" (a missing file). */
const NOT_FOUND = -32002
const INVALID_PARAMS = -32602

/** A file bigger than this is not something to hand an agent as text. */
const MAX_READ_BYTES = 8 * 1024 * 1024
/** Default `outputByteLimit` when the agent names none. */
const DEFAULT_OUTPUT_LIMIT = 1024 * 1024
/** One session never holds more live terminals than this. */
const MAX_TERMINALS = 16

export type Exec = (argv: string[], env?: Record<string, string>) => ChildProcessWithoutNullStreams

export interface AcpClientDeps {
  /** Gurt's session id and the agent kind — for the usage log only. */
  session: string
  agent: string
  /** The agent's working directory in the container; relative paths resolve there. */
  cwd: string
  exec: Exec
  /** real → token; rejects when the detector is down (fail closed). */
  encode: (text: string) => Promise<string>
  /** token → real. */
  reveal: (text: string) => string
}

type Handler = (params: unknown) => Promise<unknown>

export interface AcpClient {
  /** Method name → handler, ready for `peer.onRequest`. */
  handlers: Record<string, Handler>
  /** The connection is gone: stop whatever is still running. */
  dispose(): void
}

interface Term {
  child: ChildProcessWithoutNullStreams
  text: string
  bytes: number
  limit: number
  truncated: boolean
  exit?: { exitCode: number | null; signal: string | null }
  waiters: Array<() => void>
}

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8')

/** Drop characters from the front until at most `limit` bytes remain. */
function trimFront(text: string, limit: number): string {
  let bytes = byteLength(text)
  let i = 0
  while (bytes > limit && i < text.length) {
    const cp = text.codePointAt(i)!
    const unit = cp > 0xffff ? 2 : 1
    bytes -= byteLength(text.slice(i, i + unit))
    i += unit
  }
  return text.slice(i)
}

/** Collect a process's stdout to a string, bounded; stderr is returned beside it. */
function collect(
  child: ChildProcessWithoutNullStreams,
  maxBytes: number
): Promise<{ stdout: string; stderr: string; code: number | null; tooBig: boolean }> {
  return new Promise((resolve, reject) => {
    const out = new StringDecoder('utf8')
    const err = new StringDecoder('utf8')
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let tooBig = false
    child.stdout.on('data', (d: Buffer) => {
      bytes += d.length
      if (bytes > maxBytes) {
        tooBig = true
        child.kill()
        return
      }
      stdout += out.write(d)
    })
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 4096) stderr += err.write(d)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout: stdout + out.end(), stderr, code, tooBig }))
  })
}

export function createAcpClient(deps: AcpClientDeps): AcpClient {
  const terminals = new Map<string, Term>()

  const use = (method: string, extra?: Record<string, unknown>): void =>
    // Which adapters actually call these is the open question this stage
    // answers — a method name and a size, never a path or any content.
    log.info('acp.client.call', { s: deps.session, agent: deps.agent, method, ...extra })

  const resolvePath = (p: string): string =>
    path.posix.isAbsolute(p) ? path.posix.normalize(p) : path.posix.join(deps.cwd, p)

  const params = <T>(schema: Parameters<typeof parseOrDrop<T>>[0], raw: unknown, what: string): T => {
    const p = parseOrDrop(schema, raw, what)
    if (!p) throw new RpcError(INVALID_PARAMS, `invalid params for ${what}`)
    return p
  }

  function terminal(raw: unknown, what: string): { id: string; t: Term } {
    const { terminalId } = params(TERMINAL_REF_REQUEST, raw, what)
    const t = terminals.get(terminalId)
    if (!t) throw new RpcError(NOT_FOUND, `unknown terminal ${terminalId}`)
    return { id: terminalId, t }
  }

  /**
   * What the agent may see of a terminal's output right now. A running process
   * has a half-written last line — `jane@exa` before `mple.com` arrives — and
   * a detector cannot recognise half a value, so until the process is done only
   * whole lines are encoded and released.
   */
  async function visibleOutput(t: Term): Promise<string> {
    let text = t.text
    if (!t.exit) {
      const nl = text.lastIndexOf('\n')
      text = nl < 0 ? '' : text.slice(0, nl + 1)
    }
    return deps.encode(text)
  }

  const handlers: Record<string, Handler> = {
    'fs/read_text_file': async (raw) => {
      const p = params(FS_READ_REQUEST, raw, 'fs/read_text_file')
      const child = deps.exec(['cat', '--', resolvePath(p.path)])
      child.stdin.end()
      const r = await collect(child, MAX_READ_BYTES)
      use('fs/read_text_file', { bytes: byteLength(r.stdout), code: r.code })
      if (r.tooBig) throw new Error(`file is larger than ${MAX_READ_BYTES / (1024 * 1024)} MiB`)
      if (r.code !== 0) {
        throw /no such file|not a directory/i.test(r.stderr)
          ? new RpcError(NOT_FOUND, 'file not found')
          : new Error(`could not read the file (exit ${r.code ?? 'signal'}): ${r.stderr.trim()}`)
      }
      let content = r.stdout
      if (p.line || p.limit) {
        const lines = content.split('\n')
        const from = (p.line ?? 1) - 1
        content = lines.slice(from, p.limit ? from + p.limit : undefined).join('\n')
      }
      return { content: await deps.encode(content) }
    },

    'fs/write_text_file': async (raw) => {
      const p = params(FS_WRITE_REQUEST, raw, 'fs/write_text_file')
      // Tokens the agent wrote become the values they stand for before they
      // touch the disk — the file is the user's, not the agent's.
      const content = deps.reveal(p.content)
      const child = deps.exec([
        'sh',
        '-c',
        'mkdir -p -- "$(dirname -- "$0")" && cat > "$0"',
        resolvePath(p.path)
      ])
      const done = collect(child, 4096)
      child.stdin.end(content)
      const r = await done
      use('fs/write_text_file', { bytes: byteLength(content), code: r.code })
      if (r.code !== 0)
        throw new Error(`could not write the file (exit ${r.code ?? 'signal'}): ${r.stderr.trim()}`)
      return null
    },

    'terminal/create': async (raw) => {
      const p = params(TERMINAL_CREATE_REQUEST, raw, 'terminal/create')
      if (terminals.size >= MAX_TERMINALS) throw new Error('too many live terminals in this session')
      const command = deps.reveal(p.command)
      const args = (p.args ?? []).map(deps.reveal)
      const cwd = p.cwd ? resolvePath(p.cwd) : deps.cwd
      // `command` is an executable with `args`, but agents also hand over a
      // whole command line with none; a bare string with spaces goes to a shell.
      const argv =
        args.length === 0 && /\s/.test(command)
          ? ['sh', '-c', 'cd -- "$0" && exec sh -c "$1"', cwd, command]
          : ['sh', '-c', 'cd -- "$0" && exec "$@"', cwd, command, ...args]
      const env: Record<string, string> = {}
      for (const e of p.env ?? []) env[e.name] = deps.reveal(e.value)
      const child = deps.exec(argv, env)
      const t: Term = {
        child,
        text: '',
        bytes: 0,
        limit: p.outputByteLimit ?? DEFAULT_OUTPUT_LIMIT,
        truncated: false,
        waiters: []
      }
      const decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') }
      const feed = (text: string): void => {
        t.text += text
        t.bytes += byteLength(text)
        if (t.bytes > t.limit) {
          t.text = trimFront(t.text, t.limit)
          t.bytes = byteLength(t.text)
          t.truncated = true
        }
      }
      child.stdout.on('data', (d: Buffer) => feed(decoders.out.write(d)))
      child.stderr.on('data', (d: Buffer) => feed(decoders.err.write(d)))
      const finish = (exitCode: number | null, signal: string | null): void => {
        if (t.exit) return
        feed(decoders.out.end() + decoders.err.end())
        t.exit = { exitCode, signal }
        for (const w of t.waiters.splice(0)) w()
      }
      child.on('error', (e) => {
        feed(`${e.message}\n`)
        finish(null, null)
      })
      child.on('close', (code, signal) => finish(code, signal))
      child.stdin.end()
      const id = randomUUID()
      terminals.set(id, t)
      use('terminal/create')
      return { terminalId: id }
    },

    'terminal/output': async (raw) => {
      const { t } = terminal(raw, 'terminal/output')
      use('terminal/output')
      return {
        output: await visibleOutput(t),
        truncated: t.truncated,
        ...(t.exit ? { exitStatus: t.exit } : {})
      }
    },

    'terminal/wait_for_exit': async (raw) => {
      const { t } = terminal(raw, 'terminal/wait_for_exit')
      use('terminal/wait_for_exit')
      if (!t.exit) await new Promise<void>((resolve) => t.waiters.push(resolve))
      return t.exit
    },

    'terminal/kill': async (raw) => {
      const { t } = terminal(raw, 'terminal/kill')
      use('terminal/kill')
      if (!t.exit) t.child.kill()
      return null
    },

    'terminal/release': async (raw) => {
      const { id, t } = terminal(raw, 'terminal/release')
      use('terminal/release')
      if (!t.exit) t.child.kill()
      terminals.delete(id)
      return null
    }
  }

  return {
    handlers,
    dispose(): void {
      for (const t of terminals.values()) if (!t.exit) t.child.kill()
      terminals.clear()
    }
  }
}
