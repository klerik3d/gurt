// Remote access settings (docs/requirements-remote-access.md §10) — shared
// between main (the relay client, persistence) and, later, the renderer's
// Settings → Remote access page.

export interface RemoteSettings {
  /** Off by default. While off Gurt opens no connection to the relay and
   *  constructs nothing of the remote surface (§12). */
  enabled: boolean
  /** The relay's base URL, `wss://host[:port][/path]`. Empty = none chosen. */
  relayUrl: string
  /** Hold a power-save blocker while on and a device is paired (§9.3). */
  keepAwake: boolean
}

/** The project's relay. Empty until one is announced: with no URL, turning
 *  remote access on connects to nothing. */
export const DEFAULT_RELAY_URL = ''

export const REMOTE_DEFAULTS: RemoteSettings = {
  enabled: false,
  relayUrl: DEFAULT_RELAY_URL,
  keepAwake: true
}

/** `wss://host[:port][/path]`, no credentials, query or fragment. */
export function isRelayUrl(v: string): boolean {
  return /^wss:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]*)?$/.test(v)
}

/** The file on disk (and later the IPC boundary) is untrusted: coerce each
 *  field, falling back to `fallback` for a missing or garbled one. A relay
 *  URL that is not `wss://` is dropped, not repaired. */
export function normalizeRemoteSettings(raw: unknown, fallback: RemoteSettings = REMOTE_DEFAULTS): RemoteSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof RemoteSettings, unknown>>
  const url = typeof r.relayUrl === 'string' ? r.relayUrl.trim() : undefined
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : fallback.enabled,
    relayUrl: url === undefined ? fallback.relayUrl : url === '' || isRelayUrl(url) ? url : fallback.relayUrl,
    keepAwake: typeof r.keepAwake === 'boolean' ? r.keepAwake : fallback.keepAwake
  }
}
