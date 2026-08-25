// The host git credential helper, kept as a source string and materialized on
// demand (the same lazy pattern as the ACP adapter install). It runs under
// Electron-in-node, like the CLI.
//
// There are deliberately no *container* shims any more: the session container
// holds no credentials, so it needs no credential helper, no forge-CLI wrapper
// and no launcher to put them on its PATH (docs/requirements-mcp-proxy.md §10).
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { gurtRoot } from '../store'

/**
 * Host git credential helper (§8): a pure HTTP forwarder to the host-local
 * credential broker (git/hostCredBroker.ts). The resolved entry id + host ride
 * in env (GURT_CRED_ID / GURT_CRED_HOST) as headers on the request; the broker
 * resolves the secret from credentials.json (decrypting it if sealed) and
 * answers only for the host the credential was resolved for — a fetch that
 * wanders to another host (submodule, redirect) gets nothing, and does not
 * fall through to ambient auth either. This helper has no filesystem or
 * keystore access of its own. Runs under Electron-in-node, so it is a
 * CommonJS `.cjs` regardless of any ambient package.json.
 */
export const HOST_CRED_HELPER = `'use strict'
const http = require('http')
if (process.argv[2] !== 'get') process.exit(0)
let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  const broker = process.env.GURT_CRED_BROKER
  const id = process.env.GURT_CRED_ID
  const credHost = process.env.GURT_CRED_HOST
  if (!broker || !id || !credHost) process.exit(0)
  let url
  try { url = new URL(broker.replace(/\\/$/, '') + '/credential') } catch (e) { process.exit(0) }
  const body = Buffer.from(input)
  const req = http.request(url, {
    method: 'POST',
    headers: {
      'content-type': 'text/plain',
      'content-length': body.length,
      'x-gurt-cred-id': id,
      'x-gurt-cred-host': credHost
    }
  }, (res) => {
    if (res.statusCode !== 200) { res.resume(); process.exit(0) }
    let out = ''
    res.on('data', (d) => (out += d))
    res.on('end', () => { process.stdout.write(out); process.exit(0) })
  })
  req.on('error', () => process.exit(0))
  req.end(body)
})
`

export const hostBinDir = (): string => path.join(gurtRoot, 'bin')
export const hostCredHelperPath = (): string => path.join(hostBinDir(), 'gurt-credential-host.cjs')

/** The in-flight (or completed) materialization, not a done-flag: concurrent
 *  first callers must share one write — two unserialized `writeFile`s into the
 *  same path can hand a third caller a half-written helper to spawn. Same
 *  shape as hostCredBroker.ts's `hostBroker`. */
let hostHelper: Promise<string> | null = null

/** Materialize the host credential helper (idempotent per app run) and return its path. */
export function ensureHostCredHelper(): Promise<string> {
  if (!hostHelper) {
    hostHelper = (async () => {
      const file = hostCredHelperPath()
      await fs.mkdir(hostBinDir(), { recursive: true })
      await fs.writeFile(file, HOST_CRED_HELPER)
      return file
    })().catch((e: unknown) => {
      hostHelper = null // a failed write must not poison every later call
      throw e
    })
  }
  return hostHelper
}
