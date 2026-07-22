// Tests for the container shims + host credential helper (shims.ts) — the pure
// parts only: shim sources and the install payload (executed under plain sh
// into a scratch dir, no docker), and the host helper materialization + its
// credential 'get' behavior driven as a plain node subprocess (no git flows).
import { afterAll, it } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

// GURT_ROOT must be set before the modules load (read at import time).
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-shims-'))
process.env.GURT_ROOT = GURT_ROOT
const {
  BASE_SHIMS,
  CONTAINER_SHIMS,
  HOST_CRED_HELPER,
  shimInstallScript,
  ensureHostCredHelper,
  hostBinDir,
  hostCredHelperPath
} = await import('../src/main/git/shims')
const { SHIM_DIR } = await import('../src/main/git/config')

const ALL_SHIMS = [...BASE_SHIMS, 'gh']

afterAll(() => {
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

// --- container shims --------------------------------------------------------

it('CONTAINER_SHIMS / BASE_SHIMS: base shims present, all sources are node scripts that parse', () => {
  assert.deepEqual(BASE_SHIMS, ['gurt-launch', 'gurt-git-credential'])
  for (const name of BASE_SHIMS) assert.ok(CONTAINER_SHIMS[name], `${name} is installable`)
  assert.ok(CONTAINER_SHIMS.gh, 'the github forge wrapper is installable')
  for (const [name, src] of Object.entries(CONTAINER_SHIMS)) {
    assert.ok(src.startsWith('#!/usr/bin/env node\n'), `${name} is a node script`)
    assert.doesNotThrow(() => new Function(src.replace(/^#!.*\n/, '')), `${name} parses as JS`)
  }
  // the launcher prepends SHIM_DIR to PATH; the gh wrapper skips itself via SHIM_DIR
  assert.ok(CONTAINER_SHIMS['gurt-launch'].includes(SHIM_DIR))
  assert.ok(CONTAINER_SHIMS.gh.includes(SHIM_DIR))
})

it('shimInstallScript: one sh payload — base64 round-trips, explicit 755 modes, unknown names skipped', () => {
  const script = shimInstallScript(ALL_SHIMS)
  assert.ok(script.startsWith(`mkdir -p ${SHIM_DIR} && chmod 755 ${SHIM_DIR}`))
  const decoded = new Map<string, string>()
  for (const m of script.matchAll(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > (\S+)/g))
    decoded.set(m[2], Buffer.from(m[1], 'base64').toString('utf8'))
  for (const name of ALL_SHIMS) {
    const target = `${SHIM_DIR}/${name}`
    assert.equal(decoded.get(target), CONTAINER_SHIMS[name], `${name} rides base64, byte-exact`)
    assert.ok(script.includes(`chmod 755 ${target}`), `${name} marked world-executable`)
  }
  // sources never appear unencoded, so no quoting can escape the command line
  assert.ok(!script.includes('use strict'))
  // unknown names are skipped; an empty list still prepares the dir
  const skipped = shimInstallScript(['gurt-launch', 'no-such-shim'])
  assert.equal((skipped.match(/printf %s/g) ?? []).length, 1)
  assert.ok(!skipped.includes('no-such-shim'))
  assert.equal(shimInstallScript([]), `mkdir -p ${SHIM_DIR} && chmod 755 ${SHIM_DIR}`)
})

it('shimInstallScript executes under sh: writes executable shims (SHIM_DIR redirected)', () => {
  const bin = path.join(GURT_ROOT, 'shim-exec')
  // SHIM_DIR appears in the raw script only as install targets (content is
  // base64), so redirecting it exercises the real payload against a scratch dir.
  const script = shimInstallScript(ALL_SHIMS).split(SHIM_DIR).join(bin)
  execFileSync('/bin/sh', ['-c', script])
  assert.equal(fs.statSync(bin).mode & 0o777, 0o755)
  for (const name of ALL_SHIMS) {
    const file = path.join(bin, name)
    assert.equal(fs.readFileSync(file, 'utf8'), CONTAINER_SHIMS[name], `${name} content intact`)
    assert.equal(fs.statSync(file).mode & 0o777, 0o755, `${name} is executable`)
  }
})

// --- host credential helper -------------------------------------------------

it('HOST_CRED_HELPER is plain CommonJS (no shebang), syntactically valid', () => {
  assert.ok(!HOST_CRED_HELPER.startsWith('#!'), 'runs under Electron-in-node, not via shebang')
  assert.doesNotThrow(() => new Function(HOST_CRED_HELPER))
})

it('ensureHostCredHelper materializes under GURT_ROOT/bin, once per app run', async () => {
  const p = await ensureHostCredHelper()
  assert.equal(p, hostCredHelperPath())
  assert.equal(p, path.join(GURT_ROOT, 'bin', 'gurt-credential-host.cjs'))
  assert.equal(hostBinDir(), path.join(GURT_ROOT, 'bin'))
  assert.equal(fs.readFileSync(p, 'utf8'), HOST_CRED_HELPER)
  // Idempotent per run: a second call must not rewrite the file.
  fs.writeFileSync(p, '// tampered')
  assert.equal(await ensureHostCredHelper(), p)
  assert.equal(fs.readFileSync(p, 'utf8'), '// tampered', 'second call does not rewrite')
  fs.writeFileSync(p, HOST_CRED_HELPER) // restore for the behavior test below
})

it('host helper answers get only for its resolved host, secret from credentials.json', async () => {
  const helper = await ensureHostCredHelper()
  fs.writeFileSync(
    path.join(GURT_ROOT, 'credentials.json'),
    JSON.stringify({
      credentials: [
        { id: 'c1', label: 'gh', kind: 'git-token', hosts: ['github.com'], data: { secret: 'TOP' } },
        {
          id: 'c2',
          label: 'named',
          kind: 'git-token',
          hosts: ['gitlab.com'],
          data: { secret: 'T2', username: 'bob' }
        },
        { id: 'c3', label: 'ambient', kind: 'git-host', hosts: [], data: {} }
      ]
    })
  )
  // The helper is a node script (Electron-in-node in production); the test's
  // own node stands in — no git, no network.
  const run = (arg: string, input: string, env: Record<string, string> = {}) =>
    execFileSync(process.execPath, [helper, arg], {
      input,
      encoding: 'utf8',
      env: { ...process.env, GURT_ROOT, GURT_CRED_ID: 'c1', GURT_CRED_HOST: 'github.com', ...env }
    })
  // resolved host: username defaults to x-access-token; explicit username wins
  assert.equal(run('get', 'protocol=https\nhost=github.com\n'), 'username=x-access-token\npassword=TOP\n')
  assert.equal(
    run('get', 'protocol=https\nhost=gitlab.com\n', { GURT_CRED_ID: 'c2', GURT_CRED_HOST: 'gitlab.com' }),
    'username=bob\npassword=T2\n'
  )
  // a request wandering to another host (submodule, redirect) gets nothing
  assert.equal(run('get', 'protocol=https\nhost=evil.example.com\n'), '')
  // store/erase are no-ops; non-token entries and unknown ids serve nothing
  assert.equal(run('store', 'protocol=https\nhost=github.com\n'), '')
  assert.equal(run('get', 'protocol=https\nhost=github.com\n', { GURT_CRED_ID: 'c3' }), '')
  assert.equal(run('get', 'protocol=https\nhost=github.com\n', { GURT_CRED_ID: 'missing' }), '')
})
