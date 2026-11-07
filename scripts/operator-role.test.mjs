// The operator role's table row (docs/requirements-session-operator.md §2,
// acceptance §12 item 2, as amended by docs/requirements-repo-mounts.md §4),
// without docker or an agent: repos allowed but never needed, the repo-less
// start path through all four gates, no clone lock taken and none waited for
// when it holds none, no `complete` and no nudge, no `create_session`, the
// image-only refusal, and the default env resolution.
//
// Container state is staged through `sessions.patchContainer` where a holder
// is needed — same trick as session-roles.test.mjs, so no daemon is involved.
//
//   node scripts/operator-role.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// GURT_ROOT must be set before the store module loads (read at import time).
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-operator-'))
process.env.GURT_ROOT = GURT_ROOT

// Docker must not be reachable from these tests: they assert host-side gates
// and refusals, and on a machine WITH a daemon (CI's ubuntu runner) a start
// that gets past them would run a real `docker pull` — slow, networked,
// and failing on the fake image only after a registry round trip, well past
// `settle`'s patience. A stub that refuses instantly makes the path identical
// everywhere; every child inherits PATH through `run`.
//
// `docker info` is the one subcommand it answers, because the start preflight
// asks it before anything else (`assertDockerDaemon`,
// docs/requirements-first-run.md §4.2) and a refusal there would stop these
// tests short of the config rules they exist to check — which is the correct
// behaviour for a machine whose daemon is down, and the wrong fixture for
// "the daemon is up and the env is misconfigured".
const stubBin = path.join(GURT_ROOT, 'stub-bin')
fs.mkdirSync(stubBin, { recursive: true })
fs.writeFileSync(
  path.join(stubBin, 'docker'),
  '#!/bin/sh\nif [ "$1" = "info" ]; then echo 27.3.1; exit 0; fi\n' +
    'echo "docker stub: no daemon here" >&2\nexit 1\n'
)
fs.chmodSync(path.join(stubBin, 'docker'), 0o755)
process.env.PATH = `${stubBin}${path.delimiter}${process.env.PATH}`
// The base image setting the base env resolves to.
fs.writeFileSync(path.join(GURT_ROOT, 'images.json'), JSON.stringify({ baseImage: 'node:22-test' }))

const outfile = path.join(os.tmpdir(), `gurt-operator-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await bundle({
  stdin: {
    contents:
      `export { createKernel } from ${S('src/main/kernel.ts')}\n` +
      `export { postTurnDecision } from ${S('src/main/sessions.ts')}\n` +
      `export { addEnv, getWorkspace, setDefaultEnv } from ${S('src/main/store.ts')}\n` +
      `export { bundledEnv } from ${S('src/main/baseEnv.ts')}\n` +
      `export { containerLayout } from ${S('src/main/containers.ts')}\n` +
      `export { BASE_ENV_NAME, defaultEnvName, missingRepoReason, roleHasTurnContract, roleNeedsRepo, roleReadsAdmin, roleWritesAdmin, spawnableRoles } from ${S('src/shared/types.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  external: ['electron'],
  outfile
})

const m = await import(pathToFileURL(outfile).href)

/** Wait until the session leaves `starting`/`queued` and report how it settled. */
async function settle(kernel, id) {
  for (let i = 0; i < 400; i++) {
    const snap = kernel.sessions.snapshot(id)
    if (snap && snap.info.state === 'draft' && snap.startError) return snap
    if (snap && snap.info.state === 'started') return snap
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`session ${id} never settled`)
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
    envs: [
      { name: 'dev', image: 'x', repo: 'alpha' },
      { name: 'buildenv', dockerfile: 'FROM scratch\n', repo: 'alpha' }
    ]
  })
)
fs.writeFileSync(path.join(GURT_ROOT, ws, task, 'task.json'), JSON.stringify({}))
// Empty on purpose: `resolveLaunch` resolves the agent *before* provisioning,
// so a start that dies with `unknown agent` has passed every repo gate and
// never talks to docker — which this environment does not have.
fs.writeFileSync(path.join(GURT_ROOT, 'agents.json'), JSON.stringify({}))

