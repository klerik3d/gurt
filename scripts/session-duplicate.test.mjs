// Duplicating a session copies its configuration into a fresh draft.
//
// What matters is the split: everything the *user* chose comes along (role,
// env, repos, agent, MCP/git/auto-allow, config picks, first prompt), and
// nothing runtime-derived does — the copy is a draft, unqueued and container-
// less, whatever state the source is in, and the two share no mutable state.
//
// No docker and no agent: every session here stays a draft or is only enqueued.
//
//   node scripts/session-duplicate.test.mjs
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// GURT_ROOT must be set before the store module loads (read at import time).
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-dup-'))
process.env.GURT_ROOT = GURT_ROOT

const outfile = path.join(os.tmpdir(), `gurt-dup-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await build({
  stdin: {
    contents: `export { createKernel } from ${S('src/main/kernel.ts')}`,
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

const { createKernel } = await import(pathToFileURL(outfile).href)

try {
  const ws = 'w'
  const task = 't'
  fs.mkdirSync(path.join(GURT_ROOT, ws, task), { recursive: true })
  fs.writeFileSync(
    path.join(GURT_ROOT, ws, 'workspace.json'),
    JSON.stringify({
      repos: [
        { name: 'alpha', url: 'https://github.com/o/alpha.git' },
        { name: 'beta', url: 'https://github.com/o/beta.git' }
      ],
      envs: [{ name: 'dev', devcontainer: '{"image":"x"}', repo: 'alpha' }]
    })
  )
  fs.writeFileSync(path.join(GURT_ROOT, ws, task, 'task.json'), JSON.stringify({}))
  fs.writeFileSync(path.join(GURT_ROOT, ws, 'agents.json'), JSON.stringify({}))

  const kernel = createKernel()
  const ref = { workspace: ws, task, env: 'dev' }

  // --- every configured field rides along ---
  const source = kernel.sessions.createSession(
    ref,
    ['alpha'],
    'a1',
    'fix the login bug',
    'draft',
    [{ id: 'github', mode: 'read-only' }],
    false,
    true,
    { model: 'opus' },
    'executor'
  )
  kernel.sessions.renameSession(source.id, 'login')

  const copy = kernel.sessions.duplicateSession(source.id)
  assert.notEqual(copy.id, source.id, 'the copy is its own session')
  assert.equal(copy.state, 'draft', 'the copy is a draft')
  assert.equal(copy.title, 'login (copy)', 'the copy is named after its source')
  assert.equal(copy.startPrompt, 'fix the login bug')
  assert.equal(copy.env, 'dev')
  assert.deepEqual(copy.repos, ['alpha'])
  assert.equal(copy.agent, 'a1')
  assert.equal(copy.role, 'executor')
  assert.equal(copy.autoAllow, false)
  assert.equal(copy.gitAccess, true)
  assert.deepEqual(copy.mcp, [{ id: 'github', mode: 'read-only' }])
  assert.deepEqual(copy.configValues, { model: 'opus' })
  assert.equal(copy.workspace, ws)
  assert.equal(copy.task, task)
  console.log('the copy carries every configured field OK')

  // --- nothing is shared: editing one must not reach the other ---
  kernel.sessions.editDraft(copy.id, { repos: ['beta'], startPrompt: 'other' })
  const after = kernel.sessions.snapshot(source.id).info
  assert.deepEqual(after.repos, ['alpha'], 'the source keeps its own repos')
  assert.equal(after.startPrompt, 'fix the login bug', 'the source keeps its own prompt')
  console.log('the two sessions share no mutable state OK')

  // --- runtime state is never copied ---
  kernel.sessions.patchContainer(source.id, {
    status: 'running',
    id: 'container-a',
    remoteWorkspaceFolder: '/app',
    repos: ['alpha']
  })
  // Enqueuing a session whose repo is free starts it right away, so this reads
  // as `starting` — the state the copy matters most in (a misconfigured session
  // is usually caught after it went up). Everything below is synchronous, so
  // the in-flight start cannot move the state under the assertions.
  kernel.sessions.enqueue(source.id)
  const liveState = kernel.sessions.snapshot(source.id).info.state
  assert.notEqual(liveState, 'draft', 'the source has left draft')

  const second = kernel.sessions.duplicateSession(source.id)
  assert.equal(second.state, 'draft', 'a live session copies into a draft')
  assert.equal(second.queuedAt, undefined, 'the copy takes no queue slot')
  assert.equal(second.container, undefined, 'the copy owns no container')
  const sourceNow = kernel.sessions.snapshot(source.id).info
  assert.equal(sourceNow.state, liveState, 'the source is left exactly as it was')
  assert.equal(sourceNow.container?.id, 'container-a', 'the source keeps its container')
  console.log('the copy takes no container and no queue slot OK')

  // --- a repo-less draft copies too (nothing to validate against) ---
  const bare = kernel.sessions.createSession(ref, [], 'a1', 'later', 'draft')
  const bareCopy = kernel.sessions.duplicateSession(bare.id)
  assert.deepEqual(bareCopy.repos, [], 'a repo-less draft stays repo-less')
  assert.equal(bareCopy.state, 'draft')

  // --- a researcher's several repos survive the role check ---
  const researcher = kernel.sessions.createSession(
    ref,
    ['alpha', 'beta'],
    'a1',
    'read both',
    'draft',
    [],
    true,
    false,
    {},
    'researcher'
  )
  const researcherCopy = kernel.sessions.duplicateSession(researcher.id)
  assert.deepEqual(researcherCopy.repos, ['alpha', 'beta'], 'multi-repo copies whole')
  assert.equal(researcherCopy.role, 'researcher')
  console.log('multi-repo and repo-less sources copy OK')

  assert.throws(
    () => kernel.sessions.duplicateSession('nope'),
    /unknown session/,
    'an unknown id is rejected, not silently ignored'
  )

  console.log('session-duplicate.test: PASS')
} catch (e) {
  console.error('session-duplicate.test: FAIL')
  console.error(e)
  process.exitCode = 1
} finally {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
}
