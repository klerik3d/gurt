// Remote access in Gurt main (docs/requirements-remote-access.md §6–§9): built
// only when the setting is on. Today that is the relay connection and the
// push path; the channel, pairing and the remote surface sit on top of it.
import type { RemoteSettings } from '../../shared/remote'
import { createLogger } from '../log'
import { setExternalSink } from '../notify-external'
import { getRemoteSettings } from '../store'
import { loadOrCreateIdentity, type HostIdentity } from './identity'
import { RelayClient, type RelayClientOptions, type RelayState, type SocketFactory } from './relayClient'

const log = createLogger('remote')

export interface RemoteAccess {
  client: RelayClient
  /** Close the relay connection; `goingAway` tells open streams first. */
  stop(opts?: { goingAway?: boolean }): void
}

export interface RemoteAccessDeps {
  settings?: RemoteSettings
  identity?: () => Promise<HostIdentity>
  socketFactory?: SocketFactory
  backoff?: RelayClientOptions['backoff']
  onState?: (s: RelayState) => void
}

/**
 * Start remote access if it is on. With the setting off — or on with no relay
 * URL — nothing is constructed, no key is made and no connection is opened
 * (§12), and `undefined` comes back.
 */
export async function startRemoteAccess(deps: RemoteAccessDeps = {}): Promise<RemoteAccess | undefined> {
  const settings = deps.settings ?? (await getRemoteSettings())
  if (!settings.enabled) return undefined
  if (!settings.relayUrl) {
    log.warn('remote.no-relay-url')
    return undefined
  }
  const identity = await (deps.identity ?? loadOrCreateIdentity)()
  const client = new RelayClient({
    relayUrl: settings.relayUrl,
    identity,
    ...(deps.socketFactory ? { socketFactory: deps.socketFactory } : {}),
    ...(deps.backoff ? { backoff: deps.backoff } : {}),
    ...(deps.onState ? { onState: deps.onState } : {}),
    // No device store yet: a dead token has nothing to be dropped from.
    onPushGone: (ids) => log.info('remote.push-gone', { devices: ids.length })
  })
  // Paired devices and their tokens come with pairing; until then the set is
  // empty, which is also what tells a relay to forget any it held.
  client.setPushTokens([])
  setExternalSink((type, sessionId) => client.push({ t: type, s: sessionId }))
  client.start()
  log.info('remote.start', { hostId: identity.hostId })
  return {
    client,
    stop(opts) {
      setExternalSink(undefined)
      client.stop(opts)
    }
  }
}
