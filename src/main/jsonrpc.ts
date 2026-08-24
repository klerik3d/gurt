import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { z } from 'zod'
import { createLogger, enabled } from './log'

// Minimal JSON-RPC 2.0 peer over newline-delimited JSON on child stdio,
// which is what ACP (Agent Client Protocol) speaks.

/** Our own requests are numbered; an agent may address us with either form. */
const RPC_ID = z.union([z.number(), z.string()])

/**
 * The envelope, and only the envelope: everything on the other end of this pipe
 * is a subprocess we do not control, so a line is a frame only once it has
 * parsed as one. `params`/`result` deliberately stay `unknown` — their shape
 * belongs to the protocol spoken on top (see acp.ts), and this peer must not
 * pretend to know it. Loose object: unknown members of a frame are ignored, not
 * a parse failure, so a newer agent's extra fields still dispatch.
 */
const RPC_FRAME = z.looseObject({
  id: RPC_ID.optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ message: z.string().optional() }).optional()
})

type RpcFrame = z.infer<typeof RPC_FRAME>

/** Returns the request's result, or a promise of it. */
type Handler = (params: unknown) => unknown

/**
 * Where a payload failed to match, and nothing else. Zod's own messages quote
 * the value it received, and everything crossing this pipe is prompt text, agent
 * output or tool arguments — so a rejection reports paths and issue codes only,
 * never content. Same rule as the frame trace above.
 */
