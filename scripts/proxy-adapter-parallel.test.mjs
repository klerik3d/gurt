// `resolveLaunch`'s steps 3-5 (docs/requirements-mcp-proxy.md §7.1):
// the adapter install (step 3) and reserving the session's proxy scope (the
// first half of step 4) both only need the container's *current* network —
// neither one is what closes it — so `ContainerManager.installAdapterAndProxy`
// runs them concurrently. The network switch onto the proxy (the second half
// of step 4, and step 5) is what actually ends the open-network window step 3
// needs, so it must not start until the install settles.
//
// Two invariants, in the order they matter:
//   1. The switch never runs before the install finishes — running it early
//      would put the container behind the proxy while `npm install -g` is
//      still relying on the open network, silently breaking §7.1's ordering.
//   2. The proxy-scope reservation is not serialized behind the install —
//      that concurrency is the entire point of the change (a faster warm
//      start), so a regression that accidentally re-serializes them should
//      fail this file even though it would not fail any behavioral check.
//   3. Both branches' errors still reach the caller — parallelizing must not
//      turn a failure into a silently swallowed rejection.
//
// Driven straight at the seam `resolveLaunch` calls
// (`installAdapterAndProxy`), with `installAdapter` and `proxies.ensure`
// stubbed under manual control (so the ordering is asserted by construction,
// not by timers) and a fake `docker` on PATH answering only the network
// commands the switch itself makes.
//
//   node scripts/proxy-adapter-parallel.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

// store.ts reads GURT_ROOT at module load — set it before the import.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-proxy-adapter-parallel-'))
process.env.GURT_ROOT = GURT_ROOT