const kernel = m.createKernel()
await kernel.ready
const ref = { workspace: ws, task, env: m.BASE_ENV_NAME }

// --- the table row (§2.1) ---------------------------------------------------

test('operator row of the role table', () => {
  assert.deepEqual(
    [
      m.roleHasTurnContract('operator'),
      m.spawnableRoles('operator'),
      m.roleNeedsRepo('operator'),
      m.roleReadsAdmin('operator'),
      m.roleWritesAdmin('operator')
    ],
    [false, [], false, true, true],
    'complete / create_session / needs-repo / admin reads / admin writes'
  )
  // Its read half, the inspector: the same surface minus the writes, and the
  // operator is the one thing it drafts.
  assert.deepEqual(
    [m.roleNeedsRepo('inspector'), m.roleReadsAdmin('inspector'), m.roleWritesAdmin('inspector')],
    [false, true, false]
  )
  assert.deepEqual(m.spawnableRoles('inspector'), ['operator'])
  for (const role of ['executor', 'researcher']) {
    assert.equal(m.roleNeedsRepo(role), true, `${role} needs a repo`)
    assert.ok(!m.spawnableRoles(role).includes('operator'), `${role} cannot draft an operator`)
  }
})

// --- repos are allowed, never required (repo-mounts §4) ---------------------

test('an operator may hold repos, in any mode', async () => {
  const op = kernel.sessions.createSession(
    ref, ['alpha'], 'a1', 'hi', 'draft', [], true, {}, 'operator', undefined, undefined, { alpha: 'write' }
  )
  assert.deepEqual(op.repos, ['alpha'], 'create accepts a repo-carrying operator')
  assert.deepEqual(op.repoModes, { alpha: 'write' })
  assert.equal(m.missingRepoReason(op), undefined, 'and it may start')
  // Re-pointing an executor to operator keeps its repo: the role touches no repo.
  const draft = kernel.sessions.createSession(ref, ['alpha'], 'a1', 'hi', 'draft', [], true, {}, 'executor')
  await kernel.editDraft(draft.id, { role: 'operator' })
  const info = kernel.sessions.snapshot(draft.id).info
  assert.equal(info.role, 'operator')
  assert.deepEqual(info.repos, ['alpha'], 'the repo stays')
  kernel.sessions.deleteSession(draft.id)
  kernel.sessions.deleteSession(op.id)
})

// --- the repo-less start path through all four gates (§2.1) -----------------

test('a repo-less operator passes all four repo gates; other roles still refuse', async () => {
  // Gates 1-4 all say the same sentence; the operator must never hear it. With
  // an empty agent registry the start dies at agent resolution — which sits
  // AFTER every gate and BEFORE any docker call.
  const op = kernel.sessions.createSession(ref, [], 'a1', 'hi', 'run', [], true, {}, 'operator')
  const snap = await settle(kernel, op.id)
  assert.ok(snap.startError, 'start failed (no agent registered — deliberate)')
  assert.ok(!/no repository/.test(snap.startError), `gates passed: ${snap.startError}`)
  assert.match(snap.startError, /unknown agent/, 'died at agent resolution, past the gates')

  // The queue path too: enqueue → the scheduler starts a repo-less operator
  // instead of stalling it on `no-repo`.
  const q = kernel.sessions.createSession(ref, [], 'a1', 'hi', 'queue', [], true, {}, 'operator')
  const qs = await settle(kernel, q.id)
  assert.ok(!/no repository/.test(qs.startError ?? ''), 'queued operator started (and failed later)')

  // Every other role still refuses a repo-less run/queue with the gate's own
  // sentence.
  // The inspector passes them the same way.
  const insp = kernel.sessions.createSession(ref, [], 'a1', 'hi', 'run', [], true, {}, 'inspector')
  const is = await settle(kernel, insp.id)
  assert.ok(!/no repository/.test(is.startError ?? ''), 'a repo-less inspector passes the gates too')
  kernel.sessions.deleteSession(insp.id)
  for (const role of ['executor', 'researcher']) {
    assert.throws(
      () => kernel.sessions.createSession(ref, [], 'a1', 'hi', 'run', [], true, {}, role),
      /session has no repository/,
      `${role} still refuses a repo-less run`
    )
    const d = kernel.sessions.createSession(ref, [], 'a1', 'hi', 'draft', [], true, {}, role)
    assert.throws(() => kernel.sessions.run(d.id), /session has no repository/)
    assert.throws(() => kernel.sessions.enqueue(d.id), /session has no repository/)
    kernel.sessions.deleteSession(d.id)
  }
  kernel.sessions.deleteSession(op.id)
  kernel.sessions.deleteSession(q.id)
})

