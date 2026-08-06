import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createLogger, enabled } from './log'

// Minimal JSON-RPC 2.0 peer over newline-delimited JSON on child stdio,
// which is what ACP (Agent Client Protocol) speaks.

type Handler = (params: any) => Promise<unknown> | unknown

const log = createLogger('rpc')
/** Frames carry prompts, agent output and tool arguments, so the trace is the
 *  envelope only — method, id, direction, size. Never params, at any level. */
const trace = enabled('debug')

export class JsonRpcPeer {
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private requestHandlers = new Map<string, Handler>()
  private notificationHandlers = new Map<string, (params: any) => void>()
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

  onNotification(method: string, handler: (params: any) => void): void {
    this.notificationHandlers.set(method, handler)
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
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

  private traceFrame(dir: 'in' | 'out', msg: Record<string, unknown>, bytes: number): void {
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
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        continue // stray log line on stdout — ignore
      }
      if (trace) this.traceFrame('in', msg, Buffer.byteLength(line, 'utf8'))
      this.dispatch(msg)
    }
  }

  private async dispatch(msg: any): Promise<void> {
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
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message ?? 'agent error'))
      else p.resolve(msg.result)
    }
  }
}
