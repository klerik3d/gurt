import type { ChildProcessWithoutNullStreams } from 'node:child_process'
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
  private buffer = ''

  constructor(
    private child: ChildProcessWithoutNullStreams,
    private onFatal: (err: Error) => void,
    /** Owning session, for the frame trace. */
    private sessionId?: string
  ) {
    child.stdout.on('data', (d: Buffer) => this.onData(d.toString()))
    child.on('close', () => {
      const err = new Error('agent process exited')
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
    })
    child.on('error', (e) => this.onFatal(e))
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
   */
  request<T>(method: string, params: unknown, schema: z.ZodType<T>): Promise<T>
  request(method: string, params: unknown): Promise<unknown>
  request<T>(method: string, params: unknown, schema?: z.ZodType<T>): Promise<unknown> {
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => {
          if (!schema) return resolve(v)
          const parsed = schema.safeParse(v)
          if (parsed.success) resolve(parsed.data)
          else reject(new Error(`${method}: malformed response (${issuePaths(parsed.error)})`))
        },
        reject
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

  private onData(chunk: string): void {
    this.buffer += chunk
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
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