test('the empty wrapper workspace-folder and the skills staging are repo-independent', async () => {
  // Skills selected on an operator are staged exactly as for any other session
  // (materializeSkills runs before the launch resolves — §2.1 "skills still
  // work"). The skill itself:
  fs.mkdirSync(path.join(GURT_ROOT, ws, 'skills', 'greet'), { recursive: true })
  fs.writeFileSync(
    path.join(GURT_ROOT, ws, 'skills', 'greet', 'SKILL.md'),
    '---\nname: greet\ndescription: says hi\n---\nhi\n'
  )
  const op = kernel.sessions.createSession(
    ref, [], 'a1', 'hi', 'run', [], true, {}, 'operator', [{ name: 'greet' }]
  )
  await settle(kernel, op.id)
  const staged = path.join(GURT_ROOT, ws, task, '.multirepo', op.id, 'skills', 'greet', 'SKILL.md')
  assert.ok(fs.existsSync(staged), 'selected skill staged for the repo-less session')
  kernel.sessions.deleteSession(op.id)
})

// --- no clone lock taken and none waited for (§2.1) -------------------------

test('an operator neither waits for a holder nor is one', async () => {
  // An executor sits on alpha with a running container…
  const holder = kernel.sessions.createSession(
    ref2('dev'), ['alpha'], 'a1', 'hi', 'draft', [], true, {}, 'executor', undefined, undefined, { alpha: 'write' }
  )
  kernel.sessions.patchContainer(holder.id, {
    status: 'running',
    id: 'c-holder',
    remoteWorkspaceFolder: '/app',
    repos: ['alpha']
  })
  assert.ok(kernel.sessions.repoHolderFor(ws, task, 'alpha'), 'executor holds the clone')
  // …and the operator starts anyway (dies at agent resolution, not at a lock).
  const op = kernel.sessions.createSession(ref, [], 'a1', 'hi', 'run', [], true, {}, 'operator')
  const snap = await settle(kernel, op.id)
  assert.ok(!/in use by session/.test(snap.startError ?? ''), 'no lock waited for')
  // An operator with a (staged) running container is never a holder of anything.
  kernel.sessions.patchContainer(op.id, {
    status: 'running',
    id: 'c-op',
    remoteWorkspaceFolder: '/app',
    repos: []
  })
  assert.equal(
    kernel.sessions.repoHolderFor(ws, task, 'alpha')?.id,
    holder.id,
    'the holder registry still names only the executor'
  )
  kernel.sessions.deleteSession(op.id)
  kernel.sessions.deleteSession(holder.id)
})

// --- no complete, no nudge (§2.1) -------------------------------------------

test('no turn contract: a turn without complete simply ends', () => {
  assert.equal(m.roleHasTurnContract('operator'), false)
  assert.equal(
    m.postTurnDecision({
      stopReason: 'end_turn',
      turnComplete: false,
      threw: false,
      isNudge: false,
      hasContract: false
    }),
    'none',
    'never a nudge, never an incomplete mark'
  )
})

// --- image-only enforcement (§2.1) ------------------------------------------

test('an env with a build section is refused with its own sentence', async () => {
  // A real agent this time, so the start gets past agent resolution and into
  // provisioning, where the image-only rule speaks.
  fs.writeFileSync(
    path.join(GURT_ROOT, 'agents.json'),
    JSON.stringify({ a1: { kind: 'claude-code', label: 'claude' } })
  )
  const op = kernel.sessions.createSession(ref2('buildenv'), [], 'a1', 'hi', 'run', [], true, {}, 'operator')
  const snap = await settle(kernel, op.id)
  assert.match(
    snap.startError ?? '',
    /image-only/,
    'refused with the image-only sentence, not the anchor guard'
  )
  assert.ok(!/no repository/.test(snap.startError ?? ''), 'never the anchor guard sentence')
  kernel.sessions.deleteSession(op.id)
  fs.writeFileSync(path.join(GURT_ROOT, 'agents.json'), JSON.stringify({}))
})

