// The probe: start an MCP entry the way a session would, speak MCP to it, say
// what it answered, and stop it again (docs/requirements-mcp-stdio.md §4.6).
//
// `checkMcpEntryCredential` and `checkMcpCommand` already move two failures from
// "an hour later, in a log" to the moment an entry is saved. Everything else a
// local entry can get wrong — an `npm install` that fails, a package with no
// bin, a process that dies for want of authorization, a `credentialEnvVar` the
// server does not read, argv mangled out of a pasted snippet — is only found by
// running it. This module runs it.
//
// Three properties it has to have, and they are why it is a module rather than
// a few lines in `ipc.ts`:
//
//   1. **Outside the manager's refcount.** The probe starts its *own*
//      `StdioBridge` and stops it. It never enters `localBridges`, so a session
//      holding the same entry keeps its process, and the probe's process cannot
//      outlive the call — the refcount stays a function of the live sessions
//      (§6), which is the invariant the whole lifecycle rests on.
//   2. **Bounded, and it kills what it started.** A server waiting on an
//      interactive `tsh`/`gcloud` login never answers, and a dialog that waits
//      for it forever is worse than no button. One budget covers the whole
//      probe, and `stop()` (SIGTERM → grace → SIGKILL, idempotent) runs in a
//      `finally` whichever way it ends.
//   3. **It answers, it does not throw.** Every outcome is an `McpProbeResult`
//      with a sentence a person can read. A stack trace across IPC would be
//      the same failure the probe exists to translate.
//
// What it deliberately does not do: it is never called on save (§4.6 — a local
// entry executes third-party code on the host, so *running* it is a decision
// the user makes explicitly), and its tool list unlocks nothing (§3.3).

import type {
  McpEntryKind,
  McpHttpEntry,
  McpLocalEntry,
  McpProbeLine,
  McpProbeResult,
  McpProbedTool,
  McpRegistryEntry
} from '../../shared/mcp'
import { isLocalMcpEntry, mcpEntryKind, normalizeMcpEntry, validateMcpEntry } from '../../shared/mcp'
import { resolveMcpCredential } from '../../shared/credentials'
import { listCredentials } from '../credentials'
import { credentialEnv } from './manager'
import { startStdioBridge, type JsonRpcMessage, type StdioTrace } from './stdioBridge'
import { createLogger, sanitize } from '../log'

const log = createLogger('mcp')

/**
 * The whole probe's budget: install, spawn, handshake and tool list together.
 *
 * Long, because an `npm` entry's first probe includes the install of a package
 * that may not be in the cache — and short enough that a wedged server frees the
 * button while the user is still looking at it. A parameter rather than a
 * constant so the timeout path is a one-second test instead of a one-minute one.
 */
const PROBE_BUDGET_MS = 60_000

/** Bound on one JSON-RPC round trip inside the budget. Separate from it because
 *  the interesting hang is here: a process that started fine and then sits on an
 *  interactive login answers `initialize` never, not slowly. */
const CALL_TIMEOUT_MS = 20_000

/** Protocol version gurt asks for. A server that speaks an older one answers
 *  with its own and the probe accepts it — this is a reachability check, not a
 *  compatibility judgement gurt is entitled to make on the agent's behalf. */
const PROTOCOL_VERSION = '2025-06-18'

/** Bytes of an error response body quoted back to the user. Enough for the
 *  `{"error":"invalid token"}` that explains a 401, not enough to paste a page
 *  of HTML into a dialog. */
const MAX_BODY_QUOTE = 300

/** How many lines of the transcript survive the cap, and how they are split
 *  between its two interesting ends. The head holds the launch itself (what was
 *  installed, what was spawned, with which variable names); the tail holds
 *  whatever the process was saying when it stopped saying it. A server in a
 *  restart loop fills the middle, and the middle is what goes. */
const TRANSCRIPT_HEAD = 30
const TRANSCRIPT_TAIL = 170

/** Bound on one transcript line. Long enough for a stack frame or an npm error,
 *  short enough that a server printing a base64 blob per line cannot turn a
 *  dialog into a download. */
const TRANSCRIPT_LINE = 400

/** What gurt calls itself in the handshake. */
const CLIENT_INFO = { name: 'gurt', title: 'gurt (connection test)', version: '1' }

interface ProbeOptions {
  /** Total time the probe may take, in ms. Tests pass a small one. */
  budgetMs?: number
}

/** A shared deadline: every step of one probe reads its remaining time here, so
 *  a slow install cannot buy the handshake extra seconds. */
