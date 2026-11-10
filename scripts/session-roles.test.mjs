// Session roles (docs/requirements-repo-mounts.md §4, extending
// docs/requirements-session-roles.md), without docker or an agent: what a role
// still decides (its tool set and who it may draft), what it no longer decides
// (mounts, locks, the repo count), and the on-disk migrations that turn a
// pre-roles record into an explicit role and a legacy reviewer into a
// researcher — while a review loop's reviewer (docs/requirements-review-loop.md
// §4) stays one. The mount modes themselves are repo-mounts.test.mjs's.
//
// Container state is staged through `sessions.patchContainer`, the seam the
// container manager writes through — same trick as session-repo-gate.test.mjs,
// so no daemon is needed to make a session a holder.
//
//   node scripts/session-roles.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
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

await bundle({
  stdin: {
    contents:
      `export { createKernel } from ${S('src/main/kernel.ts')}\n` +
      `export { readSessions } from ${S('src/main/store.ts')}\n` +
      `export { sessionRole, repoMode, roleHasTurnContract, roleReadsAdmin, roleWritesAdmin, roleDraftsCrossTask, spawnableRoles, missingRepoReason, SESSION_ROLES, USER_SESSION_ROLES, roleIsLoopOwned, roleNeedsRepo } from ${S('src/shared/types.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
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
    envs: [{ name: 'dev', image: 'x', repo: 'alpha' }]
  })
)
fs.writeFileSync(path.join(GURT_ROOT, ws, task, 'task.json'), JSON.stringify({}))
fs.writeFileSync(path.join(GURT_ROOT, ws, 'agents.json'), JSON.stringify({}))

const kernel = m.createKernel()
// The boot reconcile drops container records Docker does not confirm; let it
// finish before staging any (see queue-handoff.test.mjs).
await kernel.ready
const ref = { workspace: ws, task, env: 'dev' }
const mk = (repos, role, title, repoModes) => {
  const info = kernel.sessions.createSession(
    ref,
    repos,
    'a1',
    'hi',
    'none',
    [],
    true,
    {},
    role,
    undefined,
    undefined,
    repoModes
  )
  kernel.sessions.renameSession(info.id, title)
  return info
}
const W = (repos) => Object.fromEntries(repos.map((r) => [r, 'write']))
const hold = (id, repos) =>
  kernel.sessions.patchContainer(id, {
    status: 'running',
    id: `container-${id}`,
    remoteWorkspaceFolder: '/app',
    repos
  })

// --- the role predicates: the table of §4 -----------------------------------
test('role table', () => {
  const roles = ['executor', 'researcher', 'inspector', 'operator', 'proactive', 'reviewer']
  assert.deepEqual(m.SESSION_ROLES, roles, 'every role is known')
  assert.deepEqual(
    roles.map((r) => [
      m.roleHasTurnContract(r),
      m.roleReadsAdmin(r),
      m.roleWritesAdmin(r),
      m.spawnableRoles(r),
      m.roleDraftsCrossTask(r)
    ]),
    [
      [true, false, false, [], false],
      [false, false, false, ['executor', 'researcher'], true],
      [false, true, false, ['operator'], true],
      [false, true, true, [], false],
      [true, false, false, [], false],
      [true, false, false, [], false]
    ],
    'complete / admin reads / admin writes / create_session / task per role'
  )
})

// --- the role puts no rule on the repos -------------------------------------
test('any role holds any repos, in any mode', () => {
  for (const role of ['executor', 'researcher', 'inspector', 'operator']) {
    const s = mk(['alpha', 'beta'], role, `multi-${role}`, { alpha: 'write', beta: 'read' })
    assert.deepEqual(s.repos, ['alpha', 'beta'], `${role} may hold several repos`)
    assert.deepEqual(s.repoModes, { alpha: 'write', beta: 'read' }, `${role} keeps the modes it was given`)
  }
  const none = mk([], 'operator', 'op-none')
  assert.deepEqual(none.repos, [], 'and none at all')
})

// --- what a role needs to start ---------------------------------------------
test('start needs: a write repo for an executor, a repo for a researcher, nothing else', () => {
  const need = (role, repos, repoModes) => m.missingRepoReason({ role, repos, repoModes })
  assert.match(need('executor', [], {}), /no repository/)
  assert.match(need('executor', ['alpha'], { alpha: 'read-locked' }), /mounted for write/)
  assert.equal(need('executor', ['alpha', 'beta'], { alpha: 'read', beta: 'write' }), undefined)
  assert.match(need('researcher', [], {}), /no repository/)
  assert.equal(need('researcher', ['alpha'], { alpha: 'read' }), undefined)
  for (const role of ['inspector', 'operator', 'proactive']) assert.equal(need(role, [], {}), undefined, role)
  // A reviewer needs a repo to review — any mode: its mounts are `read` anyway.
  assert.match(need('reviewer', [], {}), /no repository/)
  assert.equal(need('reviewer', ['alpha'], { alpha: 'write' }), undefined)
  assert.equal(m.roleNeedsRepo('reviewer'), true)
  const e = mk(['alpha'], 'executor', 'E-ro', { alpha: 'read-locked' })
  assert.throws(() => kernel.sessions.run(e.id), /mounted for write/, 'the run gate says why')
  assert.throws(() => kernel.sessions.enqueue(e.id), /mounted for write/, 'and so does the queue')
})

// --- no session carries a native-git toggle any more (§10.2) ----------------
test('no role carries a git-access flag', () => {
  // The container broker is gone: authenticated git is the host-side github MCP
  // for every role, so there is nothing per-session left to switch on.
  for (const role of ['executor', 'researcher', 'inspector'])
    assert.equal('gitAccess' in mk(['alpha'], role, `${role}-git`), false, `${role} carries no gitAccess flag`)
})

let researcher
let executor
let inspector

// --- locking follows the modes, not the role --------------------------------
test('a read-locked researcher excludes a writer; a read researcher does not', async () => {
  researcher = mk(['alpha'], 'researcher', 'V', { alpha: 'read-locked' })
  hold(researcher.id, ['alpha'])

  executor = mk(['alpha'], 'executor', 'E', W(['alpha']))
  kernel.sessions.run(executor.id)
  const blocked = await settle(kernel, executor.id)
  assert.match(
    blocked.startError ?? '',
    /repository "alpha" is in use by session "V"/,
    'a running read-locked session excludes a writer on the same clone'
  )
  kernel.sessions.patchContainer(researcher.id, undefined)

  const reader = mk(['alpha'], 'researcher', 'R', { alpha: 'read' })
  hold(reader.id, ['alpha'])
  kernel.sessions.run(executor.id)
  const free = await settle(kernel, executor.id)
  assert.doesNotMatch(free.startError ?? '', /is in use by session/, 'a plain reader holds nothing')
  kernel.sessions.patchContainer(reader.id, undefined)
})

// --- role is editable while a draft, and touches nothing else ---------------
test('draft role edits leave repos, modes and env alone', async () => {
  const draft = mk(['alpha', 'beta'], 'researcher', 'D', { alpha: 'read', beta: 'write' })
  await kernel.editDraft(draft.id, { role: 'executor' })
  let info = kernel.sessions.snapshot(draft.id).info
  assert.equal(m.sessionRole(info), 'executor', 'a draft may change role')
  assert.deepEqual(info.repos, ['alpha', 'beta'], 'the repos stay')
  assert.deepEqual(info.repoModes, { alpha: 'read', beta: 'write' }, 'the modes stay')
  assert.equal(info.env, 'dev', 'the env stays')
  await kernel.editDraft(draft.id, { role: 'operator' })
  info = kernel.sessions.snapshot(draft.id).info
  assert.deepEqual(info.repos, ['alpha', 'beta'], 'an operator keeps them too')
  await rejects(
    () => kernel.editDraft(draft.id, { role: 'boss' }),
    /unknown session role/,
    'an unknown role is rejected at the boundary'
  )
  await rejects(
    () => kernel.editDraft(draft.id, { role: 'reviewer' }),
    /created only by the review loop/,
    'no edit makes a session a reviewer'
  )
})

// --- the review loop's reviewer: the loop's alone ---------------------------
test('a reviewer is never picked, drafted, duplicated or recreated', async () => {
  assert.ok(!m.USER_SESSION_ROLES.includes('reviewer'), 'not offered to the user')
  assert.ok(!m.USER_SESSION_ROLES.includes('proactive'), 'like the proactive role')
  assert.deepEqual(m.SESSION_ROLES.filter(m.roleIsLoopOwned), ['reviewer'])
  for (const role of m.SESSION_ROLES)
    assert.ok(!m.spawnableRoles(role).includes('reviewer'), `${role} never drafts a reviewer`)
  const asker = mk(['alpha'], 'researcher', 'S-rv', { alpha: 'read' })
  await rejects(
    () => kernel.sessions.createAgentDraft(asker.id, { role: 'reviewer', repos: ['alpha'], prompt: 'p' }),
    /may only draft: executor, researcher/,
    'not even when an agent asks past the schema'
  )

  // Only the loop creates one — straight through the session manager.
  const rv = mk(['alpha'], 'reviewer', 'review 1 — E')
  kernel.sessions['sessions'].get(rv.id).info.reviewOf = { executor: executor.id, round: 1, intent: 'i1' }
  assert.throws(() => kernel.sessions.duplicateSession(rv.id), /only the loop creates one/, 'duplicate refuses it')
  kernel.sessions['sessions'].get(rv.id).info.state = 'started'
  assert.throws(() => kernel.sessions.recreateSession(rv.id), /only the loop creates one/, 'and so does recreate')
  assert.ok(kernel.sessions.snapshot(rv.id), 'the refused recreate deleted nothing')
  kernel.sessions['sessions'].get(rv.id).info.state = 'draft'
  await rejects(
    () => kernel.editDraft(rv.id, { role: 'executor' }),
    /keeps its role/,
    'a reviewer is not turned into something else either'
  )
  kernel.sessions.deleteSession(rv.id)
})

let spawner

// --- create_session: who may draft whom (§4) --------------------------------
test('create_session gating', async () => {
  spawner = mk(['alpha'], 'researcher', 'S', { alpha: 'read' })
  const made = await kernel.sessions.createAgentDraft(spawner.id, {
    role: 'researcher',
    repos: ['alpha'],
    repoModes: { alpha: 'read-locked' },
    prompt: 'review the uncommitted changes against the requirements',
    title: 'review alpha'
  })
  const madeInfo = kernel.sessions.snapshot(made.sessionId).info
  assert.equal(madeInfo.state, 'draft', 'a spawned session is a draft — the user launches it')
  assert.equal(m.sessionRole(madeInfo), 'researcher', 'with the requested role')
  assert.deepEqual(madeInfo.repoModes, { alpha: 'read-locked' }, 'and the requested modes')
  assert.equal(madeInfo.title, 'review alpha', 'and the requested title')
  assert.equal(madeInfo.task, task, 'in the spawner’s own task')
  assert.equal(madeInfo.env, 'dev', 'inheriting the env it did not name')
  assert.equal(madeInfo.agent, 'a1', 'inheriting the agent it did not name')

  // The spawner's timeline says what it did — the draft is the user's to-do.
  const feed = kernel.sessions.snapshot(spawner.id).entries
  assert.ok(
    feed.some((e) => e.kind === 'system' && /create_session: drafted researcher/.test(e.text)),
    'the spawn is recorded in the spawning session’s timeline'
  )

  const two = await kernel.sessions.createAgentDraft(spawner.id, {
    role: 'executor',
    repos: ['alpha', 'beta'],
    repoModes: { alpha: 'write', beta: 'write' },
    prompt: 'change both'
  })
  assert.deepEqual(
    kernel.sessions.snapshot(two.sessionId).info.repos,
    ['alpha', 'beta'],
    'a draft may hold several repos'
  )

  await rejects(
    () => kernel.sessions.createAgentDraft(spawner.id, { role: 'operator', repos: [], prompt: 'p' }),
    /may only draft: executor, researcher/,
    'a researcher drafts no operator'
  )
  inspector = mk([], 'inspector', 'I')
  await rejects(
    () => kernel.sessions.createAgentDraft(inspector.id, { role: 'executor', repos: ['alpha'], prompt: 'p' }),
    /may only draft: operator/,
    'an inspector only drafts the operator'
  )
  const op = await kernel.sessions.createAgentDraft(inspector.id, {
    role: 'operator',
    repos: [],
    prompt: 'add the missing env'
  })
  const opInfo = kernel.sessions.snapshot(op.sessionId).info
  assert.equal(m.sessionRole(opInfo), 'operator', 'an inspector drafts an operator')
  assert.equal(opInfo.env, 'base', 'with no repo to follow, the workspace default env (here: the base image)')
  await rejects(
    () => kernel.sessions.createAgentDraft(executor.id, { role: 'executor', repos: ['alpha'], prompt: 'p' }),
    /may not draft sessions/,
    'an executor drafts nothing'
  )
  await rejects(
    () => kernel.sessions.createAgentDraft(op.sessionId, { role: 'operator', repos: [], prompt: 'p' }),
    /may not draft sessions/,
    'an operator drafts nothing'
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

// --- create_session across tasks, task created if missing -------------------
test('create_session across tasks', async () => {
  const spun = await kernel.sessions.createAgentDraft(spawner.id, {
    role: 'executor',
    repos: ['alpha'],
    repoModes: { alpha: 'write' },
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
  const opElsewhere = await kernel.sessions.createAgentDraft(inspector.id, {
    role: 'operator',
    repos: [],
    prompt: 'p',
    task: 'config-fix'
  })
  assert.equal(
    kernel.sessions.snapshot(opElsewhere.sessionId).info.task,
    'config-fix',
    'an inspector may draft its operator into a task of its own'
  )
  const plain = mk(['alpha'], 'executor', 'E-x', W(['alpha']))
  await rejects(
    () => kernel.sessions.createAgentDraft(plain.id, { role: 'executor', repos: ['alpha'], prompt: 'p', task: 'spinoff' }),
    /may not draft sessions/,
    'a role that drafts nothing drafts nowhere'
  )
  await rejects(
    () => kernel.sessions.createAgentDraft(spawner.id, { role: 'executor', repos: ['alpha'], prompt: 'p', task: 'a..b' }),
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
    kernel.sessions.createSession(nameRef, repos, 'a1', 'hi', 'none', [], true, {}, role)
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
  const legacy = (id, repos, role) => ({
    info: {
      id,
      env: 'dev',
      repos,
      ...(role ? { role } : {}),
      task: task2,
      workspace: ws,
      title: id,
      agent: 'a1',
      state: 'started',
      startPrompt: 'hi'
    }
  })
  fs.writeFileSync(
    sessPath,
    JSON.stringify([
      legacy('one', ['alpha']),
      legacy('two', ['alpha', 'beta']),
      legacy('three', ['alpha'], 'reviewer'),
      legacy('four', [], 'operator'),
      legacy('five', ['beta'], 'proactive'),
      // A review loop's reviewer is no legacy record: `reviewOf` says so.
      {
        info: {
          ...legacy('six', ['alpha'], 'reviewer').info,
          repoModes: { alpha: 'read' },
          reviewOf: { executor: 'one', round: 1, intent: 'i1' }
        }
      }
    ])
  )
  const [one, two, three, four, five, six] = await m.readSessions(ws, task2)
  assert.equal(one.info.role, 'executor', 'a single-repo record was a read-write worker')
  assert.deepEqual(one.info.repoModes, { alpha: 'write' }, '…and keeps writing its clone')
  assert.equal(two.info.role, 'researcher', 'a discovery session becomes a researcher')
  assert.deepEqual(two.info.repoModes, { alpha: 'read', beta: 'read' }, '…reading both, locking nothing')
  assert.equal(three.info.role, 'researcher', 'a reviewer becomes a researcher')
  assert.deepEqual(three.info.repoModes, { alpha: 'write' }, '…with the writable, locked clone it had')
  assert.deepEqual(four.info.repoModes, {}, 'an operator held nothing')
  assert.deepEqual(five.info.repoModes, { beta: 'read' }, 'a proactive run read its repos')
  assert.equal(six.info.role, 'reviewer', 'a loop reviewer stays a reviewer')
  assert.deepEqual(six.info.repoModes, { alpha: 'read' }, '…its modes untouched')
  assert.deepEqual(six.info.reviewOf, { executor: 'one', round: 1, intent: 'i1' }, '…and its loop link kept')
  const migrated = fs.readFileSync(sessPath, 'utf8')
  assert.ok(migrated.includes('"role": "researcher"'), 'the role is written back to disk')
  assert.ok(migrated.includes('"repoModes"'), 'and so are the modes')
  assert.deepEqual(
    JSON.parse(migrated).filter((r) => r.info.role === 'reviewer').map((r) => r.info.id),
    ['six'],
    'no legacy reviewer is left on disk — only the loop’s'
  )
  await m.readSessions(ws, task2)
  assert.equal(
    fs.readFileSync(sessPath, 'utf8'),
    migrated,
    'the write-back happens exactly once'
  )
})
