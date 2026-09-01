// The scrub-on-read invariant (docs/requirements-session-operator.md §8,
// acceptance §12 item 6): a credential planted in the store survives into
// neither `get_provisioning_log` nor a config read — in raw, base64 and
// base64url form — whether it sits in a provisioning log file or in a
// `workspace.json` header value. The test is the requirement: a convention
// that is not executed is a convention that has already drifted.
//
//   node scripts/scrub.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-scrub-'))
process.env.GURT_ROOT = GURT_ROOT
process.env.GURT_FORCE_PLAINTEXT = '1'

const outfile = path.join(os.tmpdir(), `gurt-scrub-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await bundle({
  stdin: {
    contents:
      `export { createKernel } from ${S('src/main/kernel.ts')}\n` +
      `export { createAdminSurface } from ${S('src/main/adminSurface.ts')}\n` +
      `export { loadSecrets } from ${S('src/main/credentials.ts')}\n` +
      `export { sessionLogFilePath } from ${S('src/main/log.ts')}\n` +
      `export { scrub } from ${S('src/main/scrub.ts')}\n` +
      `export { addSecrets } from ${S('src/main/redact.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  external: ['electron'],
  outfile
})

const m = await import(pathToFileURL(outfile).href)

// The planted credential, and its three forms (§8: raw, base64, base64url —
// the same forms the log redactor registers).
const SECRET = 'tok/live+secret~credential-9000'
const B64 = Buffer.from(SECRET, 'utf8').toString('base64')
const B64URL = Buffer.from(SECRET, 'utf8').toString('base64url')
const FORMS = [SECRET, B64, B64.replace(/=+$/, ''), B64URL]

const ws = 'w'
fs.mkdirSync(path.join(GURT_ROOT, ws, 't'), { recursive: true })
fs.writeFileSync(
  path.join(GURT_ROOT, ws, 'workspace.json'),
  JSON.stringify({
    repos: [],
    envs: [{ name: 'dev', devcontainer: JSON.stringify({ image: 'x', note: SECRET }) }],
    // The §8 case in so many words: a secret sitting in an MCP entry's static
    // header, pasted rather than linked.
    mcpServers: [
      {
        id: 'up',
        url: 'https://mcp.example/mcp',
        headers: [
          { name: 'Authorization', value: `Bearer ${SECRET}` },
          { name: 'X-B64', value: B64 },
          { name: 'X-B64URL', value: B64URL }
        ]
      }
    ]
  })
)
fs.writeFileSync(path.join(GURT_ROOT, ws, 't', 'task.json'), JSON.stringify({}))
fs.writeFileSync(path.join(GURT_ROOT, 'agents.json'), JSON.stringify({}))
// Plant the credential in the store; loadSecrets below is the startup path
// that feeds the redactor from it.
fs.writeFileSync(
  path.join(GURT_ROOT, 'credentials.json'),
  JSON.stringify({
    credentials: [
      { id: 'c1', label: 'planted', kind: 'mcp-token', hosts: [], data: { secret: SECRET } }
    ]
  })
)

await m.loadSecrets()
const kernel = m.createKernel()
await kernel.ready
const admin = m.createAdminSurface(kernel)

const assertClean = (text, where) => {
  for (const form of FORMS)
    assert.ok(!text.includes(form), `${where} leaks no form of the credential (${form})`)
}

after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

test('the scrub itself: every string at every depth, plus the key deny-list', () => {
  const scrubbed = m.scrub({
    deep: { list: [SECRET, { s: `prefix ${B64} suffix` }, B64URL] },
    // Key-based: the value under a denied key is replaced whole, whatever it is.
    api_key: 'not-even-a-registered-secret',
    authorization: { nested: 'whole subtree gone' },
    // The documented exceptions: links and names, never secret bytes.
    credentialId: 'cred-1',
    credentialEnvVar: 'LINEAR_API_KEY'
  })
  const text = JSON.stringify(scrubbed)
  assertClean(text, 'scrub()')
  assert.equal(scrubbed.api_key, '[redacted]', 'denied key redacted by name')
  assert.equal(scrubbed.authorization, '[redacted]', 'denied key redacts the whole value')
  assert.equal(scrubbed.credentialId, 'cred-1', 'a credential link is an id, not a secret')
  assert.equal(scrubbed.credentialEnvVar, 'LINEAR_API_KEY', 'an env var name is a name')
})

test('config reads: the workspace.json header value never crosses the boundary', async () => {
  const servers = JSON.stringify(await admin.call(ws, 'getMcpServers', {}))
  assertClean(servers, 'get_mcp_servers')
  assert.match(servers, /\[redacted\]/, 'the slot shows it was scrubbed, not dropped')
  assert.match(servers, /Authorization/, 'the header *name* survives — it is not the secret')

  const tree = JSON.stringify(await admin.call(ws, 'getTree', {}))
  assertClean(tree, 'get_tree (env devcontainer content)')
})

test('get_provisioning_log: a log file carrying the credential comes back scrubbed', async () => {
  // Written straight to the file, bypassing the write-time sanitizer on
  // purpose: §8's rule is on the READ path, and must hold even for bytes that
  // predate it (or slipped past it).
  const key = `env-build:${ws}/dev`
  const file = m.sessionLogFilePath(key)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    [`building image`, `token=${SECRET}`, `b64=${B64}`, `b64url=${B64URL}`, `done`].join('\n') + '\n'
  )
  const out = await admin.provisioningLog(ws, key, undefined)
  assertClean(out, 'get_provisioning_log')
  assert.match(out, /building image/, 'the harmless lines survive')
  assert.match(out, /\[redacted\]/, 'the secret slots say what happened')

  // Tail-limiting still applies after the scrub.
  const tail = await admin.provisioningLog(ws, key, 1)
  assert.equal(tail.trim(), 'done', 'tail=1 returns the last line')
})