function budget(ms: number): { left: () => number } {
  const at = Date.now() + ms
  return { left: () => at - Date.now() }
}

/** Marks "we ran out of time", so the caller can say which step did. */
class Timeout extends Error {}

/** Whether this is something running out of time rather than failing — this
 *  module's own {@link Timeout}, or the abort of a `fetch` whose deadline came
 *  first. Both mean the step named by the caller did not finish. */
function isTimeout(e: unknown): boolean {
  if (e instanceof Timeout) return true
  const name = e instanceof Error ? e.name : ''
  return name === 'TimeoutError' || name === 'AbortError'
}

/**
 * `work`, or a {@link Timeout} after `ms`.
 *
 * Any timeout inside `work` is rewritten into `what` as well, so the sentence
 * the user reads is the step's, not whichever timer happened to fire first —
 * "the server started but did not answer the MCP handshake" instead of node's
 * "The operation was aborted due to timeout".
 *
 * The work is not cancelled — nothing here can cancel an `npm install`
 * mid-flight — so every caller of this is inside the `try` whose `finally` stops
 * the bridge, and `spawnChild` refuses to spawn after a stop
 * (`stdioBridge.ts`). That pair is what makes a timed-out probe leave nothing
 * behind.
 */
async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Timeout(what)), Math.max(0, ms))
        timer.unref?.()
      })
    ])
  } catch (e) {
    throw isTimeout(e) ? new Timeout(what) : e
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * The transcript, collected as the launch happens.
 *
 * Head plus a rolling tail rather than a plain ring: dropping the oldest lines
 * would drop the argv, which is the one thing a person reading a pasted
 * snippet's launch cannot get anywhere else. What is dropped is said in place,
 * as a line, so a gap never reads as silence.
 *
 * Every line goes through the app log's `sanitize()` — ANSI out, stored
 * credential secrets out in each of their encodings, control characters escaped
 * — even though none of this reaches a log file. The output is a third party's,
 * and the redactor is the only thing that knows what a secret looks like.
 */
function transcript(): { trace: StdioTrace; lines: () => McpProbeLine[] } {
  const started = Date.now()
  const head: McpProbeLine[] = []
  const tail: McpProbeLine[] = []
  let dropped = 0
  const trace: StdioTrace = (stream, line) => {
    const entry: McpProbeLine = {
      at: Date.now() - started,
      stream,
      line: sanitize(line).slice(0, TRANSCRIPT_LINE)
    }
    if (head.length < TRANSCRIPT_HEAD) {
      head.push(entry)
      return
    }
    tail.push(entry)
    if (tail.length > TRANSCRIPT_TAIL) {
      tail.shift()
      dropped++
    }
  }
  return {
    trace,
    lines: () => [
      ...head,
      ...(dropped
        ? [{ at: tail[0]?.at ?? 0, stream: 'gurt' as const, line: `… ${dropped} lines not shown …` }]
        : []),
      ...tail
    ]
  }
}

/** The sentence an unknown throw becomes. */
const say = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** One JSON-RPC message out of an HTTP response, whichever of the two shapes
 *  Streamable HTTP allows it to arrive in: a JSON body, or an SSE stream whose
 *  first `data:` frame carries the reply. */
function readReply(contentType: string, body: string): JsonRpcMessage {
  const text = contentType.includes('text/event-stream')
    ? (body
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .find((data) => data && data !== '[DONE]') ?? '')
    : body.trim()
  if (!text) throw new Error('the server answered with an empty body')
  const parsed: unknown = JSON.parse(text)
  if (Array.isArray(parsed)) {
    const first = (parsed as unknown[]).find((m) => typeof m === 'object' && m !== null)
    if (!first) throw new Error('the server answered with an empty batch')
    return first as JsonRpcMessage
  }
  if (typeof parsed !== 'object' || parsed === null)
    throw new Error('the server answered something that is not a JSON-RPC message')
  return parsed as JsonRpcMessage
}

/** POST one request and return its reply, or throw a sentence saying why there
 *  is none. Rejects a JSON-RPC error reply too: to this caller "the server said
 *  no" and "the server did not answer" are the same outcome, differing only in
 *  the message. */
async function call(
  url: string,
  headers: Record<string, string>,
  msg: JsonRpcMessage,
  ms: number,
  trace?: StdioTrace
): Promise<JsonRpcMessage> {
  trace?.('gurt', `→ ${String(msg.method)}`)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Both, because either is a legal answer to a Streamable HTTP POST.
      accept: 'application/json, text/event-stream',
      ...headers
    },
    body: JSON.stringify(msg),
    signal: AbortSignal.timeout(Math.max(1, ms))
  })
  const body = await res.text()
  trace?.('gurt', `← HTTP ${res.status} (${res.headers.get('content-type') ?? 'no content-type'})`)
  if (!res.ok) {
    const quoted = body.replace(/\s+/g, ' ').trim().slice(0, MAX_BODY_QUOTE)
    throw new Error(`the server answered HTTP ${res.status}${quoted ? ` — ${quoted}` : ''}`)
  }
  const reply = readReply(res.headers.get('content-type') ?? '', body)
  if (reply.error) {
    const err = reply.error as { message?: unknown; code?: unknown }
    if (typeof err.message === 'string' && err.message) throw new Error(err.message)
    const code = typeof err.code === 'number' || typeof err.code === 'string' ? err.code : 'unknown'
    throw new Error(`the server answered a JSON-RPC error (code ${code})`)
  }
  return reply
}

