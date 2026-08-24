// Session roles (docs/requirements-session-roles.md), without docker or an
// agent: what a role changes about locking, about the (role, repos) pair, about
// git access, and who may draft whom through `create_session`. Plus the on-disk
// migration that turns a pre-roles record into an explicit role.
//
// Container state is staged through `sessions.patchContainer`, the seam the
// container manager writes through — same trick as session-repo-gate.test.mjs,
// so no daemon is needed to make a session a holder.
//
//   node scripts/session-roles.test.mjs
import { test, after } from 'node:test'
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// GURT_ROOT must be set before the store module loads (read at import time).
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-roles-'))
process.env.GURT_ROOT = GURT_ROOT

const outfile = path.join(os.tmpdir(), `gurt-roles-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await build({
  stdin: {
    contents:
      `export { createKernel } from ${S('src/main/kernel.ts')}\n` +
      `export { readSessions } from ${S('src/main/store.ts')}\n` +
      `export { sessionRole, roleIsReadOnly, roleLocksClone, roleHasTurnContract, spawnableRoles } from ${S('src/shared/types.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  mainFields: ['module', 'main'],
  outfile,
  logLevel: 'silent',
  sourcemap: 'inline'
})

const m = await import(pathToFileURL(outfile).href)

/** Wait until the session leaves `starting` and report how it settled. */
async function settle(kernel, id) {
  for (let i = 0; i < 200; i++) {
    const snap = kernel.sessions.snapshot(id)
    if (snap && snap.info.state !== 'starting') return snap
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`session ${id} never left "starting"`)
}

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
    repos: [
      { name: 'alpha', url: 'https://github.com/o/alpha.git' },
      { name: 'beta', url: 'https://github.com/o/beta.git' }
    ],
    envs: [{ name: 'dev', devcontainer: '{"image":"x"}', repo: 'alpha' }]
  })
)
fs.writeFileSync(path.join(GURT_ROOT, ws, task, 'task.json'), JSON.stringify({}))
fs.writeFileSync(path.join(GURT_ROOT, ws, 'agents.json'), JSON.stringify({}))

const kernel = m.createKernel()
// The boot reconcile drops container records Docker does not confirm; let it
// finish before staging any (see queue-handoff.test.mjs).
await kernel.ready
const ref = { workspace: ws, task, env: 'dev' }
const mk = (repos, role, title) => {
  const info = kernel.sessions.createSession(
    ref,
    repos,
    'a1',
    'hi',
    'none',
    [],
    true,
    true, // gitAccess on for every session — a read-only role must drop it
    {},
    role
  )
  kernel.sessions.renameSession(info.id, title)
  return info
}
const hold = (id, repos) =>
  kernel.sessions.patchContainer(id, {
    status: 'running',
    id: `container-${id}`,
    remoteWorkspaceFolder: '/app',
    repos
  })

// --- the role predicates: the table of §2 -----------------------------------
test('role table', () => {
  assert.deepEqual(
    ['executor', 'researcher', 'reviewer'].map((r) => [
      m.roleIsReadOnly(r),
      m.roleLocksClone(r),
      m.roleHasTurnContract(r),
      m.spawnableRoles(r)
    ]),
    [
      [false, true, true, []],
      [true, false, false, ['executor', 'reviewer']],
      [true, true, false, ['executor']]
    ],
    'mounts / lock / complete / create_session per role'
  )
})

let multi

// --- (role, repos) pairs ----------------------------------------------------
test('(role, repos) rules', () => {
  assert.throws(
    () => mk(['alpha', 'beta'], 'executor', 'X'),
    /single repository/,
    'an executor may not hold two repos'
  )
  assert.throws(
    () => mk(['alpha', 'beta'], 'reviewer', 'X'),
    /single repository/,
    'a reviewer may not hold two repos'
  )
  multi = mk(['alpha', 'beta'], 'researcher', 'R-multi')
  assert.equal(m.sessionRole(multi), 'researcher', 'a researcher may hold several')
})

// --- git access is dropped for the read-only roles --------------------------
test('git access per role', () => {
  assert.equal(mk(['alpha'], 'executor', 'E-git').gitAccess, true, 'an executor keeps git access')
  assert.equal(multi.gitAccess, false, 'a researcher never gets the git broker')
  assert.equal(mk(['alpha'], 'reviewer', 'V-git').gitAccess, false, 'nor does a reviewer')
})

let reviewer
let executor

