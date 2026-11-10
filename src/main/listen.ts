import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createLogger, type Logger } from './log'

/** Listen on an ephemeral port, rejecting startup errors and logging runtime errors. */
export function listenEphemeral(
  server: Server,
  host: string,
  site: string,
  ctx?: Record<string, unknown>,
  log: Logger = createLogger('listen')
): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      // The startup reject has done its job; a *runtime* server error after this
      // would otherwise call a settled promise's reject and vanish.
      server.removeListener('error', reject)
      server.on('error', (e) => log.error('internal.fail', { site, ...ctx, err: e }))
      resolve((server.address() as AddressInfo).port)
    })
  })
}