// --- default env resolution ------------------------------------------

test('defaultEnv: absent → base, set → that env', async () => {
  assert.equal(m.defaultEnvName({}), m.BASE_ENV_NAME, 'absent resolves to the bundled default')
  assert.equal(m.defaultEnvName({ defaultEnv: 'dev' }), 'dev', 'set resolves to that env')

  const bundled = await m.bundledEnv(m.BASE_ENV_NAME)
  assert.equal(bundled.name, m.BASE_ENV_NAME)
  assert.equal(bundled.image, 'node:22-test', 'reads the base image setting')

  await m.setDefaultEnv(ws, 'dev')
  assert.equal((await m.getWorkspace(ws)).defaultEnv, 'dev', 'persisted')
  await assert.rejects(m.setDefaultEnv(ws, 'nope'), /not registered/, 'unknown env refused')
  await m.setDefaultEnv(ws, undefined)
  assert.equal((await m.getWorkspace(ws)).defaultEnv, undefined, 'cleared back to bundled')

  // The name is reserved: a workspace env may not take it (§2.2).
  await assert.rejects(
    m.addEnv(ws, { name: m.BASE_ENV_NAME, image: 'x' }),
    /reserved/,
    'the bundled name is reserved in the store validator'
  )
})

test('the bundled env resolves at start (env lookup passes)', async () => {
  fs.writeFileSync(
    path.join(GURT_ROOT, 'agents.json'),
    JSON.stringify({ a1: { kind: 'claude-code', label: 'claude' } })
  )
  const op = kernel.sessions.createSession(ref, [], 'a1', 'hi', 'run', [], true, {}, 'operator')
  const snap = await settle(kernel, op.id)
  // No docker here, so the start fails inside provisioning — but past the env
  // lookup (the bundled name resolved) and past the image-only check.
  assert.ok(!/is not registered/.test(snap.startError ?? ''), `bundled env resolved: ${snap.startError}`)
  assert.ok(!/image-only/.test(snap.startError ?? ''), 'bundled env is image-only')
  assert.ok(!/no repository/.test(snap.startError ?? ''), 'gates passed')
  kernel.sessions.deleteSession(op.id)
})

// --- the container layout of a repo-less operator (§2.1) --------------------

test('a repo-less operator mounts no repos and works in /workspaces', () => {
  const info = (role, repos) => ({
    id: 's1', env: 'dev', role, repos, task, workspace: ws, title: 't',
    state: 'draft', startPrompt: ''
  })
  // Zero repos is the mounted case with ZERO repo mounts: nothing to bind, a
  // workdir docker creates at container start (docs/requirements-env-docker.md §3.3).
  assert.deepEqual(m.containerLayout(info('operator', []), []), {
    mounts: [],
    workdir: '/workspaces'
  })
  // …and the gurt binds (skills, history) still ride beside it.
  const bind = { hostDir: '/h/skills', target: '/gurt/skills', readonly: true }
  assert.deepEqual(m.containerLayout(info('operator', []), [], [bind]).mounts, [
    { type: 'bind', source: '/h/skills', target: '/gurt/skills', readonly: true }
  ])
  // The other shapes keep today's container paths.
  const clone = { name: 'alpha', dir: '/h/alpha' }
  assert.deepEqual(m.containerLayout(info('researcher', ['alpha']), [clone]), {
    mounts: [{ type: 'bind', source: '/h/alpha', target: '/workspaces/alpha', readonly: true }],
    workdir: '/workspaces/alpha'
  })
  assert.deepEqual(m.containerLayout(info('executor', ['alpha']), [clone]), {
    mounts: [{ type: 'bind', source: '/h/alpha', target: '/workspaces/alpha' }],
    workdir: '/workspaces/alpha'
  })
})

/** A ref on another env of the same task. */
function ref2(env) {
  return { workspace: ws, task, env }
}