// --- locking: a reviewer holds the clone, a researcher never does -----------
test('read-only + locked (reviewer) vs. unlocked (researcher)', async () => {
  reviewer = mk(['alpha'], 'reviewer', 'V')
  hold(reviewer.id, ['alpha'])

  executor = mk(['alpha'], 'executor', 'E')
  kernel.sessions.run(executor.id)
  const blocked = await settle(kernel, executor.id)
  assert.match(
    blocked.startError ?? '',
    /repository "alpha" is in use by session "V"/,
    'a running reviewer excludes a writer on the same clone'
  )

  // The reviewer blocks writers, but not a researcher: it claims no clone at all.
  const researcher = mk(['alpha'], 'researcher', 'R')
  kernel.sessions.run(researcher.id)
  const notBlocked = await settle(kernel, researcher.id)
  assert.doesNotMatch(
    notBlocked.startError ?? '',
    /is in use by session/,
    'a researcher is never gated by a holder'
  )

  // …and a researcher holding a live container blocks nobody either.
  kernel.sessions.patchContainer(reviewer.id, undefined)
  hold(researcher.id, ['alpha'])
  kernel.sessions.run(executor.id)
  const afterResearcher = await settle(kernel, executor.id)
  assert.doesNotMatch(
    afterResearcher.startError ?? '',
    /is in use by session/,
    'a researcher holds nothing, so it blocks nothing'
  )
  kernel.sessions.patchContainer(researcher.id, undefined)

  // A queued writer waits for a reviewer exactly as it waits for another writer.
  hold(reviewer.id, ['alpha'])
  const queued = mk(['alpha'], 'executor', 'Q')
  kernel.sessions.enqueue(queued.id)
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(
    kernel.sessions.snapshot(queued.id).info.state,
    'queued',
    'the queue waits for the reviewer to release the clone'
  )
  // A queued researcher, by contrast, is started by the same pass.
  const queuedResearcher = mk(['alpha'], 'researcher', 'QR')
  kernel.sessions.enqueue(queuedResearcher.id)
  const started = await settle(kernel, queuedResearcher.id)
  assert.doesNotMatch(
    started.startError ?? '',
    /is in use by session/,
    'a queued researcher is not held back by the lock'
  )
  kernel.sessions.patchContainer(reviewer.id, undefined)
})

// --- role is editable while a draft, ignored afterwards ---------------------
test('draft role edits', async () => {
  const draft = mk(['alpha', 'beta'], 'researcher', 'D')
  await kernel.editDraft(draft.id, { role: 'executor', repos: ['alpha'] })
  assert.equal(
    m.sessionRole(kernel.sessions.snapshot(draft.id).info),
    'executor',
    'a draft may change role'
  )
  await rejects(
    () => kernel.editDraft(draft.id, { role: 'executor', repos: ['alpha', 'beta'] }),
    /single repository/,
    '…but not into an invalid (role, repos) pair'
  )
  assert.deepEqual(
    kernel.sessions.snapshot(draft.id).info.repos,
    ['alpha'],
    'a rejected edit leaves the draft untouched'
  )
  await rejects(
    () => kernel.editDraft(draft.id, { role: 'boss' }),
    /unknown session role/,
    'an unknown role is rejected at the boundary'
  )
})

let spawner

// --- create_session: who may draft whom (§3) --------------------------------
test('create_session gating', async () => {
  spawner = mk(['alpha'], 'researcher', 'S')
  const made = await kernel.sessions.createAgentDraft(spawner.id, {
    role: 'reviewer',
    repos: ['alpha'],
    prompt: 'review the uncommitted changes against the requirements',
    title: 'review alpha'
  })
  const madeInfo = kernel.sessions.snapshot(made.sessionId).info
  assert.equal(madeInfo.state, 'draft', 'a spawned session is a draft — the user launches it')
  assert.equal(m.sessionRole(madeInfo), 'reviewer', 'with the requested role')
  assert.equal(madeInfo.title, 'review alpha', 'and the requested title')
  assert.equal(madeInfo.task, task, 'in the spawner’s own task')
  assert.equal(madeInfo.env, 'dev', 'inheriting the env it did not name')
  assert.equal(madeInfo.agent, 'a1', 'inheriting the agent it did not name')
  assert.equal(madeInfo.startPrompt, 'review the uncommitted changes against the requirements')

  // The spawner's timeline says what it did — the draft is the user's to-do.
  const feed = kernel.sessions.snapshot(spawner.id).entries
  assert.ok(
    feed.some((e) => e.kind === 'system' && /create_session: drafted reviewer/.test(e.text)),
    'the spawn is recorded in the spawning session’s timeline'
  )

  await rejects(
    () => kernel.sessions.createAgentDraft(spawner.id, { role: 'researcher', repos: ['alpha'], prompt: 'p' }),
    /may only draft: executor, reviewer/,
    'nobody drafts a researcher'
  )
  await rejects(
    () => kernel.sessions.createAgentDraft(reviewer.id, { role: 'reviewer', repos: ['alpha'], prompt: 'p' }),
    /may only draft: executor/,
    'a reviewer only drafts the fixer'
  )
  assert.ok(
    (await kernel.sessions.createAgentDraft(reviewer.id, {
      role: 'executor',
      repos: ['alpha'],
      prompt: 'fix the findings'
    })).sessionId,
    'a reviewer drafts a fixer executor'
  )
  await rejects(
    () => kernel.sessions.createAgentDraft(executor.id, { role: 'executor', repos: ['alpha'], prompt: 'p' }),
    /may not draft sessions/,
    'an executor drafts nothing'
  )
  await rejects(
    () => kernel.sessions.createAgentDraft(spawner.id, { role: 'executor', repos: ['nope'], prompt: 'p' }),
    /not registered/,
    'a repo the agent invented is rejected, not deferred to the user'
  )
  await rejects(
    () => kernel.sessions.createAgentDraft(spawner.id, { role: 'executor', repos: ['alpha'], prompt: 'p', env: 'nope' }),
    /not registered/,
    'and so is an env it invented'
  )
  await rejects(
    () => kernel.sessions.createAgentDraft('no-such-session', { role: 'executor', repos: ['alpha'], prompt: 'p' }),
    /unknown session/,
    'an unknown spawner is rejected'
  )
})

