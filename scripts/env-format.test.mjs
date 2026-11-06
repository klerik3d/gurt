// Pure-node tests for gurt's env format (docs/requirements-env-docker.md; no
// docker, no electron): the validation matrix, the KEY=VALUE lines of the
// editor, and envImageTag identity (verified against node:crypto — envConfig
// ships a pure-JS sha256 because the module is shared with the renderer).
// Bundles on the fly with esbuild, like the others.
//
//   node scripts/env-format.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-env-format-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

// gurtRoot is read from GURT_ROOT at module load — set it before the import.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-env-format-'))
process.env.GURT_ROOT = GURT_ROOT

await bundle({
  stdin: {
    contents: `
      export { parseEnvConfigText, parseEnvLines, formatEnvLines, validateEnvConfig, envImageTag } from ${S('src/shared/envConfig.ts')}
      export { getWorkspace, addEnv, updateEnv } from ${S('src/main/store.ts')}
    `,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  external: ['electron'],
  outfile
})

const m = await import(pathToFileURL(outfile).href)

const URL1 = 'https://github.com/o/r.git'
const ws = 'ws1'

after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

// --- validation matrix ---
test('validation matrix', () => {
  const v = (e) => m.validateEnvConfig({ name: 'e', ...e })
  assert.equal(v({ image: 'x' }), null)
  assert.equal(v({ image: 'node:22@sha256:abc' }), null)
  assert.equal(v({ dockerfile: 'FROM x' }), null)
  assert.match(v({}), /image or a Dockerfile is required/)
  assert.match(v({ image: ' ' }), /required/)
  assert.match(v({ image: 'x', dockerfile: 'FROM x' }), /not both/)
  assert.match(v({ image: 'x', build: { target: 't' } }), /need a Dockerfile/)
  assert.equal(v({ dockerfile: 'FROM x', build: { context: 'sub/dir', args: { A: '1' } } }), null)
  assert.equal(v({ dockerfile: 'FROM x', build: { context: 'a/../b' } }), null)
  for (const bad of ['/abs', '..', '../x', 'a/../../x', 'C:\\x', ''])
    assert.match(v({ dockerfile: 'FROM x', build: { context: bad } }), /build\.context/, bad)
  assert.equal(v({ image: 'x', env: { A_1: 'v', _b: '' } }), null)
  for (const k of ['1A', 'A-B', 'A B', ''])
    assert.match(v({ image: 'x', env: { [k]: 'v' } }), /env key/, k)
})

test('KEY=VALUE lines', () => {
  assert.deepEqual(m.parseEnvLines('A=1\n# c\n\nB = x=y\r\n'), { vars: { A: '1', B: ' x=y' } })
  assert.match(m.parseEnvLines('A=1\nnope').error, /line 2/)
  assert.match(m.parseEnvLines('=v').error, /line 1/)
  assert.equal(m.formatEnvLines({ A: '1', B: '2' }), 'A=1\nB=2')
  assert.equal(m.formatEnvLines(undefined), '')
})

test('bundled-style env text parses (JSONC)', () => {
  const r = m.parseEnvConfigText('starter', '{ // c\n "image": "node:22", }')
  assert.deepEqual(r, { name: 'starter', image: 'node:22' })
  assert.ok(m.parseEnvConfigText('x', '{ nope').error)
})

// --- envImageTag: stable identity, verified against node:crypto ---
test('envImageTag identity', () => {
  const t1 = m.envImageTag(URL1, 'c0ffee', 'FROM scratch', {
    dockerfile: 'Dockerfile',
    context: '..',
    args: { B: '2', A: '1' }
  })
  // equal inputs (modulo build key order and the dockerfile *path*) ⇒ same tag
  const t1b = m.envImageTag(URL1, 'c0ffee', 'FROM scratch', {
    args: { A: '1', B: '2' },
    dockerfile: 'elsewhere/Dockerfile.dev',
    context: '..'
  })
  assert.equal(t1, t1b, 'tag is stable across key order and dockerfile path')
  // canonical form: build without `dockerfile`, keys sorted at every level
  const canonical = '{"args":{"A":"1","B":"2"},"context":".."}'
  const expected =
    'gurt-env:' +
    createHash('sha256')
      .update(`${URL1}\nc0ffee\nFROM scratch\n${canonical}`)
      .digest('hex')
      .slice(0, 16)
  assert.equal(t1, expected, 'tag matches node:crypto sha256 of the canonical input')
  // each identity ingredient changes the tag
  const base = () => ({ dockerfile: 'Dockerfile', context: '..', args: { A: '1', B: '2' } })
  assert.notEqual(t1, m.envImageTag(URL1, 'c0ffee', 'FROM scratch\nLABEL x=1', base()))
  assert.notEqual(t1, m.envImageTag(URL1, 'c0ffee', 'FROM scratch', { ...base(), args: { A: '9', B: '2' } }))
  assert.notEqual(t1, m.envImageTag(URL1, 'deadbeef', 'FROM scratch', base()))
  assert.notEqual(t1, m.envImageTag(URL1, 'c0ffee', 'FROM scratch', { ...base(), target: 'dev' }))
  // pure-JS sha256 vs node:crypto across padding boundaries + multi-byte input
  for (const n of [0, 1, 54, 55, 56, 63, 64, 65, 200]) {
    const s = 'x'.repeat(n) + (n % 2 ? ' привет 🐳' : '')
    const exp =
      'gurt-env:' +
      createHash('sha256').update(`${s}\n\n\n{}`).digest('hex').slice(0, 16)
    assert.equal(m.envImageTag(s, '', '', {}), exp, `sha256 mismatch at len ${n}`)
  }
})

// --- store rejects configs failing validateEnvConfig ---
test('store validation', async () => {
  await assert.rejects(() => m.addEnv(ws, { name: 'bad' }), /image or a Dockerfile is required/)
  await assert.rejects(() => m.addEnv(ws, { name: 'bad2', image: 'x', dockerfile: 'FROM x' }), /not both/)
  await m.addEnv(ws, { name: 'good', image: 'x' })
  await assert.rejects(() => m.updateEnv(ws, { name: 'good', image: 'x', env: { 'A B': '1' } }), /env key/)
})
