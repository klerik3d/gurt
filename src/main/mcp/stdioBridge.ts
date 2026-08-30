// The stdio bridge: a local MCP server (a process on *this* machine, speaking
// JSON-RPC over its own stdin/stdout) exposed as the same
// `POST /mcp/<token>` HTTP listener gurt's built-in servers are
// (docs/requirements-mcp-stdio.md §4).
//
// Everything downstream of here already knows how to reach a host listener: the
// proxy routes `kind: 'host'` upstreams, and the agent only ever sees a proxy
// URL. So the whole of "gurt supports stdio MCP" is this file turning one shape
// of transport into the other — no change to `resources/proxy/gurt-proxy.mjs`,
// and no new path into the session container.
//
// Three things this module owns, in the order they matter:
//
//   1. **Framing.** MCP's stdio transport is one JSON-RPC message per line.
//      `stdioFramer` is the whole of it, and is pure — it takes bytes and emits
//      messages, so it is testable against two fake streams
//      (`scripts/mcp-stdio.test.mjs`) without spawning anything.
//   2. **Id remapping.** One process is shared by every session that selected
//      the entry (§6), so two clients will happily both send request id `1`.
//      Every request is renumbered onto a bridge-wide sequence on the way down
//      and restored on the way back, which is what keeps one session from
//      reading another's reply.
//   3. **Spawning.** An `npm` entry is installed once under `~/.gurt/mcp/<id>/`
//      and run with gurt's own node; a `command` entry is resolved against an
//      explicitly augmented PATH. Both of those exist because a GUI app on
//      macOS does not inherit the shell's PATH (§4.2, §4.3).
//
// The child's environment is never logged. It is where the credential link
// lands (§3.4), and a stdio server that prints its own config to stderr is not
// hypothetical.

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs/promises'
import { accessSync, statSync, constants as FS } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { McpLocalEntry, McpNpmEntry } from '../../shared/mcp'
import { npmPackageSpec } from '../../shared/mcp'
import { gurtRoot } from '../store'
import { lineBuffer } from '../provision'
import { createLogger } from '../log'

const log = createLogger('mcp')

/** How long a single MCP request may wait on the child before the bridge
 *  answers it itself. Matches the github MCP's tool bound: long enough for a
 *  cluster call or a cold index, short enough that a wedged server does not
 *  hang the agent's turn forever. */
const REQUEST_TIMEOUT_MS = 120_000

/** Bound on one POST body. An MCP request carrying a whole file is normal; a
 *  gigabyte is not, and the body is read into memory to be framed. */
const MAX_BODY_BYTES = 32 * 1024 * 1024

/** Bound on the unterminated remainder `stdioFramer` buffers between chunks —
 *  a child that never writes '\n' must not grow it without bound. Larger than
 *  the log's line cap because these are protocol payloads, not log lines. */
const MAX_FRAME_BYTES = 32 * 1024 * 1024

/** SIGTERM, then this long, then SIGKILL (§6). */
const STOP_GRACE_MS = 3_000

/** Directories a GUI-launched process is missing from its PATH on macOS, and
 *  where a user's own tools live on Linux. Appended, never prepended: the
 *  user's PATH wins where it has an opinion. */
const EXTRA_PATH_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.cargo', 'bin'),
  '/usr/bin',
  '/bin'
]

/** PATH with {@link EXTRA_PATH_DIRS} on the end, de-duplicated. */
export function hostPath(env: NodeJS.ProcessEnv = process.env): string {
  const seen = new Set<string>()
  const dirs: string[] = []
  for (const dir of [...(env['PATH'] ?? '').split(path.delimiter), ...EXTRA_PATH_DIRS]) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    dirs.push(dir)
  }
  return dirs.join(path.delimiter)
}

/**
 * Where a command name actually is, or null. Synchronous and eager on purpose:
 * this is what the *save* path calls, so "there is no `uvx` on this machine"
 * is a rejected registry entry rather than a session that fails to start an
 * hour later (§4.3).
 *
 * A name containing a separator is a path and is only checked for existence; a
 * bare name is searched along {@link hostPath}. `PATHEXT` is not consulted —
 * gurt does not run on Windows.
 */