// --- create_session across tasks: researcher-only, task created if missing --
test('create_session across tasks', async () => {
  const spun = await kernel.sessions.createAgentDraft(spawner.id, {
    role: 'executor',
    repos: ['alpha'],
    prompt: 'the out-of-scope work, spelled out',
    task: 'spinoff'
  })
  const spunInfo = kernel.sessions.snapshot(spun.sessionId).info
  assert.equal(spunInfo.task, 'spinoff', 'the draft lands in the named task')
  assert.equal(spunInfo.state, 'draft', 'and is still a draft')
  assert.ok(
    fs.existsSync(path.join(GURT_ROOT, ws, 'spinoff', 'task.json')),
    'the missing task was created on disk, marker and all'
  )
  assert.ok(
    kernel.sessions
      .snapshot(spawner.id)
      .entries.some((e) => e.kind === 'system' && /drafted executor .* in task "spinoff"/.test(e.text)),
    'the spawner’s timeline names the destination task'
  )
  // Drafting into a task that already exists just lands there — no "exists" error.
  assert.equal(
    kernel.sessions.snapshot(
      (
        await kernel.sessions.createAgentDraft(spawner.id, {
          role: 'executor',
          repos: ['alpha'],
          prompt: 'p',
          task: 'spinoff'
        })
      ).sessionId
    ).info.task,
    'spinoff',
    'an existing task is drafted into as-is'
  )
  await rejects(
    () => kernel.sessions.createAgentDraft(reviewer.id, { role: 'executor', repos: ['alpha'], prompt: 'p', task: 'spinoff' }),
    /may only draft into its own task/,
    'a reviewer never drafts across tasks — its fixer must hold this task’s clone'
  )
  await rejects(
    () => kernel.sessions.createAgentDraft(spawner.id, { role: 'executor', repos: ['alpha'], prompt: 'p', task: 'a/b' }),
    /must not contain/,
    'an invalid task name is rejected, not written to disk'
  )
})

// --- default title: named after the role, index only from the second on ----
test('default title follows role', () => {
  const task3 = 'naming'
  fs.mkdirSync(path.join(GURT_ROOT, ws, task3), { recursive: true })
  fs.writeFileSync(path.join(GURT_ROOT, ws, task3, 'task.json'), JSON.stringify({}))
  const nameRef = { workspace: ws, task: task3, env: 'dev' }
  const named = (repos, role) =>
    kernel.sessions.createSession(nameRef, repos, 'a1', 'hi', 'none', [], true, false, {}, role)
  assert.equal(named(['alpha'], 'executor').title, 'executor', 'first of a role carries no index')
  assert.equal(named(['alpha'], 'executor').title, 'executor 2', 'the second is numbered')
  assert.equal(named([], 'researcher').title, 'researcher', 'a different role starts its own count')
  assert.equal(
    named([], 'researcher').title,
    'researcher 2',
    'and counts independently of other roles'
  )
})

// --- migration: a pre-roles record gets an explicit role, written back once --
test('pre-roles migration', async () => {
  const task2 = 'legacy'
  fs.mkdirSync(path.join(GURT_ROOT, ws, task2), { recursive: true })
  const sessPath = path.join(GURT_ROOT, ws, task2, 'sessions.json')
  const legacy = (id, repos) => ({
    info: {
      id,
      env: 'dev',
      repos,
      task: task2,
      workspace: ws,
      title: id,
      agent: 'a1',
      state: 'started',
      startPrompt: 'hi'
    }
  })
  fs.writeFileSync(sessPath, JSON.stringify([legacy('one', ['alpha']), legacy('two', ['alpha', 'beta'])]))
  const [one, two] = await m.readSessions(ws, task2)
  assert.equal(one.info.role, 'executor', 'a single-repo record was a read-write worker')
  assert.equal(two.info.role, 'researcher', 'a discovery session becomes a researcher')
  const migrated = fs.readFileSync(sessPath, 'utf8')
  assert.ok(migrated.includes('"role": "researcher"'), 'the role is written back to disk')
  await m.readSessions(ws, task2)
  assert.equal(
    fs.readFileSync(sessPath, 'utf8'),
    migrated,
    'the write-back happens exactly once'
  )
})
