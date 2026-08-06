// Renderer side of the app log: the same `createLogger(scope)` shape as
// src/main/log.ts, with IPC as the transport. Nothing is written or filtered
// here — main owns the file, the level threshold, the rate limit and the
// redaction, and treats everything arriving over the channel as untrusted.

export type Level = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(msg: string, ctx?: object): void
  info(msg: string, ctx?: object): void
  warn(msg: string, ctx?: object): void
  error(msg: string, ctx?: object): void
}

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Main's threshold, mirrored over the bridge at preload time. Resolved lazily
 *  (and cached) so a missing bridge — tests, a torn-down window — degrades to
 *  "send everything, main decides", never to a throw. This filter is purely an
 *  optimization: a debug call below the threshold costs one comparison instead
 *  of an IPC message main would drop anyway. */
let threshold: number | undefined
function passes(level: Level): boolean {
  if (threshold === undefined) {
    try {
      threshold = RANK[window.gurt?.logLevel as Level] ?? RANK.debug
    } catch {
      threshold = RANK.debug
    }
  }
  return RANK[level] >= threshold
}

/** `{name, message, code, stack}` — Errors do not survive the IPC boundary
 *  intact, so they are flattened to the shape main's ctx serializer expects
 *  (which keeps the stack for ERR records only). */
function errObj(e: unknown): {
  name: string
  message: string
  code?: string | number
  stack?: string
} {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code
    return {
      name: e.name,
      message: e.message,
      ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
      ...(e.stack ? { stack: e.stack } : {})
    }
  }
  return { name: 'Error', message: String(e) }
}

/** Shallow-clone ctx into something structured-cloneable: Errors flattened,
 *  functions and other exotic values stringified. */
function plainCtx(ctx: object): object {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(ctx)) {
    if (v instanceof Error) out[k] = errObj(v)
    else if (typeof v === 'function' || typeof v === 'symbol') out[k] = String(v)
    else out[k] = v
  }
  return out
}

export function createLogger(scope: string): Logger {
  const at =
    (level: Level) =>
    (msg: string, ctx?: object): void => {
      if (!passes(level)) return
      // Stamped here, at the moment of the call, not when main gets around to
      // processing the IPC message — a rate-limited or delayed delivery must
      // not skew the record's timestamp away from when the event happened.
      const ts = Date.now()
      try {
        window.gurt?.log?.(level, scope, msg, ctx ? plainCtx(ctx) : undefined, ts)
      } catch {
        // A missing bridge (tests, a torn-down window) must never break the UI.
      }
    }
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }
}

const ipcLog = createLogger('ipc')

/**
 * Catch handler for a `window.gurt.*` call: the failure is recorded as
 * `ipc.fail` with the method that produced it. Replaces `.catch(console.error)`
 * — a renderer console nobody has open is not a diagnostic.
 */
export function logErr(method: string): (e: unknown) => void {
  return (e) => ipcLog.error('ipc.fail', { method, err: errObj(e) })
}

/** Route uncaught renderer errors into the app log (called once, from main.tsx). */
export function installErrorHooks(): void {
  const log = createLogger('window')
  window.addEventListener('error', (e) => {
    log.error('window.error', {
      message: e.message,
      source: e.filename,
      line: e.lineno,
      err: e.error ? errObj(e.error) : undefined
    })
  })
  window.addEventListener('unhandledrejection', (e) => {
    log.error('window.unhandledrejection', { err: errObj(e.reason) })
  })
}