export function resolveHostCommand(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  // `X_OK` alone is not enough: every directory on PATH is executable, so a
  // blank command would "resolve" to the directory it was joined onto.
  const executable = (file: string): boolean => {
    try {
      accessSync(file, FS.X_OK)
      return statSync(file).isFile()
    } catch {
      return false
    }
  }
  if (!command.trim()) return null
  if (command.includes('/')) {
    const abs = path.resolve(command)
    return executable(abs) ? abs : null
  }
  for (const dir of hostPath(env).split(path.delimiter)) {
    const candidate = path.join(dir, command)
    if (executable(candidate)) return candidate
  }
  return null
}

/**
 * Throw unless this entry can actually be launched on this machine — the
 * save-time half of the PATH problem (§4.3).
 *
 * Only a `command` entry has one: an `npm` entry runs with gurt's own node,
 * which is always there, and its package is installed on first use. A command
 * is whatever the user typed, and the failure it produces at session start
 * ("spawn uvx ENOENT", an hour later, in a log) is exactly the one worth moving
 * to the moment the entry is saved.
 *
 * Deliberately not called at start time: a tool the user later uninstalled
 * still fails there, and it fails with the same message
 * (`planLaunch` resolves through the same function).
 */
export function checkMcpCommand(entry: McpLocalEntry): void {
  if (entry.kind !== 'command') return
  if (resolveHostCommand(entry.command)) return
  throw new Error(`mcp server "${entry.id}": ${missingCommand(entry.command)}`)
}

/** The one sentence a missing command produces, wherever it is noticed. */
const missingCommand = (command: string): string =>
  `command "${command}" was not found on this machine — install it, or give the absolute path to it`


// --- framing ---------------------------------------------------------------

/** One JSON-RPC message, in the only shape this module reads of it. */
export interface JsonRpcMessage {
  jsonrpc?: unknown
  id?: string | number | null
  method?: unknown
  result?: unknown
  error?: unknown
  [key: string]: unknown
}

/**
 * Split a child's stdout into JSON-RPC messages: one per line, exactly as the
 * MCP stdio transport specifies.
 *
 * `onNoise` gets every line that is not a message — servers that log to stdout
 * are common enough that dropping those silently would make a working server
 * look like a broken one. A chunk boundary landing mid multi-byte sequence is
 * carried across chunks by the decoder, the same way a partial line is carried
 * by `rest` (`lineBuffer` in provision.ts does this for log output).
 */
export function stdioFramer(
  onMessage: (msg: JsonRpcMessage) => void,
  onNoise: (line: string) => void = () => {}
): { push: (chunk: Buffer | string) => void; flush: () => void } {
  const utf8 = new StringDecoder('utf8')
  let rest = ''
  const line = (raw: string): void => {
    const text = raw.trim()
    if (!text) return
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      onNoise(text)
      return
    }
    if (typeof parsed !== 'object' || parsed === null) {
      onNoise(text)
      return
    }
    // A batch arrives as one line too, and is delivered message by message —
    // every consumer here is keyed by id, so the grouping carries no meaning.
    if (Array.isArray(parsed)) {
      for (const item of parsed as unknown[])
        if (typeof item === 'object' && item !== null) onMessage(item as JsonRpcMessage)
      return
    }
    onMessage(parsed as JsonRpcMessage)
  }
  return {
    push(chunk) {
      rest += typeof chunk === 'string' ? chunk : utf8.write(chunk)
      const lines = rest.split('\n')
      rest = lines.pop() ?? ''
      for (const raw of lines) line(raw)
      // A line-less stream is a protocol violation, not a message: drop the
      // remainder rather than buffer it forever.
      if (rest.length > MAX_FRAME_BYTES) {
        onNoise(`dropped ${rest.length} bytes with no newline`)
        rest = ''
      }
    },
    flush() {
      const last = rest + utf8.end()
      rest = ''
      if (last.trim()) line(last)
    }
  }
}

/** A message as the stdio transport writes it: compact JSON, one line. Safe by
 *  construction — `JSON.stringify` escapes every newline in the payload. */
export const encodeStdioMessage = (msg: JsonRpcMessage): string => `${JSON.stringify(msg)}\n`

/** Whether a message is a *request* — the only kind that gets a reply, and so
 *  the only kind the bridge has to renumber and wait for. A response carries an
 *  id but no method; a notification carries a method but no id. */
export const isJsonRpcRequest = (msg: JsonRpcMessage): boolean =>
  typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null

