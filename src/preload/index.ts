import { contextBridge, ipcRenderer } from 'electron'
import { API_METHODS, type GurtEvents } from '../shared/api'

/** Named subscription wrapper over one `GurtEvents` channel. */
const subscribe =
  <K extends keyof GurtEvents>(channel: K) =>
  (cb: (payload: GurtEvents[K]) => void) => {
    const listener = (_e: unknown, payload: GurtEvents[K]) => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }

// Main's effective log threshold, fetched once, synchronously — preload runs
// after registerIpc(), and one sync roundtrip at window creation is cheaper
// than an IPC message per filtered-out record later. Fallback 'debug' means
// "filter nothing here"; main filters regardless.
const logLevel: string = (() => {
  try {
    return (ipcRenderer.sendSync('log:level') as string) ?? 'debug'
  } catch {
    return 'debug'
  }
})()

const api: Record<string, unknown> = {
  // Fire-and-forget log record (`send`, not `invoke`): logging must never make
  // the renderer wait, and main validates + rate-limits everything it accepts.
  log: (level: string, scope: string, msg: string, ctx?: object, ts?: number) =>
    ipcRenderer.send('log', level, scope, msg, ctx, ts),
  logLevel,
  onTreeChanged: subscribe('tree-changed'),
  onSessionChanged: subscribe('session-changed'),
  onSessionLog: subscribe('session-log'),
  onSessionTurn: subscribe('session-turn'),
  onProvisionLog: subscribe('provision-log')
}
for (const m of API_METHODS) api[m] = (...args: unknown[]) => ipcRenderer.invoke(`api:${m}`, ...args)

contextBridge.exposeInMainWorld('gurt', api)
