import type { GurtApi, GurtEvents } from '../shared/api'

declare global {
  interface Window {
    /** The preload bridge: every `GurtApi` method plus the event subscriptions. */
    gurt: GurtApi & {
      onTreeChanged(cb: () => void): () => void
      onSessionChanged(cb: (snapshot: GurtEvents['session-changed']) => void): () => void
      onSessionTurn(cb: (event: GurtEvents['session-turn']) => void): () => void
      onProvisionLog(cb: (event: GurtEvents['provision-log']) => void): () => void
    }
  }
}

export {}
