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

const api: Record<string, unknown> = {
  onTreeChanged: subscribe('tree-changed'),
  onSessionChanged: subscribe('session-changed'),
  onSessionLog: subscribe('session-log'),
  onSessionTurn: subscribe('session-turn'),
  onProvisionLog: subscribe('provision-log')
}
for (const m of API_METHODS) api[m] = (...args: unknown[]) => ipcRenderer.invoke(`api:${m}`, ...args)

contextBridge.exposeInMainWorld('gurt', api)
