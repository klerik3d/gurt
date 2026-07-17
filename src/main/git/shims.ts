// Container shims + the host credential helper, kept as source strings and
// materialized on demand (the same lazy pattern as the ACP adapter install).
// All container shims are small node scripts (node is guaranteed by
// BASE_FEATURES); the host helper runs under Electron-in-node like the CLI.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { gurtRoot } from '../store'
import { SHIM_DIR } from './config'

// --- container shims --------------------------------------------------------

/** Prepends the shim dir to PATH for the agent's process tree, then runs argv. */
const GURT_LAUNCH = `#!/usr/bin/env node
'use strict'
const { spawn } = require('child_process')
const argv = process.argv.slice(2)
const cmd = argv.shift()
if (!cmd) { process.stderr.write('gurt-launch: nothing to run\\n'); process.exit(2) }
const PATH = '${SHIM_DIR}:' + (process.env.PATH || '')
const child = spawn(cmd, argv, { stdio: 'inherit', env: Object.assign({}, process.env, { PATH: PATH }) })
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => { try { child.kill(s) } catch (e) {} })
child.on('exit', (code, sig) => process.exit(sig ? 1 : (code == null ? 0 : code)))
child.on('error', (e) => { process.stderr.write('gurt-launch: ' + e.message + '\\n'); process.exit(127) })
`

/** git credential helper: forwards \`get\` to the host broker; store/erase no-op. */
const GURT_GIT_CREDENTIAL = `#!/usr/bin/env node
'use strict'
const http = require('http')
if (process.argv[2] !== 'get') process.exit(0)
let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  const broker = process.env.GURT_GIT_BROKER
  if (!broker) process.exit(0)
  let url
  try { url = new URL(broker.replace(/\\/$/, '') + '/credential') } catch (e) { process.exit(0) }
  const body = Buffer.from(input)
  const req = http.request(url, { method: 'POST', headers: { 'content-type': 'text/plain', 'content-length': body.length } }, (res) => {
    if (res.statusCode !== 200) { res.resume(); process.exit(0) }
    let out = ''
    res.on('data', (d) => (out += d))
    res.on('end', () => { process.stdout.write(out); process.exit(0) })
  })
  req.on('error', () => process.exit(0))
  req.end(body)
})
`

/** github provider wrapper: fetch a forge token per invocation, exec real gh. */
const GH_WRAPPER = `#!/usr/bin/env node
'use strict'
const { spawn } = require('child_process')
const http = require('http')
const path = require('path')
const fs = require('fs')
const SELF_DIR = '${SHIM_DIR}'
function realGh() {
  for (const d of (process.env.PATH || '').split(':')) {
    if (!d || path.resolve(d) === SELF_DIR) continue
    const p = path.join(d, 'gh')
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch (e) {}
  }
  return null
}
function forgeEnv() {
  return new Promise((resolve) => {
    const broker = process.env.GURT_GIT_BROKER
    if (!broker) return resolve({})
    let url
    try { url = new URL(broker.replace(/\\/$/, '') + '/forge-env') } catch (e) { return resolve({}) }
    const req = http.request(url, { method: 'GET' }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve({}) }
      let out = ''
      res.on('data', (d) => (out += d))
      res.on('end', () => { try { resolve(JSON.parse(out)) } catch (e) { resolve({}) } })
    })
    req.on('error', () => resolve({}))
    req.end()
  })
}
;(async () => {
  const gh = realGh()
  if (!gh) { process.stderr.write('gh is not installed in this container; rebuild the environment\\n'); process.exit(1) }
  const extra = await forgeEnv()
  const child = spawn(gh, process.argv.slice(2), { stdio: 'inherit', env: Object.assign({}, process.env, extra) })
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => { try { child.kill(s) } catch (e) {} })
  child.on('exit', (code, sig) => process.exit(sig ? 1 : (code == null ? 0 : code)))
  child.on('error', () => process.exit(127))
})()
`

/** name → source for every installable container shim. */
export const CONTAINER_SHIMS: Record<string, string> = {
  'gurt-launch': GURT_LAUNCH,
  'gurt-git-credential': GURT_GIT_CREDENTIAL,
  gh: GH_WRAPPER
}

/** Always-installed container shims (the launcher + credential helper). */
export const BASE_SHIMS = ['gurt-launch', 'gurt-git-credential']

/**
 * A single `sh -c` payload that writes the requested shims into SHIM_DIR and
 * marks them world-executable. Content rides in base64 so no quoting escapes
 * the command line. Run as root via `docker exec -u root ... sh -c <payload>`
 * (see provision.installGitShims) — explicit modes, since root's umask varies.
 */
export function shimInstallScript(names: string[]): string {
  const parts = [`mkdir -p ${SHIM_DIR}`, `chmod 755 ${SHIM_DIR}`]
  for (const name of names) {
    const src = CONTAINER_SHIMS[name]
    if (!src) continue
    const b64 = Buffer.from(src, 'utf8').toString('base64')
    const target = `${SHIM_DIR}/${name}`
    parts.push(`printf %s '${b64}' | base64 -d > ${target}`)
    parts.push(`chmod 755 ${target}`)
  }
  return parts.join(' && ')
}

// --- host credential helper -------------------------------------------------

/**
 * Host git credential helper (§8). Returns the pre-resolved credential's token
 * for https; the entry id arrives in GURT_CRED_ID and the secret is read from
 * credentials.json — never through env or argv. Answers only for the host the
 * credential was resolved for (GURT_CRED_HOST): a fetch that wanders to another
 * host (submodule, redirect) must not receive this token, and must not fall
 * through to ambient auth either. Runs under Electron-in-node, so it is a
 * CommonJS `.cjs` regardless of any ambient package.json.
 */
export const HOST_CRED_HELPER = `'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')
if (process.argv[2] !== 'get') process.exit(0)
let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  const id = process.env.GURT_CRED_ID
  const credHost = process.env.GURT_CRED_HOST
  if (!id || !credHost) process.exit(0)
  const fields = {}
  for (const line of input.split('\\n')) {
    const i = line.indexOf('=')
    if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  if (fields.host !== credHost) process.exit(0)
  const root = process.env.GURT_ROOT || path.join(os.homedir(), '.gurt')
  let file
  try { file = JSON.parse(fs.readFileSync(path.join(root, 'credentials.json'), 'utf8')) } catch (e) { process.exit(0) }
  const entry = (file.credentials || []).find((c) => c.id === id)
  if (!entry || entry.kind !== 'git-token' || !entry.data || !entry.data.secret) process.exit(0)
  const user = entry.data.username || 'x-access-token'
  process.stdout.write('username=' + user + '\\n' + 'password=' + entry.data.secret + '\\n')
  process.exit(0)
})
`

export const hostBinDir = (): string => path.join(gurtRoot, 'bin')
export const hostCredHelperPath = (): string => path.join(hostBinDir(), 'gurt-credential-host.cjs')

let hostHelperWritten = false

/** Materialize the host credential helper (idempotent per app run) and return its path. */
export async function ensureHostCredHelper(): Promise<string> {
  const file = hostCredHelperPath()
  if (!hostHelperWritten) {
    await fs.mkdir(hostBinDir(), { recursive: true })
    await fs.writeFile(file, HOST_CRED_HELPER)
    hostHelperWritten = true
  }
  return file
}