const outfile = path.join(os.tmpdir(), `gurt-proxy-adapter-parallel-${process.pid}.mjs`)
await bundle({
  stdin: {
    contents: `
      export { ContainerManager } from ${S('src/main/containers.ts')}
      export { createBus } from ${S('src/main/bus.ts')}
      export { proxies } from ${S('src/main/proxy/manager.ts')}
    `,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  external: ['electron'],
  outfile
})
const m = await import(pathToFileURL(outfile).href)

// --- a fake `docker` on PATH, answering only network inspect/connect -------
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-proxy-adapter-parallel-bin-'))
const STATE = path.join(BIN, 'daemon.json')
const FAKE = path.join(BIN, 'fake-docker.cjs')

fs.writeFileSync(
  FAKE,
  `'use strict'
const fs = require('fs')
const STATE = ${JSON.stringify(STATE)}
const args = process.argv.slice(2)
let state
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { process.exit(0) }
const save = () => fs.writeFileSync(STATE, JSON.stringify(state))
if (args[0] === 'inspect' && args.join(' ').includes('NetworkSettings.Networks')) {
  process.stdout.write((state.networks || []).join(' ') + ' \\n')
  process.exit(0)
}
if (args[0] === 'network' && (args[1] === 'connect' || args[1] === 'disconnect')) {
  const name = args[args.length - 2]
  state.networks =
    args[1] === 'connect'
      ? (state.networks || []).concat(name)
      : (state.networks || []).filter((n) => n !== name)
  save()
  process.exit(0)
}
process.exit(0)
`
)
fs.writeFileSync(
  path.join(BIN, 'docker'),
  `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`,
  { mode: 0o755 }
)
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`

after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(BIN, { recursive: true, force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

const daemon = (networks) => fs.writeFileSync(STATE, JSON.stringify({ networks }))
const attached = () => JSON.parse(fs.readFileSync(STATE, 'utf8')).networks

const bus = m.createBus()
const containers = new m.ContainerManager({
  bus,
  session: () => undefined,
  sessions: () => [],
  patchContainer: () => {},
  isSessionIdle: () => false,
  detach: () => {}
})

const CONTAINER = 'c0ffee0123456789ab'
const ws = 'w'
const task = 't'

/** A controllable stand-in for a promise-returning call: `release`/`fail`
 *  settle it on the test's own schedule. Recording the `:start` marker is the
 *  *caller's* job (in the stub that hands out `.promise`), not this
 *  constructor's — recording it here would stamp it at object-creation time,
 *  before the code under test has necessarily called anything. */
function deferred(order, label) {
  let release, fail
  const promise = new Promise((resolve, reject) => {
    release = (value) => {
      order.push(`${label}:end`)
      resolve(value)
    }
    fail = (e) => {
      order.push(`${label}:reject`)
      reject(e)
    }
  })
  return { promise, release, fail }
}

/** One session's worth of the seam's inputs — `installAdapter` is stubbed on
 *  the instance per call, `proxies.ensure` at the module level (the same
 *  thing `resolveLaunch`'s own `ensureProxyScope` reaches through). Each stub
 *  records its `:start` marker only when the code under test actually calls
 *  it, so a regression that re-serializes the two shows up as a wrong order
 *  in `order`, not just a wrong final state. */
function run(sessionId, { installFails = false, proxyFails = false } = {}) {
  const order = []
  const install = deferred(order, 'install')
  const proxyScope = deferred(order, 'proxy')
  containers.installAdapter = () => {
    order.push('install:start')
    return install.promise
  }
  m.proxies.ensure = () => {
    order.push('proxy:start')
    return proxyScope.promise
  }
  const info = { id: sessionId, workspace: ws, task, env: 'dev', repos: ['alpha'], network: { internal: false } }
  const target = { agent: {}, session: sessionId, containerId: CONTAINER, hostWorkspaceFolder: '/x', configArgs: [] }
  const p = containers.installAdapterAndProxy(info, CONTAINER, target)
  // Both branches have already run their synchronous prefix by now — nothing
  // async happens between `Promise.allSettled`'s argument evaluation and the
  // `await` that suspends it, so a call that actually serialized them (install
  // fully awaited before `ensureProxyScope` even runs) would not have reached
  // the second stub yet and this would read `['install:start']`.
  assert.deepEqual(order, ['install:start', 'proxy:start'], 'both start together, in the same tick')
  return {
    order,
    result: p,
    settleProxy: () => (proxyFails ? proxyScope.fail(new Error('proxy failed')) : proxyScope.release({
      session: sessionId,
      token: 't',
      containerId: `proxy-${sessionId}`,
      network: `gurt-s-${sessionId}`,
      base: 'http://127.0.0.1:1/',
      internal: false
    })),
    settleInstall: () => (installFails ? install.fail(new Error('install failed')) : install.release())
  }
}

test('the proxy scope resolves independently of the install — no serialization', async () => {
  daemon(['bridge'])
  const { order, result, settleProxy, settleInstall } = run('s1')
  settleProxy()
  await Promise.resolve() // let the settled branch's microtasks land
  assert.ok(order.includes('proxy:end'), 'the proxy branch finished on its own')
  assert.deepEqual(attached(), ['bridge'], 'and the network switch has not started — install is still pending')
  settleInstall()
  await result
  assert.deepEqual(order, ['install:start', 'proxy:start', 'proxy:end', 'install:end'])
})

test('the network switch waits for the install to settle, not just to start', async () => {
  daemon(['bridge'])
  const { result, settleProxy, settleInstall } = run('s2')
  settleProxy()
  await Promise.resolve()
  assert.deepEqual(attached(), ['bridge'], 'proxy alone does not trigger the switch')
  settleInstall()
  const runtime = await result
  assert.equal(runtime.session, 's2')
  assert.deepEqual(attached(), ['gurt-s-s2'], 'the switch ran only after the install resolved')
})

test('an install failure fails the whole call, and the switch never runs', async () => {
  daemon(['bridge'])
  const { result, settleProxy, settleInstall } = run('s3', { installFails: true })
  settleProxy()
  settleInstall()
  await assert.rejects(() => result, /install failed/)
  assert.deepEqual(attached(), ['bridge'], 'no switch — the invariant is: install runs, switch does not, on failure')
})

test('a proxy-scope failure fails the call too, with the install having succeeded', async () => {
  daemon(['bridge'])
  const { result, settleProxy, settleInstall } = run('s4', { proxyFails: true })
  settleInstall()
  settleProxy()
  await assert.rejects(() => result, /proxy failed/)
  assert.deepEqual(attached(), ['bridge'], 'still no switch — there is no proxy runtime to converge onto')
})

test('when both fail, the install error is the one that surfaces — same precedence as before', async () => {
  daemon(['bridge'])
  const { result, settleProxy, settleInstall } = run('s5', { installFails: true, proxyFails: true })
  settleProxy()
  settleInstall()
  await assert.rejects(() => result, /install failed/)
})
