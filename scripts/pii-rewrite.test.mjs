// The host's rewrite endpoint for a masking session's MCP traffic
// (src/main/piiRewrite.ts, docs/requirements-pii-mask.md §9.2): the token is the
// whole authentication, `reveal` is an oracle only the proxy may consult, and an
// encode that fails is an error — never a pass-through.
//
//   node scripts/pii-rewrite.test.mjs
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-pii-rewrite-${process.pid}.mjs`)
await build({
  stdin: {
    contents: `export { servePiiRewrite, stopPiiRewrite } from ${JSON.stringify(path.join(ROOT, 'src/main/piiRewrite.ts'))}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  mainFields: ['module', 'main'],
  outfile,
  logLevel: 'silent'
})
const m = await import(pathToFileURL(outfile).href)

const REAL = 'jane@example.com'
let encodeFails = false
const encoded = []
const mask = {
  ready: () => true,
  decode: (id, text) => (id === 's1' ? text.split('[email:1]').join(REAL) : text),
  encode: async (id, text) => {
    encoded.push(text)
    if (encodeFails) throw new Error('detector is down')
    return text.split(REAL).join('[email:1]')
  }
}

// `host.docker.internal` is this machine; the test dials loopback on the port.
const url = await m.servePiiRewrite('s1', mask)
const base = url.replace('host.docker.internal', '127.0.0.1')
const other = (await m.servePiiRewrite('s2', mask)).replace('host.docker.internal', '127.0.0.1')

const post = async (u, strings) => {
  const res = await fetch(u, { method: 'POST', body: JSON.stringify({ strings }) })
  return { status: res.status, body: res.status === 200 ? await res.json() : null }
}

assert.match(url, /^http:\/\/host\.docker\.internal:\d+\/pii\/[A-Za-z0-9_-]{40,}$/, 'a long unguessable token in the url')
assert.equal((await m.servePiiRewrite('s1', mask)), url, 're-attaching keeps the token the running proxy already has')

{
  const r = await post(`${base}/reveal`, ['mail [email:1]', 'plain', ''])
  assert.deepEqual(r.body, { strings: [`mail ${REAL}`, 'plain', ''] })
}
{
  encoded.length = 0
  const r = await post(`${base}/encode`, [`to ${REAL}`, `to ${REAL}`, 'hi', 'x'])
  assert.deepEqual(r.body, { strings: ['to [email:1]', 'to [email:1]', 'hi', 'x'] }, 'order and length are preserved')
  assert.equal(encoded.filter((s) => s.startsWith('to ')).length, 1, 'a repeated string is detected once')
  assert.ok(!encoded.includes('hi') && !encoded.includes('x'), 'strings under three characters are not worth a detector call')
}

// Sessions are isolated: the other session's token reveals against *its* table.
assert.deepEqual((await post(`${other}/reveal`, ['[email:1]'])).body, { strings: ['[email:1]'] })

// No token, a wrong token, a wrong method, a wrong path: all the same 404.
for (const u of [
  base.replace(/\/pii\/.*/, '/pii/nope/reveal'),
  base.replace(/\/pii\/.*/, '/reveal'),
  `${base}/other`,
  `${base.replace(/.$/, '')}X/reveal`
])
  assert.equal((await post(u, ['x'])).status, 404, u)
assert.equal((await fetch(`${base}/reveal`)).status, 404, 'GET is not a method here')

// Bad bodies are a 500, not a crash and not a pass-through.
assert.equal((await fetch(`${base}/reveal`, { method: 'POST', body: 'not json' })).status, 500)
assert.equal((await fetch(`${base}/reveal`, { method: 'POST', body: '{"strings":[1]}' })).status, 500)

// Fail closed: a detector that is down is an error the proxy must report.
encodeFails = true
assert.equal((await post(`${base}/encode`, [`to ${REAL}`])).status, 500)
encodeFails = false

// A stopped session's token stops working.
m.stopPiiRewrite('s1')
assert.equal((await post(`${base}/reveal`, ['x'])).status, 404)
m.stopPiiRewrite('s2')

fs.rmSync(outfile, { force: true })
console.log('pii-rewrite.test.mjs: ok')
