// Task 10: RPM wired into the app — the kernel builds it over the real ports,
// the IPC surface carries t3v2 §3.2, archiving refuses while a step runs.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { bundle } from './lib/bundle.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-rpm-wiring-'))
process.env.GURT_ROOT = path.join(root, 'gurt')
const project = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'bundle.mjs')
const source = (name) => JSON.stringify(path.join(project, name))
await bundle({ stdin: { contents: `
  export { createKernel } from ${source('src/main/kernel.ts')}
  export * as store from ${source('src/main/store.ts')}
  export { API_METHODS, METHOD_EXPOSURE } from ${source('src/shared/api.ts')}
`, resolveDir: project, loader: 'ts' }, outfile })
const { createKernel, store, API_METHODS, METHOD_EXPOSURE } = await import(pathToFileURL(outfile).href)
fs.mkdirSync(path.join(process.env.GURT_ROOT, 'work'), { recursive: true })
fs.writeFileSync(path.join(process.env.GURT_ROOT, 'work', 'workspace.json'), JSON.stringify({ repos: [], envs: [] }))
const kernel = createKernel()
await kernel.ready
kernel.containers.teardownTask = async () => {}
kernel.containers.release = async () => {}

after(async () => {
  for (const task of await store.listTasks('work')) kernel.sessions.dropTaskSessions('work', task)
  kernel.rpm.stop()
  fs.rmSync(root, { recursive: true, force: true })
})

test('IPC carries the rpm* methods of t3v2 §3.2 with their remote access', () => {
  const want = {
    rpmRuns: 'read', rpmState: 'read', rpmConfig: 'read', rpmOverview: 'none', rpmSetConfig: 'none',
    rpmVerdict: 'none', rpmSeverity: 'none', rpmNote: 'none', rpmCommand: 'none'
  }
  for (const [m, exposure] of Object.entries(want)) {
    assert.ok(API_METHODS.includes(m), m)
    assert.equal(METHOD_EXPOSURE[m], exposure, m)
  }
})

test('the kernel builds RPM: a draft executor has a config, setConfig lands in <scope>/rpm', async () => {
  await store.createTask('work', 'cfg')
  const info = kernel.sessions.createSession({ workspace: 'work', task: 'cfg' }, [], 'agent', 'Hello', 'draft', [], true, {}, 'executor')
  assert.equal(kernel.rpm.config(info.id).enabled, false)
  assert.equal(kernel.rpm.state(info.id), undefined)
  await kernel.rpm.setConfig(info.id, { enabled: true, reviewer: { agent: 'other', options: {} } })
  assert.equal(kernel.rpm.config(info.id).enabled, true)
  const file = path.join(store.taskDir('work', 'cfg'), 'rpm', info.id, 'config.json')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).enabled, true)
  assert.deepEqual(kernel.rpm.runs(info.id), [])
})

test('the overview lists every executor with its switch, other roles left out', async () => {
  await store.createTask('work', 'ov')
  const on = kernel.sessions.createSession({ workspace: 'work', task: 'ov' }, [], 'agent', 'Hello', 'draft', [], true, {}, 'executor')
  const off = kernel.sessions.createSession({ workspace: 'work', task: 'ov' }, [], 'agent', 'Hello', 'draft', [], true, {}, 'executor')
  const researcher = kernel.sessions.createSession({ workspace: 'work', task: 'ov' }, [], 'agent', 'Hello', 'draft', [], true, {}, 'researcher')
  await kernel.rpm.setConfig(on.id, { enabled: true, reviewer: { agent: 'other', options: {} } })
  const byId = new Map(kernel.rpm.overview().map((b) => [b.executor, b]))
  assert.deepEqual(byId.get(on.id), { executor: on.id, enabled: true, live: false })
  assert.deepEqual(byId.get(off.id), { executor: off.id, enabled: false, live: false })
  assert.equal(byId.has(researcher.id), false, 'only executors have RPM')
})

test('archiving refuses while a review step runs in the scope', async () => {
  await store.createTask('work', 'busy')
  const info = kernel.sessions.createSession({ workspace: 'work', task: 'busy' }, [], 'agent', 'Hello', 'draft', [], true, {}, 'executor')
  await kernel.sessions.flushTask('work', 'busy')
  const real = kernel.rpm.stepRunning
  kernel.rpm.stepRunning = (ws, task) => ws === 'work' && task === 'busy'
  try {
    await assert.rejects(kernel.archive.archive('work', 'busy'), /review step is running/)
    await assert.rejects(kernel.archive.archiveSession(info.id), /review step is running/)
  } finally {
    kernel.rpm.stepRunning = real
  }
  assert.ok(store.taskExists('work', 'busy'))
})
