// `resolveLaunch`'s steps 3-5 (docs/requirements-mcp-proxy.md §7.1):
// the container check (`ContainerManager.prepare` — skills link, node and
// adapter-bin probe) and reserving the session's proxy scope + switching its
// network (`prepareAndProxy`) run concurrently. Nothing in the check needs the
// network — the adapter is a read-only volume, not an `npm install` — so the
// open-network window ends as soon as the proxy's scope exists, and the switch
// must NOT wait for the check.
//
// Invariants, in the order they matter:
//   1. The check and the proxy scope start together (same tick) — a
//      regression that serializes them costs every start the sum.
//   2. The switch needs the proxy scope and nothing else: it runs while the
//      check is still pending (the window the old `npm install -g` held open
//      is gone).
//   3. Both branches' errors still reach the caller, the check's winning when
//      both fail; a proxy failure means no switch (no runtime to converge on).
//
// Driven straight at the seam `resolveLaunch` calls (`prepareAndProxy`), with
// `prepare` and `proxies.ensure` stubbed under manual control (ordering is
// asserted by construction, not by timers) and a fake `docker` on PATH
// answering only the network commands the switch itself makes.
//
//   node scripts/prepare-and-proxy.test.mjs
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
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-prepare-and-proxy-'))
process.env.GURT_ROOT = GURT_ROOT

const outfile = path.join(os.tmpdir(), `gurt-prepare-and-proxy-${process.pid}.mjs`)
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
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-prepare-and-proxy-bin-'))
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
// The fake docker rewrites STATE non-atomically: a read can land on a truncated file.
const attached = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8')).networks
  } catch {
    return []
  }
}

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

/** One session's worth of the seam's inputs — `prepare` is stubbed on
 *  the instance per call, `proxies.ensure` at the module level (the same
 *  thing `resolveLaunch`'s own `ensureProxyScope` reaches through). Each stub
 *  records its `:start` marker only when the code under test actually calls
 *  it, so a regression that re-serializes the two shows up as a wrong order
 *  in `order`, not just a wrong final state. */
function run(sessionId, { prepareFails = false, proxyFails = false } = {}) {
  const order = []
  const prepare = deferred(order, 'prepare')
  const proxyScope = deferred(order, 'proxy')
  containers.prepare = () => {
    order.push('prepare:start')
    return prepare.promise
  }
  m.proxies.ensure = () => {
    order.push('proxy:start')
    return proxyScope.promise
  }
  const info = { id: sessionId, workspace: ws, task, env: 'dev', repos: ['alpha'], network: { internal: false } }
  const target = { agent: {}, session: sessionId, containerId: CONTAINER, hostWorkspaceFolder: '/x', configArgs: [] }
  const p = containers.prepareAndProxy(info, CONTAINER, target)
  // Both branches have already run their synchronous prefix by now, so a call
  // that serialized them would not have reached the second stub yet.
  assert.deepEqual(order, ['prepare:start', 'proxy:start'], 'both start together, in the same tick')
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
    settlePrepare: () => (prepareFails ? prepare.fail(new Error('prepare failed')) : prepare.release())
  }
}

test('the check and the proxy scope start together', async () => {
  daemon(['bridge'])
  const { order, result, settleProxy, settlePrepare } = run('s1')
  settlePrepare()
  settleProxy()
  await result
  assert.deepEqual(order.slice(0, 2), ['prepare:start', 'proxy:start'])
})

test('the network switch needs only the proxy scope — it runs while the check is still pending', async () => {
  daemon(['bridge'])
  const { result, settleProxy, settlePrepare } = run('s2')
  settleProxy()
  // the switch is a few async docker calls; wait for it without settling the check
  for (let i = 0; i < 200 && attached().join() !== 'gurt-s-s2'; i++) await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(attached(), ['gurt-s-s2'], 'switched with the check still pending — no open-network hold-up')
  settlePrepare()
  const runtime = await result
  assert.equal(runtime.session, 's2')
})

test('a check failure fails the whole call', async () => {
  daemon(['bridge'])
  const { result, settleProxy, settlePrepare } = run('s3', { prepareFails: true })
  settleProxy()
  settlePrepare()
  await assert.rejects(() => result, /prepare failed/)
})

test('a proxy-scope failure fails the call too, and no switch happens', async () => {
  daemon(['bridge'])
  const { result, settleProxy, settlePrepare } = run('s4', { proxyFails: true })
  settlePrepare()
  settleProxy()
  await assert.rejects(() => result, /proxy failed/)
  assert.deepEqual(attached(), ['bridge'], 'no switch — there is no proxy runtime to converge onto')
})

test('when both fail, the check error is the one that surfaces', async () => {
  daemon(['bridge'])
  const { result, settleProxy, settlePrepare } = run('s5', { prepareFails: true, proxyFails: true })
  settleProxy()
  settlePrepare()
  await assert.rejects(() => result, /prepare failed/)
})
