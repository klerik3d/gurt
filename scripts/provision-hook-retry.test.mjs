// The `setup` script (docs/requirements-env-docker.md §3.4) runs when a
// container is *created*. One that fails — a flaky `npm install` is the common
// one — leaves a container behind; reusing it would skip the script as already
// run and start the session against a workspace whose install never finished
// ("it works on the second try" — it does not work, it stops trying). So a
// failed setup removes its container, retries once in a fresh one, and
// otherwise fails with the output tail; and no container the session's record
// cannot name is ever adopted. Driven by the fake docker (scripts/lib).
//
//   node scripts/provision-hook-retry.test.mjs
import { test, after, beforeEach } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { installFakeDocker } from './lib/fake-docker.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-hook-retry-'))
process.env.GURT_ROOT = path.join(tmp, 'gurt') // store.ts reads this at import time
const writeOpEnv = (cfg) => {
  fs.mkdirSync(path.join(process.env.GURT_ROOT, 'ws'), { recursive: true })
  fs.writeFileSync(
    path.join(process.env.GURT_ROOT, 'ws', 'workspace.json'),
    JSON.stringify({ repos: [], envs: [cfg] })
  )
}
const fake = installFakeDocker(tmp)

const S = (rel) => JSON.stringify(path.join(ROOT, rel))
const outfile = path.join(tmp, 'entry.mjs')
await bundle({
  stdin: {
    contents: `
      export { createContainer, hookOutputTail } from ${S('src/main/provision.ts')}
      export { ContainerManager } from ${S('src/main/containers.ts')}
    `,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  external: ['electron'],
  outfile
})
const m = await import(pathToFileURL(outfile).href)

after(() => fs.rmSync(tmp, { recursive: true, force: true }))
beforeEach(() => fake.reset({ volumeExists: true, volumeReady: true }))

const SETUP = 'npm install'
const spec = (over = {}) => ({
  session: 's1',
  image: 'img:1',
  env: { name: 'e', image: 'img:1', setup: SETUP },
  workdir: '/workspaces/repo',
  mounts: [],
  skipSetup: false,
  ...over
})
const failing = (codes) => ({
  exec: [
    {
      match: SETUP,
      codes,
      stdout: 'npm error code ECONNRESET\nnpm error network request to https://registry.npmjs.org/react failed\n'
    }
  ]
})
const removed = () => fake.of('rm').map((c) => c.args.at(-1))
const noop = () => {}

test('a setup that fails once removes its container and succeeds in a fresh one', async () => {
  fake.ctl(failing([1, 0]))
  const logs = []
  const done = []
  const r = await m.createContainer(spec(), (l) => logs.push(l), { onSetupDone: (id) => done.push(id) })
  assert.equal(fake.of('create').length, 2, 'a second container was created')
  assert.deepEqual(removed(), ['cid-1'], 'the half-provisioned one was removed, not adopted')
  assert.equal(r.containerId, 'cid-2')
  assert.deepEqual(done, ['cid-2'], 'only the container whose setup succeeded is announced')
  assert.ok(logs.some((l) => /retrying once/.test(l)))
  // setup ran in each container, once
  const runs = fake.execs().filter((e) => e.cmd.includes(SETUP))
  assert.deepEqual(runs.map((e) => e.id), ['cid-1', 'cid-2'])
})

test('a setup that keeps failing fails the start, quoting its output, after exactly one retry', async () => {
  fake.ctl(failing([1]))
  const done = []
  await assert.rejects(
    m.createContainer(spec(), noop, { onSetupDone: (id) => done.push(id) }),
    (/** @type {Error} */ e) => {
      assert.match(e.message, /setup script failed \(exit 1\) — retried 2× in a fresh container/)
      assert.match(e.message, /npm error network request to https:\/\/registry\.npmjs\.org\/react failed/)
      return true
    }
  )
  assert.equal(fake.of('create').length, 2, 'one retry, no more')
  assert.deepEqual(removed(), ['cid-1', 'cid-2'], 'neither container is left behind')
  assert.deepEqual(done, [], 'no container id was ever announced')
})

test('read-only roles skip setup: nothing to fail, nothing retried', async () => {
  fake.ctl(failing([1]))
  const r = await m.createContainer(spec({ skipSetup: true }), noop)
  assert.equal(r.containerId, 'cid-1')
  assert.equal(fake.of('create').length, 1)
  assert.equal(removed().length, 0)
})

test('other failures are untouched: a failing create is one attempt with the daemon’s own message', async () => {
  fake.ctl({ createFails: [{ stderr: 'pull access denied for img' }] })
  await assert.rejects(m.createContainer(spec(), noop), /pull access denied/)
  assert.equal(fake.of('create').length, 1)
  assert.equal(removed().length, 0, 'nothing was created, so nothing is removed')
})

test('hookOutputTail keeps the last lines of the script’s output and drops stack frames', () => {
  const lines = ['a', '', '    at Q (/stub/x.js:1:1)', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  assert.deepEqual(m.hookOutputTail(lines), ['c', 'd', 'e', 'f', 'g', 'h'])
  assert.deepEqual(m.hookOutputTail(lines, 2), ['g', 'h'])
  assert.deepEqual(m.hookOutputTail(['only']), ['only'])
})

test('a container the record cannot name is removed before create — a crash mid-setup is never adopted', async () => {
  writeOpEnv({ name: 'op', image: 'op:1', setup: SETUP })
  fake.ctl({ psSession: 'leftover-1\nleftover-2\n' })
  const sess = { id: 's1', workspace: 'ws', task: 't', env: 'op', repos: [], role: 'operator' }
  const manager = new m.ContainerManager({
    bus: { emit: noop },
    session: () => sess,
    sessions: () => [sess],
    patchContainer: (id, c) => {
      sess.container = c
    },
    isSessionIdle: () => true,
    detach: noop
  })
  await manager.ensure('s1')
  const calls = fake.calls().map((c) => c.args)
  const create = calls.findIndex((a) => a[0] === 'create')
  const rm = calls.flatMap((a, i) => (a[0] === 'rm' ? [[a.at(-1), i]] : []))
  assert.deepEqual(rm.map(([id]) => id), ['leftover-1', 'leftover-2'])
  assert.ok(rm.every(([, i]) => i < create), 'removed before the create')
  assert.equal(sess.container.id, 'cid-1')
})