// --- installing an npm entry ------------------------------------------------

/** Where gurt keeps one local server's installed package. Per entry id, not per
 *  package: two entries of the same package with different versions are two
 *  servers, and the id is what the registry, the route and the selection all
 *  already agree on. */
export const mcpInstallDir = (id: string): string => path.join(gurtRoot, 'mcp', id)

/** What the last install put there, next to it. Read before every start: a
 *  matching stamp is what makes `@latest` a one-time network call rather than a
 *  fetch on every session start (§4.2). */
const stampPath = (id: string): string => path.join(mcpInstallDir(id), 'gurt-install.json')

interface InstallStamp {
  /** `name@version` exactly as it was installed. */
  spec: string
  /** Absolute path of the JS entry point to hand node. */
  script: string
}

async function readStamp(id: string): Promise<InstallStamp | null> {
  try {
    const raw = JSON.parse(await fs.readFile(stampPath(id), 'utf8')) as Partial<InstallStamp>
    if (typeof raw.spec !== 'string' || typeof raw.script !== 'string') return null
    await fs.access(raw.script)
    return { spec: raw.spec, script: raw.script }
  } catch {
    return null
  }
}

/** Run npm once, in the entry's own directory. */
function runNpm(args: string[], cwd: string): Promise<void> {
  const npm = resolveHostCommand('npm')
  if (!npm)
    return Promise.reject(
      new Error(
        'npm was not found on this machine — gurt needs it once, to install the package under ~/.gurt/mcp'
      )
    )
  return new Promise((resolve, reject) => {
    const child = spawn(npm, args, {
      cwd,
      env: { ...process.env, PATH: hostPath(), npm_config_yes: 'true' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let tail = ''
    const keep = (chunk: Buffer): void => {
      tail = `${tail}${chunk.toString('utf8')}`.slice(-4000)
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`npm ${args[0]} failed (exit ${code})\n${tail.trim()}`))
    )
  })
}

/** The JS file a package's `bin` field points at, resolved through whatever
 *  symlink npm made. Spawned as `node <file>` rather than executed directly:
 *  the shebang in it says `#!/usr/bin/env node`, which is the PATH problem all
 *  over again. */
async function resolveBin(dir: string, pkg: string): Promise<string> {
  const pkgDir = path.join(dir, 'node_modules', ...pkg.split('/'))
  let manifest: { bin?: unknown; name?: unknown; main?: unknown }
  try {
    manifest = JSON.parse(await fs.readFile(path.join(pkgDir, 'package.json'), 'utf8')) as typeof manifest
  } catch {
    throw new Error(`package "${pkg}" installed but has no readable package.json`)
  }
  const bin = manifest.bin
  let rel: string | undefined
  if (typeof bin === 'string') rel = bin
  else if (bin && typeof bin === 'object') {
    const names = Object.keys(bin)
    // The bin named after the package wins; a single bin under any name is
    // unambiguous; more than one and gurt is not going to guess.
    const preferred = names.find((n) => n === pkg.split('/').pop()) ?? (names.length === 1 ? names[0] : undefined)
    if (!preferred)
      throw new Error(
        `package "${pkg}" ships several commands (${names.join(', ')}) — use a "command" entry to pick one`
      )
    rel = (bin as Record<string, string>)[preferred]
  }
  if (!rel) throw new Error(`package "${pkg}" ships no command to run`)
  return fs.realpath(path.join(pkgDir, rel))
}

/**
 * Make sure the entry's package is installed, and say what to run.
 *
 * Reinstalls only when the requested `name@version` differs from the stamp —
 * which is the answer to `@latest` resolving over the network on every single
 * start. A user who wants a newer `latest` re-saves the entry (phase 2 gives
 * that a button); a user who pins a version gets a reinstall when they change
 * it, and never otherwise.
 */
export async function ensureNpmPackage(entry: McpNpmEntry): Promise<string> {
  const dir = mcpInstallDir(entry.id)
  const spec = npmPackageSpec(entry)
  const stamp = await readStamp(entry.id)
  if (stamp?.spec === spec) return stamp.script

  await fs.mkdir(dir, { recursive: true })
  // A package.json of our own stops npm walking up out of ~/.gurt and
  // installing into somebody else's tree.
  await fs.writeFile(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: `gurt-mcp-${entry.id}`, private: true, version: '0.0.0' }, null, 2)}\n`
  )
  log.info('mcp.install', { id: entry.id, package: spec })
  await runNpm(['install', '--no-audit', '--no-fund', '--omit=dev', '--install-strategy=shallow', spec], dir)
  const script = await resolveBin(dir, entry.package)
  await fs.writeFile(stampPath(entry.id), `${JSON.stringify({ spec, script } satisfies InstallStamp, null, 2)}\n`)
  return script
}

/**
 * Forget what is installed for `id`, so the next start installs it again.
 *
 * The stamp goes, the directory stays: `npm install` will overwrite the tree in
 * place, and removing `node_modules` out from under a server that is still
 * running (§6 — one process, several sessions) would break it for the sessions
 * holding it. Which is also why this only takes effect at the next start: gurt
 * does not restart a local server under its holders (§10).
 */
export async function clearNpmInstall(id: string): Promise<void> {
  await fs.rm(stampPath(id), { force: true })
}

// --- the child process ------------------------------------------------------

/** What to spawn for one entry, once everything host-specific is resolved. */
interface Launch {
  file: string
  args: string[]
  cwd: string
  /** Set for an `npm` entry: gurt's own binary is Electron, and it only behaves
   *  as node when this is in the environment. */
  runAsNode: boolean
  /** For the log — the package or command, never the argv's values. */
  what: string
}

async function planLaunch(entry: McpLocalEntry): Promise<Launch> {
  if (entry.kind === 'npm') {
    const script = await ensureNpmPackage(entry)
    return {
      file: process.execPath,
      args: [script, ...(entry.args ?? [])],
      cwd: mcpInstallDir(entry.id),
      runAsNode: true,
      what: npmPackageSpec(entry)
    }
  }
  const file = resolveHostCommand(entry.command)
  if (!file) throw new Error(missingCommand(entry.command))
  return {
    file,
    args: [...(entry.args ?? [])],
    cwd: entry.cwd || os.homedir(),
    runAsNode: false,
    what: entry.command
  }
}

/**
 * The child's environment: gurt's own, with the PATH problem fixed, plus the
 * entry's `env` and its resolved credential on top.
 *
 * `ELECTRON_RUN_AS_NODE` is set for an npm entry and *deleted* for a command
 * one — gurt's own process may be running with it set, and inheriting it would
 * quietly change how any Electron-based child behaves.
 */
function childEnv(entry: McpLocalEntry, extra: Record<string, string>, runAsNode: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: hostPath() }
  // Electron injects these into its own children; a bare node process reading
  // them is at best confused.
  delete env['ELECTRON_RUN_AS_NODE']
  delete env['NODE_OPTIONS']
  if (runAsNode) env['ELECTRON_RUN_AS_NODE'] = '1'
  return { ...env, ...(entry.env ?? {}), ...extra }
}

interface Pending {
  /** The id the client used, restored on the way back. */
  original: string | number
  settle: (msg: JsonRpcMessage) => void
  timer: NodeJS.Timeout
}

/** A live child plus everything needed to talk to it. */
interface Child {
  proc: ChildProcess
  exited: Promise<void>
  alive: boolean
}

/**
 * One local MCP server, bridged. Created per *registry entry* and shared by
 * every session that selected it (§6) — the sharing is why ids are remapped and
 * why nothing here is keyed by session.
 */
export interface StdioBridge {
  id: string
  /** Resolves to the URL the proxy's `host` upstream points at, once the
   *  listener is up. Rejects if the child could not be launched at all. */
  ready: Promise<string>
  /** Set once `ready` resolves — the stop log wants the port, never the URL,
   *  which carries the bridge's token. */
  port?: number
  /** SIGTERM, grace, SIGKILL; then close the listener. Idempotent. */
  stop: () => Promise<void>
  /** The same teardown minus the waiting: close the listener and signal the
   *  child, now, synchronously. For `before-quit`, which cannot await — a
   *  promise scheduled there does not reliably get a turn before the process
   *  goes. No SIGKILL follow-up, because there is no later to run it in. */
  kill: () => void
}

/**
 * Start the bridge for one local entry.
 *
 * The child is spawned eagerly (so a broken entry fails at session start, where
 * it can be reported) and respawned lazily if it dies (so one crashing server
 * does not permanently break every session that selected it). A respawn loses
 * the MCP `initialize` handshake, which the client redoes on its next call —
 * the same thing that happens when a remote upstream restarts.
 */
export function startStdioBridge(entry: McpLocalEntry, extraEnv: Record<string, string> = {}): StdioBridge {
  const token = randomUUID()
  const prefix = `/mcp/${token}`
  let stopped = false
  let child: Child | null = null
  let launch: Promise<Launch> | null = null
  const pending = new Map<number, Pending>()
  let nextId = 1

  const failAll = (reason: string): void => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer)
      pending.delete(id)
      p.settle({ jsonrpc: '2.0', id: p.original, error: { code: -32000, message: reason } })
    }
  }

  const spawnChild = async (): Promise<Child> => {
    launch ??= planLaunch(entry)
    const plan = await launch
    // `planLaunch` can take a minute — it is where an `npm` entry's package is
    // installed — and a stop during it must not be undone by the spawn that
    // was already on its way. Without this, a probe that times out mid-install
    // (§4.6) leaves a server process nothing is holding.
    if (stopped) throw new Error('the local MCP server was stopped')
    const proc = spawn(plan.file, plan.args, {
      cwd: plan.cwd,
      env: childEnv(entry, extraEnv, plan.runAsNode),
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const rec: Child = { proc, alive: true, exited: Promise.resolve() }
    rec.exited = new Promise<void>((resolve) => {
      proc.once('close', (code, signal) => {
        rec.alive = false
        if (child === rec) child = null
        // A stop we asked for is not news; a death under load is.
        if (!stopped) log.warn('mcp.exit', { id: entry.id, command: plan.what, code, signal })
        failAll('the local MCP server exited')
        resolve()
      })
    })
    proc.on('error', (e) => {
      rec.alive = false
      log.error('internal.fail', { site: 'mcp-stdio-spawn', id: entry.id, err: e })
    })
    const frames = stdioFramer(
      (msg) => onUpstream(msg),
      // stdout noise is a real server's real diagnostics — worth having, not
      // worth the default log.
      (line) => log.debug('mcp.out', { id: entry.id, stream: 'stdout', line })
    )
    proc.stdout?.on('data', (chunk: Buffer) => frames.push(chunk))
    proc.stdout?.on('end', () => frames.flush())
    // stderr is diagnostics, not protocol — line-buffered, never framed, so a
    // server that happens to log JSON there is not silently swallowed.
    const errLines = lineBuffer((line) => log.debug('mcp.out', { id: entry.id, stream: 'stderr', line }))
    proc.stderr?.on('data', (chunk: Buffer) => errLines.push(chunk))
    proc.stderr?.on('end', () => errLines.flush())
    log.info('mcp.start', { id: entry.id, kind: entry.kind, command: plan.what, pid: proc.pid })
    return rec
  }

  /** Route one message off the child's stdout back to whoever is waiting. */
  const onUpstream = (msg: JsonRpcMessage): void => {
    const id = msg.id
    if (typeof id !== 'number' || !pending.has(id)) {
      // A server-initiated request (sampling, roots) or a stray notification.
      // A stateless POST bridge has no channel to deliver it on; dropping it is
      // the honest behaviour, and it is logged so it is not invisible (§4.5).
      if (typeof msg.method === 'string') log.debug('mcp.drop', { id: entry.id, method: msg.method })
      return
    }
    const p = pending.get(id)!
    clearTimeout(p.timer)
    pending.delete(id)
    p.settle({ ...msg, id: p.original })
  }

  /** The child, spawning it if this is the first call or it has died. */
  const ensureChild = async (): Promise<Child> => {
    if (child?.alive) return child
    const started = await spawnChild()
    child = started
    return started
  }

  /** Send one request down and resolve with its reply (or a JSON-RPC error). */
  const request = async (msg: JsonRpcMessage): Promise<JsonRpcMessage> => {
    const live = await ensureChild()
    const original = msg.id as string | number
    const id = nextId++
    return new Promise<JsonRpcMessage>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve({
          jsonrpc: '2.0',
          id: original,
          error: { code: -32000, message: `the local MCP server did not answer in ${REQUEST_TIMEOUT_MS}ms` }
        })
      }, REQUEST_TIMEOUT_MS)
      // `unref` so a pending call cannot hold the app open past a quit.
      timer.unref?.()
      pending.set(id, { original, settle: resolve, timer })
      live.proc.stdin?.write(encodeStdioMessage({ ...msg, id }))
    })
  }

  /** Send one notification down; there is nothing to wait for. */
  const notify = async (msg: JsonRpcMessage): Promise<void> => {
    const live = await ensureChild()
    live.proc.stdin?.write(encodeStdioMessage(msg))
  }

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          reject(new Error('request body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!req.url || !req.url.startsWith(prefix)) {
      res.writeHead(404).end()
      return
    }
    // No GET and no DELETE: there is no server→client stream to open and no
    // session state to delete, and a Streamable HTTP client reads 405 on the
    // GET as "this server does not offer one" and carries on.
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end()
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(await readBody(req))
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' }).end(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
      )
      return
    }
    const batch = Array.isArray(parsed)
    const messages = (batch ? parsed : [parsed]) as JsonRpcMessage[]
    const requests = messages.filter(isJsonRpcRequest)

    for (const msg of messages) if (!isJsonRpcRequest(msg)) await notify(msg)
    if (!requests.length) {
      // Notifications only — the transport's own answer, no body.
      res.writeHead(202).end()
      return
    }

    // Written as each reply lands rather than collected first: a batch whose
    // slowest call takes a minute should not hold back the ones that already
    // answered, and nothing here needs the whole set in hand.
    res.writeHead(200, { 'content-type': 'application/json' })
    if (batch) res.write('[')
    let written = 0
    await Promise.all(
      requests.map(async (msg) => {
        const reply = await request(msg)
        if (res.writableEnded) return
        res.write((written++ ? ',' : '') + JSON.stringify(reply))
      })
    )
    if (batch) res.write(']')
    res.end()
  }

  // Sync listener, async handler: node discards a request handler's return
  // value, so an async listener would drop a rejection instead of reporting it.
  const http = createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      log.error('internal.fail', { site: 'mcp-stdio-handler', id: entry.id, err: e })
      if (!res.headersSent) res.writeHead(500).end()
      else res.end()
    })
  })

  /** Everything teardown can do without waiting. Returns the child that was
   *  signalled, so the async path knows what to wait on. */
  const signalStop = (): Child | null => {
    if (stopped) return null
    stopped = true
    const live = child
    http.close()
    http.closeAllConnections()
    failAll('the local MCP server was stopped')
    if (live?.alive) {
      // stdin EOF first: a well-behaved stdio server treats it as "we are
      // done" and exits on its own, which is a cleaner death than a signal.
      live.proc.stdin?.end()
      live.proc.kill('SIGTERM')
    }
    log.info('mcp.stop', { id: entry.id, kind: entry.kind, port: bridge.port })
    return live?.alive ? live : null
  }

  const bridge: StdioBridge = {
    id: entry.id,
    ready: Promise.resolve(''),
    kill: () => void signalStop(),
    stop: async () => {
      const live = signalStop()
      if (!live) return
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        live.exited,
        new Promise<void>((r) => {
          timer = setTimeout(r, STOP_GRACE_MS)
          timer.unref?.()
        })
      ])
      if (timer) clearTimeout(timer)
      if (live.alive) live.proc.kill('SIGKILL')
    }
  }

  bridge.ready = new Promise<number>((resolve, reject) => {
    http.once('error', reject)
    // 0.0.0.0 (not loopback) so the session's proxy container can reach it via
    // host.docker.internal, exactly as the built-in servers are reached.
    http.listen(0, '0.0.0.0', () => {
      http.removeListener('error', reject)
      http.on('error', (e) => log.error('internal.fail', { site: 'mcp-stdio-server', id: entry.id, err: e }))
      resolve((http.address() as AddressInfo).port)
    })
  }).then(async (port) => {
    bridge.port = port
    // Eager: a package that will not install or a command that is not there
    // must fail here, where the session start can report it — not on the
    // agent's first tool call.
    await ensureChild()
    log.info('mcp.listen', { id: entry.id, kind: entry.kind, port })
    return `http://host.docker.internal:${port}/mcp/${token}`
  })
  // A failed launch closes the listener it would otherwise have leaked; the
  // rejection itself is the caller's to report.
  bridge.ready.catch(() => {
    http.close()
    http.closeAllConnections()
  })

  return bridge
}
