import type { GurtApi, GurtEvents } from '../shared/api'

declare global {
  interface Window {
    /** The preload bridge: every `GurtApi` method plus the event subscriptions. */
    gurt: GurtApi & {
      /** Fire-and-forget log record for the main-process log (see renderer/src/log.ts).
       *  `ts` is the renderer's `Date.now()` at the moment of the call, so a
       *  rate-limited or delayed IPC delivery doesn't skew the record's timestamp. */
      log(level: string, scope: string, msg: string, ctx?: object, ts?: number): void
      /** Main's effective log threshold, mirrored at preload time — lets the
       *  renderer skip the IPC send for records main would filter anyway. */
      logLevel: string
      onTreeChanged(cb: () => void): () => void
      onSessionChanged(cb: (snapshot: GurtEvents['session-changed']) => void): () => void
      onSessionLog(cb: (event: GurtEvents['session-log']) => void): () => void
      onSessionTurn(cb: (event: GurtEvents['session-turn']) => void): () => void
      onProvisionLog(cb: (event: GurtEvents['provision-log']) => void): () => void
      onNotification(cb: (event: GurtEvents['notification']) => void): () => void
      onNotificationRead(cb: (event: GurtEvents['notification-read']) => void): () => void
      onUsageChanged(cb: () => void): () => void
      onBootProgress(cb: (event: GurtEvents['boot-progress']) => void): () => void
      /** One session's observed proxy traffic changed (blocked/allowed hosts). */
      onProxyTraffic(cb: (event: GurtEvents['proxy-traffic']) => void): () => void
    }
  }
}

export {}