export function issuePaths(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.length ? i.path.join('.') : '<root>'}: ${i.code}`)
    .join(', ')
}

/**
 * Cap on one inbound frame — and so on the unterminated remainder buffered
 * between chunks, since that remainder *is* a frame still arriving. An adapter
 * that never writes a '\n' must not grow `buffer` until the app runs out of
 * memory.
 *
 * Deliberately far above `provision.ts`'s 32 KiB `MAX_LINE_BUFFER`: that one
 * bounds a line of a log, this one bounds an ACP message. The large ones are
 * `session/update` tool calls, whose content carries whole file bodies and
 * diffs (`TOOL_CONTENT` in acp.ts) — a multi-megabyte generated or lock file
 * edited in one turn is legitimate traffic, and a cap that rejected it would
 * break normal work worse than the unbounded growth it replaces. 16 MiB clears
 * the largest plausible frame by a wide margin and still bounds the buffer at
 * ~32 MB in memory per session. Counted in code units, not bytes: this is a
 * memory bound, and a code unit is what `buffer` actually costs.
 */
export const MAX_FRAME = 16 * 1024 * 1024

const log = createLogger('rpc')
/** Frames carry prompts, agent output and tool arguments, so the trace is the
 *  envelope only — method, id, direction, size. Never params, at any level. */
const trace = enabled('debug')

export class JsonRpcPeer {
  private nextId = 1
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  private requestHandlers = new Map<string, Handler>()
  private notificationHandlers = new Map<string, (params: unknown) => void>()
  /** A chunk boundary can land mid multi-byte UTF-8 sequence; decoding each
   *  chunk on its own turns both halves into U+FFFD — silently, because the
   *  frame still parses as JSON and the corruption only shows up in the payload
   *  the app then acts on. The decoder carries the partial sequence into the
   *  next chunk, the same way `buffer` carries the partial line, and for the
   *  same reason `lineBuffer()` in provision.ts uses one. */
  private utf8 = new StringDecoder('utf8')
  private buffer = ''
  /** Set while the tail of an over-cap frame is being discarded: everything up
   *  to the next '\n' belongs to a frame that was already dropped and
   *  reported, so it must not be parsed and must not be reported twice. */
  private discarding = false

  constructor(
    private child: ChildProcessWithoutNullStreams,
    private onFatal: (err: Error) => void,
    /** Owning session, for the frame trace. */
    private sessionId?: string
  ) {
    child.stdout.on('data', (d: Buffer) => this.onData(this.utf8.write(d)))
    child.on('close', () => {
      const err = new Error('agent process exited')
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
    })
    child.on('error', (e) => this.onFatal(e))
    // A write into a dead adapter's pipe (EPIPE — e.g. a cancel sent right
    // after the process crashed) surfaces as an 'error' on the *stream*, not on
    // the process; without a listener it throws as an uncaught exception and
    // takes the whole app down.
    child.stdin.on('error', (e) => this.onFatal(e))
  }

  onRequest(method: string, handler: Handler): void {
    this.requestHandlers.set(method, handler)
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler)
  }

  /**
   * Send a request. The result is whatever the agent chose to send back, so a
   * caller that wants to *use* it passes the schema it expects and gets a
   * checked value — a response that does not match rejects the call instead of
   * seeding an unchecked object into the session state. Callers that ignore the
   * result (`session/set_mode`, …) pass no schema and get `unknown`.
   *
   * `timeoutMs` bounds control-plane calls (initialize, session/new, …) whose
   * answer should come in seconds — an adapter that never answers would
   * otherwise hold its caller (and the session's `starting` state) forever.
   * Deliberately never set on `session/prompt`: a turn takes as long as it
   * takes.
   */
  request<T>(method: string, params: unknown, schema: z.ZodType<T>, opts?: { timeoutMs?: number }): Promise<T>
  request(method: string, params: unknown): Promise<unknown>
  request<T>(
    method: string,
    params: unknown,
    schema?: z.ZodType<T>,
    opts?: { timeoutMs?: number }
  ): Promise<unknown> {
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = opts?.timeoutMs
        ? setTimeout(() => {
            if (!this.pending.delete(id)) return
            reject(
              new Error(
                `${method}: no response after ${Math.round((opts.timeoutMs ?? 0) / 1000)}s — the agent looks stuck`
              )
            )
          }, opts.timeoutMs)
        : undefined
      timer?.unref?.()
      this.pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer)
          if (!schema) return resolve(v)
          const parsed = schema.safeParse(v)
          if (parsed.success) resolve(parsed.data)
          else reject(new Error(`${method}: malformed response (${issuePaths(parsed.error)})`))
        },
        reject: (e) => {
          if (timer) clearTimeout(timer)
          reject(e)
        }
      })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  private send(msg: unknown): void {
    const line = JSON.stringify(msg) + '\n'
    // Byte length, not code units — the trace's `bytes` is what went down the pipe.
    if (trace) this.traceFrame('out', msg as Record<string, unknown>, Buffer.byteLength(line, 'utf8'))
    this.child.stdin.write(line)
  }

  private traceFrame(dir: 'in' | 'out', msg: RpcFrame | Record<string, unknown>, bytes: number): void {
    log.debug('rpc.msg', {
      s: this.sessionId,
      dir,
      method: typeof msg?.method === 'string' ? msg.method : undefined,
      id: typeof msg?.id === 'number' || typeof msg?.id === 'string' ? msg.id : undefined,
      bytes
    })
  }

  /**
   * An over-cap frame is dropped whole, never truncated: a cut-off line is
   * invalid JSON at best and — if the cut lands somewhere JSON still closes —
   * a *valid* frame with a silently shortened payload at worst, which is the
   * same class of quiet corruption the decoder above exists to prevent.
   *
   * Reported, not swallowed. `onFatal` is the module's channel to the owner,
   * and the owner (sessions.ts) logs it and leaves the peer running — which is
   * what this case wants: the pipe itself is intact and the stream resumes at
   * the next newline. But the loss is real and asymmetric — a dropped
   * `session/update` costs a timeline entry, while a dropped *response* leaves
   * its request pending until its timeout, and `session/prompt` has none by
   * design. A record is the only thing that tells those apart from an agent
   * that simply went quiet. Size only, never the frame: same rule as the trace.
   */
  private reportOversize(chars: number): void {
    log.warn('rpc.oversize', { s: this.sessionId, chars, cap: MAX_FRAME })
    this.onFatal(
      new Error(`agent frame exceeded the ${MAX_FRAME / (1024 * 1024)} MiB cap and was dropped`)
    )
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const raw = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      // The tail of a frame already dropped below: it ends at this newline.
      if (this.discarding) {
        this.discarding = false
        continue
      }
      // A whole over-cap frame delivered inside one chunk never passed through
      // the remainder check, so it is caught here.
      if (raw.length > MAX_FRAME) {
        this.reportOversize(raw.length)
        continue
      }
      const line = raw.trim()
      if (!line) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue // stray log line on stdout — ignore
      }
      const frame = RPC_FRAME.safeParse(parsed)
      // Same treatment as unparsable JSON: an adapter that prints something
      // JSON-shaped but not a frame is noise on stdout, not a message.
      if (!frame.success) continue
      if (trace) this.traceFrame('in', frame.data, Buffer.byteLength(line, 'utf8'))
      void this.dispatch(frame.data)
    }
    // What is left holds no newline, so it is one frame still arriving. Past
    // the cap it can only get worse: drop it, remember that its tail is still
    // coming, and resynchronize at the next newline.
    if (this.buffer.length > MAX_FRAME) {
      if (!this.discarding) {
        this.discarding = true
        this.reportOversize(this.buffer.length)
      }
      this.buffer = ''
    }
  }

  private async dispatch(msg: RpcFrame): Promise<void> {
    if (msg.id !== undefined && msg.method) {
      const handler = this.requestHandlers.get(msg.method)
      if (!handler) {
        this.send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `method not found: ${msg.method}` }
        })
        return
      }
      try {
        const result = await handler(msg.params)
        this.send({ jsonrpc: '2.0', id: msg.id, result })
      } catch (e) {
        this.send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32603, message: e instanceof Error ? e.message : String(e) }
        })
      }
    } else if (msg.method) {
      this.notificationHandlers.get(msg.method)?.(msg.params)
    } else if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message ?? 'agent error'))
      else p.resolve(msg.result)
    }
  }
}