/** Fire-and-forget notification; a server that dislikes it is not a failure. */
async function notify(
  url: string,
  headers: Record<string, string>,
  ms: number,
  trace?: StdioTrace
): Promise<void> {
  trace?.('gurt', '→ notifications/initialized')
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(Math.max(1, ms))
    })
  } catch {
    // The handshake is done; whether the server wanted to hear about it is
    // between it and the spec.
  }
}

/** `initialize`, and what the server called itself. */
async function handshake(
  url: string,
  headers: Record<string, string>,
  ms: number,
  trace?: StdioTrace
): Promise<string | undefined> {
  const reply = await call(
    url,
    headers,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }
    },
    ms,
    trace
  )
  const info = (reply.result as { serverInfo?: { name?: unknown; version?: unknown } } | undefined)
    ?.serverInfo
  const name = typeof info?.name === 'string' ? info.name.trim() : ''
  const version = typeof info?.version === 'string' ? info.version.trim() : ''
  const server = name ? [name, version].filter(Boolean).join(' ') : undefined
  trace?.('gurt', `← it is ${server ?? 'a server that did not name itself'}`)
  return server
}

/** `tools/list`, flattened to what the UI shows. */
async function listTools(
  url: string,
  headers: Record<string, string>,
  ms: number,
  trace?: StdioTrace
): Promise<McpProbedTool[]> {
  const reply = await call(url, headers, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, ms, trace)
  const raw = (reply.result as { tools?: unknown } | undefined)?.tools
  if (!Array.isArray(raw)) throw new Error('the server answered without a tool list')
  const tools: McpProbedTool[] = []
  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null) continue
    const { name, description } = item as { name?: unknown; description?: unknown }
    if (typeof name !== 'string' || !name.trim()) continue
    const summary = typeof description === 'string' ? description.trim().split('\n')[0]?.trim() : ''
    tools.push({ name: name.trim(), ...(summary ? { summary } : {}) })
  }
  trace?.('gurt', `← ${tools.length} tool${tools.length === 1 ? '' : 's'}`)
  return tools
}

/**
 * Start a local entry on its own one-shot bridge and talk to it.
 *
 * The bridge publishes `host.docker.internal` because that is where the session
 * container reaches it from; the probe is the main process, on the host, so it
 * dials the same listener on loopback.
 */
async function probeLocal(
  entry: McpLocalEntry,
  left: () => number,
  trace: StdioTrace
): Promise<Omit<McpProbeResult, 'kind' | 'ok' | 'transcript'>> {
  // Throws with the same sentence a session start would fail with — a dangling
  // or wrong-kind credential link blocks here too, rather than probing an
  // unauthenticated process and calling the result representative.
  const { env } = await credentialEnv(entry)
  const bridge = startStdioBridge(entry, env, trace)
  try {
    const ready = await within(
      bridge.ready,
      left(),
      'the server did not start in time — an npm entry installs its package on the first run, so a second try may be faster'
    )
    const url = new URL(ready)
    url.hostname = '127.0.0.1'
    const target = url.toString()
    const server = await within(
      handshake(target, {}, Math.min(CALL_TIMEOUT_MS, left()), trace),
      left(),
      'the server started but did not answer the MCP handshake in time — it may be waiting for an interactive authorization on this machine'
    )
    await notify(target, {}, Math.min(CALL_TIMEOUT_MS, left()), trace)
    try {
      const tools = await within(
        listTools(target, {}, Math.min(CALL_TIMEOUT_MS, left()), trace),
        left(),
        'the server did not answer tools/list in time'
      )
      return { ...(server ? { server } : {}), tools }
    } catch (e) {
      // The handshake is what "it works" means; a server with no tools
      // capability is up, and says so.
      trace('gurt', `← no tool list: ${say(e)}`)
      return { ...(server ? { server } : {}), toolsError: say(e) }
    }
  } finally {
    await bridge.stop().catch(() => {})
  }
}

