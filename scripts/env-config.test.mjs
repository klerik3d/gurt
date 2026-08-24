// Pure-node tests for the env devcontainer normal form (no docker, no
// electron): JSONC parsing, the validation matrix, envImageTag identity
// (verified against node:crypto — envConfig ships a pure-JS sha256 because the
// module is shared with the renderer), and the old-Dockerfile-mode migration +
// store-level validation. Bundles on the fly with esbuild, like the others.
//
//   node scripts/env-config.test.mjs
import { test, after } from 'node:test'
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-env-config-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

// gurtRoot is read from GURT_ROOT at module load — set it before the import.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-env-config-'))
process.env.GURT_ROOT = GURT_ROOT

await build({
  stdin: {
    contents: `
      export { parseEnvDevcontainer, validateEnvConfig, envImageTag } from ${S('src/shared/envConfig.ts')}
      export { getWorkspace, addEnv, updateEnv } from ${S('src/main/store.ts')}
    `,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  // jsonc-parser's `main` is a UMD build esbuild can't wrap into ESM output —
  // prefer each package's ESM entry, like vite does.
  mainFields: ['module', 'main'],
  external: ['electron'],
  outfile,
  logLevel: 'silent',
  sourcemap: 'inline'
})

const m = await import(pathToFileURL(outfile).href)
const read = (p) => fs.readFileSync(p, 'utf8')

const URL1 = 'https://github.com/o/r.git'
const ws = 'ws1'

after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

// --- JSONC with comments parses ---
test('JSONC parsing', () => {
  const jsonc = `{
    // build-flavored config
    "build": {
      "dockerfile": "Dockerfile", /* companion */
      "args": { "NODE": "20" },
    },
    "remoteUser": "dev",
  }`
  const parsed = m.parseEnvDevcontainer(jsonc)
  assert.equal(parsed.error, undefined, 'JSONC with comments parses')
  assert.equal(parsed.config.remoteUser, 'dev')
  assert.deepEqual(parsed.build, { dockerfile: 'Dockerfile', args: { NODE: '20' } })
  assert.ok(m.parseEnvDevcontainer('{ nope').error, 'parse error is reported')
  assert.ok(m.parseEnvDevcontainer('[1,2]').error, 'non-object root is an error')
})

// --- validation matrix ---
test('validation matrix', () => {
  const env = (devcontainer, dockerfile) => ({ name: 'e', devcontainer, dockerfile })
  assert.equal(m.validateEnvConfig(env('')), 'devcontainer config is required')
  assert.match(m.validateEnvConfig(env('{ nope')), /devcontainer/)
  assert.equal(
    m.validateEnvConfig(env('{"build":{"dockerfile":"Dockerfile"}}')),
    'Dockerfile is required when devcontainer has a build section'
  )
  assert.equal(m.validateEnvConfig(env('{"build":{"dockerfile":"Dockerfile"}}', 'FROM x')), null)
  assert.equal(m.validateEnvConfig(env('{"image":"x"}')), null)
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

// --- migration: old Dockerfile-mode env gets a synthesized build config ---
test('Dockerfile-mode migration + write-once', async () => {
  fs.mkdirSync(path.join(GURT_ROOT, ws), { recursive: true })
  const wsPath = path.join(GURT_ROOT, ws, 'workspace.json')
  fs.writeFileSync(
    wsPath,
    JSON.stringify({
      repos: [{ name: 'r', url: URL1 }],
      envs: [
        { name: 'dockermode', devcontainer: '', dockerfile: 'FROM scratch\n', dockerfilePath: 'Dockerfile', repo: 'r' },
        { name: 'blank', devcontainer: '' },
        { name: 'plain', devcontainer: '{"image":"x"}' }
      ]
    })
  )
  const before = read(wsPath)
  const data = await m.getWorkspace(ws)
  const dockermode = data.envs.find((e) => e.name === 'dockermode')
  assert.equal(
    dockermode.devcontainer,
    JSON.stringify({ build: { dockerfile: 'Dockerfile' } }, null, 2),
    'synthesized build config'
  )
  assert.equal(dockermode.dockerfile, 'FROM scratch\n', 'dockerfile kept as-is')
  assert.equal(dockermode.dockerfilePath, 'Dockerfile', 'dockerfilePath kept as-is')
  assert.equal(m.validateEnvConfig(dockermode), null, 'migrated env is valid')
  assert.equal(data.envs.find((e) => e.name === 'blank').devcontainer, '', 'blank env stays as-is')
  assert.equal(data.envs.find((e) => e.name === 'plain').devcontainer, '{"image":"x"}')
  const after = read(wsPath)
  assert.notEqual(after, before, 'workspace.json rewritten on first read')
  await m.getWorkspace(ws)
  assert.equal(read(wsPath), after, 'write-back happens exactly once')
})

// --- store rejects configs failing validateEnvConfig ---
test('store validation', async () => {
  await assert.rejects(
    () => m.addEnv(ws, { name: 'bad', devcontainer: '' }),
    /devcontainer config is required/
  )
  await assert.rejects(
    () => m.addEnv(ws, { name: 'bad2', devcontainer: '{"build":{"dockerfile":"Dockerfile"}}' }),
    /Dockerfile is required/
  )
  await m.addEnv(ws, { name: 'good', devcontainer: '{"image":"x"}' })
  await assert.rejects(
    () => m.updateEnv(ws, { name: 'good', devcontainer: '{ nope' }),
    /devcontainer/
  )
})
