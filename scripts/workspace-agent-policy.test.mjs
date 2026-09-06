// Per-workspace agent-client permissions: `WorkspaceFile.defaultAgent` and
// `.deniedAgents` (docs — none yet, see the PR that added this file). Two
// rules under test:
//   - a workspace's default agent resolves a session created without an
//     explicit one (draft creation, `create_session`);
//   - an explicitly requested denied agent is rejected, never silently
//     overridden or swapped for the default.
//
// No docker and no agent: everything here is bookkeeping over the workspace
// registry, the same seam session-roles.test.mjs and draft-env-default.test.mjs
// drive.
//
//   node scripts/workspace-agent-policy.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// GURT_ROOT must be set before the store module loads (read at import time).
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-agent-policy-'))
process.env.GURT_ROOT = GURT_ROOT

const outfile = path.join(os.tmpdir(), `gurt-agent-policy-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await bundle({
  stdin: {
    contents:
      `export { createKernel } from ${S('src/main/kernel.ts')}\n` +
      `export { getWorkspace, setDefaultAgent, setDeniedAgents } from ${S('src/main/store.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})

const m = await import(pathToFileURL(outfile).href)

const rejects = async (fn, re, label) => {
  await assert.rejects(async () => fn(), re, label)
}

after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

const ws = 'w'
const task = 't'
fs.mkdirSync(path.join(GURT_ROOT, ws, task), { recursive: true })
fs.writeFileSync(
  path.join(GURT_ROOT, ws, 'workspace.json'),
  JSON.stringify({
    repos: [{ name: 'alpha', url: 'https://github.com/o/alpha.git' }],
    envs: [{ name: 'dev', devcontainer: '{"image":"x"}', repo: 'alpha' }]
  })
)
fs.writeFileSync(path.join(GURT_ROOT, ws, task, 'task.json'), JSON.stringify({}))
fs.writeFileSync(path.join(GURT_ROOT, ws, 'agents.json'), JSON.stringify({}))

// --- store: default agent + deny-list round trip, each guarding the other ---
test('store: a fresh workspace defaults to nothing set, nothing denied', async () => {
  const data = await m.getWorkspace(ws)
  assert.equal(data.defaultAgent, undefined)
  assert.equal(data.deniedAgents, undefined)
})

test('store: setDefaultAgent / setDeniedAgents round trip', async () => {
  await m.setDefaultAgent(ws, 'a1')
  assert.equal((await m.getWorkspace(ws)).defaultAgent, 'a1')

  await m.setDeniedAgents(ws, ['a2', 'a3'])
  assert.deepEqual((await m.getWorkspace(ws)).deniedAgents, ['a2', 'a3'])

  await m.setDefaultAgent(ws, undefined)
  assert.equal((await m.getWorkspace(ws)).defaultAgent, undefined)

  await m.setDeniedAgents(ws, [])
  assert.equal((await m.getWorkspace(ws)).deniedAgents, undefined)
})

test('store: cannot deny the current default, cannot default to a denied agent', async () => {
  await m.setDefaultAgent(ws, 'a1')
  await rejects(
    () => m.setDeniedAgents(ws, ['a1']),
    /default agent/,
    'denying the default is rejected, not applied half-way'
  )
  assert.equal((await m.getWorkspace(ws)).deniedAgents, undefined, 'the rejected write left nothing behind')

  await m.setDeniedAgents(ws, ['a2'])
  await rejects(
    () => m.setDefaultAgent(ws, 'a2'),
    /denied/,
    'defaulting to a denied agent is rejected'
  )
  assert.equal((await m.getWorkspace(ws)).defaultAgent, 'a1', 'the prior default stands')

  // clean up for the tests below
  await m.setDefaultAgent(ws, undefined)
  await m.setDeniedAgents(ws, [])
})

// --- kernel.editDraft: the IPC edit boundary rejects a denied agent pick ----
test('kernel.editDraft rejects a denied agent, accepts an allowed one', async () => {
  const kernel = m.createKernel()
  await kernel.ready
  const draft = kernel.sessions.createSession(
    { workspace: ws, task, env: 'dev' },
    ['alpha'],
    '',
    '',
    'draft'
  )

  await m.setDeniedAgents(ws, ['a2'])
  await rejects(
    () => kernel.editDraft(draft.id, { agent: 'a2' }),
    /not allowed in workspace/,
    'an explicit pick of a denied agent is rejected, not silently dropped'
  )
  assert.equal(
    kernel.sessions.snapshot(draft.id).info.agent,
    '',
    'the rejected edit left the draft untouched'
  )

  await kernel.editDraft(draft.id, { agent: 'a1' })
  assert.equal(
    kernel.sessions.snapshot(draft.id).info.agent,
    'a1',
    'an agent the workspace does not deny is accepted'
  )

  await m.setDeniedAgents(ws, [])
})

// --- create_session: default fills an unnamed agent, deny rejects a named one
test('createAgentDraft: workspace default fills an unnamed agent', async () => {
  const kernel = m.createKernel()
  await kernel.ready
  const spawner = kernel.sessions.createSession(
    { workspace: ws, task, env: 'dev' },
    ['alpha'],
    'spawner-agent',
    'hi',
    'none',
    [],
    true,
    {},
    'researcher'
  )

  // No default set yet: an unnamed request inherits the spawner's agent, as
  // before this feature existed.
  const noDefault = await kernel.sessions.createAgentDraft(spawner.id, {
    role: 'executor',
    repos: ['alpha'],
    prompt: 'p'
  })
  assert.equal(
    kernel.sessions.snapshot(noDefault.sessionId).info.agent,
    'spawner-agent',
    'with no workspace default, the spawner’s own agent still stands'
  )

  // A workspace default beats the spawner's agent for a request that names none.
  await m.setDefaultAgent(ws, 'ws-default')
  const withDefault = await kernel.sessions.createAgentDraft(spawner.id, {
    role: 'executor',
    repos: ['alpha'],
    prompt: 'p'
  })
  assert.equal(
    kernel.sessions.snapshot(withDefault.sessionId).info.agent,
    'ws-default',
    'an unnamed request resolves to the workspace default over the spawner’s agent'
  )

  // An explicit request always wins over the default.
  const explicit = await kernel.sessions.createAgentDraft(spawner.id, {
    role: 'executor',
    repos: ['alpha'],
    prompt: 'p',
    agent: 'explicit-agent'
  })
  assert.equal(
    kernel.sessions.snapshot(explicit.sessionId).info.agent,
    'explicit-agent',
    'an explicit request is never overridden by the default'
  )

  await m.setDefaultAgent(ws, undefined)
})

test('createAgentDraft: an explicitly denied agent is rejected, not swapped for the default', async () => {
  const kernel = m.createKernel()
  await kernel.ready
  const spawner = kernel.sessions.createSession(
    { workspace: ws, task, env: 'dev' },
    ['alpha'],
    'spawner-agent',
    'hi',
    'none',
    [],
    true,
    {},
    'researcher'
  )

  await m.setDeniedAgents(ws, ['blocked-agent'])
  await rejects(
    () =>
      kernel.sessions.createAgentDraft(spawner.id, {
        role: 'executor',
        repos: ['alpha'],
        prompt: 'p',
        agent: 'blocked-agent'
      }),
    /not allowed in workspace/,
    'a caller explicitly asking for a denied agent is rejected with a clear error'
  )

  await m.setDeniedAgents(ws, [])
})