/**
 * Handshake a remote endpoint with the headers the proxy would send.
 *
 * `initialize` only. A stateful Streamable HTTP server hands back an
 * `Mcp-Session-Id` that every later call has to carry, and a probe that got that
 * wrong would report "no tools" about a healthy server — a worse answer than no
 * list at all. What this proves is the endpoint, the credential and the headers;
 * the caller is required to say so, because gurt reaches it from the host here
 * and from the session's proxy in a session (§4.6).
 */
async function probeHttp(
  url: string,
  headers: Record<string, string>,
  left: () => number,
  trace: StdioTrace
): Promise<Omit<McpProbeResult, 'kind' | 'ok' | 'transcript'>> {
  trace('gurt', `POST ${url}`)
  // Names, never values — the same rule the local path applies to the
  // environment, for the same reason: one of these is the credential.
  const names = Object.keys(headers)
  if (names.length)
    trace('gurt', `headers gurt sends: ${names.join(', ')} (names only — never values)`)
  const server = await within(
    handshake(url, headers, Math.min(CALL_TIMEOUT_MS, left()), trace),
    left(),
    'the endpoint did not answer the MCP handshake in time'
  )
  return server ? { server } : {}
}

/** The headers a remote entry's request carries — its static ones plus its
 *  resolved credential, composed exactly as `planProxy` composes them (the
 *  credential wins over a static header of the same name). */
async function httpHeaders(entry: McpHttpEntry): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const h of entry.headers ?? []) out[h.name] = h.value
  const { header, error } = resolveMcpCredential(await listCredentials(), entry.credentialId)
  if (error) throw new Error(error)
  if (header) {
    for (const name of Object.keys(out))
      if (name.toLowerCase() === header.name.toLowerCase()) delete out[name]
    out[header.name] = header.value
  }
  return out
}

/** Attach the transcript, unless there is nothing in it — a draft rejected by
 *  the validator never launched anything, and an empty log invites the reader
 *  to look for something that was never there. */
const withTranscript = (lines: McpProbeLine[]): { transcript?: McpProbeLine[] } =>
  lines.length ? { transcript: lines } : {}

/**
 * Run one entry and report what it does. Never rejects.
 *
 * The entry may be one that was never saved — that is the point: "check what I
 * just pasted, before I commit to it" is the case this exists for (§5), so what
 * arrives is a draft off the wire and is normalized and validated here before
 * anything is spawned.
 */
export async function probeMcpServer(
  entry: McpRegistryEntry,
  { budgetMs = PROBE_BUDGET_MS }: ProbeOptions = {}
): Promise<McpProbeResult> {
  const started = Date.now()
  const { trace, lines } = transcript()
  let kind: McpEntryKind = 'http'
  let id = ''
  try {
    // A draft arriving over IPC has been through no parser; normalize first so
    // the thing that is run is the thing that would be saved, byte for byte.
    const normalized = normalizeMcpEntry(entry)
    kind = mcpEntryKind(normalized)
    id = normalized.id
    // `takenIds` is empty on purpose: a probe is not a save, and whether some
    // other entry already holds this id says nothing about whether this one
    // runs. Thrown rather than returned so a refused probe is logged like every
    // other one — the user pressed the button either way.
    const invalid = validateMcpEntry(normalized)
    if (invalid) throw new Error(invalid)

    const { left } = budget(budgetMs)
    const found = isLocalMcpEntry(normalized)
      ? await probeLocal(normalized, left, trace)
      : await probeHttp(normalized.url, await httpHeaders(normalized), left, trace)
    // The transcript is *not* in this record, and is in no other: it is the
    // third-party process's own output, displayed to whoever asked for the
    // launch and written to no file of gurt's. What is logged is that a probe
    // happened and how it went — a count of tools, never their names.
    log.info('mcp.probe', {
      id,
      kind,
      ok: true,
      tools: found.tools?.length,
      ms: Date.now() - started
    })
    return { ok: true, kind, ...found, ...withTranscript(lines()) }
  } catch (e) {
    const error = say(e)
    // Said in the transcript too, so the last line of the launch is why it
    // stopped rather than an unexplained silence after the last stderr line.
    trace('gurt', `probe failed: ${error}`)
    log.info('mcp.probe', { id, kind, ok: false, err: error, ms: Date.now() - started })
    return { ok: false, kind, error, ...withTranscript(lines()) }
  }
}
