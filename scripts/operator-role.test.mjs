// The operator role's table row (docs/requirements-session-operator.md §2,
// acceptance §12 item 2), without docker or an agent: zero repos enforced at
// every entrance, the repo-less start path through all four gates, no clone
// lock taken and none waited for, no `complete` and no nudge, no
// `create_session`, the image-only refusal, and the `operatorEnv` resolution.
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
// that gets past them would run a real `devcontainer up` — slow, networked,
// and failing on the fake image only after a feature fetch and a pull, well
// past `settle`'s patience. A stub that refuses instantly makes the path
// identical everywhere; every child inherits PATH through `run`/`runNodeCli`.
const stubBin = path.join(GURT_ROOT, 'stub-bin')
fs.mkdirSync(stubBin, { recursive: true })
fs.writeFileSync(
  path.join(stubBin, 'docker'),
  '#!/bin/sh\necho "docker stub: no daemon here" >&2\nexit 1\n'
)
fs.chmodSync(path.join(stubBin, 'docker'), 0o755)
process.env.PATH = `${stubBin}${path.delimiter}${process.env.PATH}`
// The bundled env's on-disk home resolves relative to the real module dir,
// which a bundled test does not have — the same seam GURT_PROXY_SCRIPT gives
// the proxy points the tests at a config they control.
const OPERATOR_ENV_FILE = path.join(GURT_ROOT, 'bundled-operator-env.json')
fs.writeFileSync(OPERATOR_ENV_FILE, JSON.stringify({ image: 'node:22-test' }))
process.env.GURT_OPERATOR_ENV = OPERATOR_ENV_FILE

const outfile = path.join(os.tmpdir(), `gurt-operator-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await bundle({
  stdin: {
    contents:
      `export { createKernel } from ${S('src/main/kernel.ts')}\n` +
      `export { assertRoleFitsRepos, postTurnDecision } from ${S('src/main/sessions.ts')}\n` +
      `export { addEnv, getWorkspace, setOperatorEnv } from ${S('src/main/store.ts')}\n` +
      `export { bundledOperatorEnv } from ${S('src/main/operatorEnv.ts')}\n` +
      `export { sessionConfigArgs } from ${S('src/main/containers.ts')}\n` +
      `export { OPERATOR_ENV_NAME, operatorEnvName, roleHasTurnContract, roleIsReadOnly, roleLocksClone, roleNeedsRepo, spawnableRoles } from ${S('src/shared/types.ts')}`,
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
      { name: 'dev', devcontainer: '{"image":"x"}', repo: 'alpha' },
      {
        name: 'buildenv',
        devcontainer: JSON.stringify({ build: { dockerfile: 'Dockerfile' } }),
        dockerfile: 'FROM scratch\n',
        repo: 'alpha'
      }
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
const ref = { workspace: ws, task, env: m.OPERATOR_ENV_NAME }

// --- the table row (§2.1) ---------------------------------------------------

test('operator row of the role table', () => {
  assert.deepEqual(
    [
      m.roleIsReadOnly('operator'),
      m.roleLocksClone('operator'),
      m.roleHasTurnContract('operator'),
      m.spawnableRoles('operator'),
      m.roleNeedsRepo('operator')
    ],
    [true, false, false, [], false],
    'mounts(none via wrapper) / lock / complete / create_session / needs-repo'
  )
  // Every existing role still needs a repo, and none may draft an operator.
  for (const role of ['executor', 'researcher', 'reviewer']) {
    assert.equal(m.roleNeedsRepo(role), true, `${role} needs a repo`)
    assert.ok(!m.spawnableRoles(role).includes('operator'), `${role} cannot draft an operator`)
  }
})

// --- zero repos enforced at every entrance (§2.1) ---------------------------

test('exactly zero repos: create, draft edit, IPC', async () => {
  assert.throws(
    () => m.assertRoleFitsRepos('operator', ['alpha']),
    /holds no repository/,
    'the pure rule refuses a repo-carrying operator'
  )
  assert.throws(
    () => kernel.sessions.createSession(ref, ['alpha'], 'a1', 'hi', 'draft', [], true, {}, 'operator'),
    /holds no repository/,
    'create refuses'
  )
  // Draft edit, through the IPC-boundary path (kernel.editDraft): re-pointing
  // an executor that holds a repo to operator without dropping the repo fails,
  // and the draft is left intact.
  const draft = kernel.sessions.createSession(ref, ['alpha'], 'a1', 'hi', 'draft', [], true, {}, 'executor')
  await assert.rejects(
    kernel.editDraft(draft.id, { role: 'operator' }),
    /holds no repository/,
    'draft edit refuses role=operator while a repo is held'
  )
  assert.equal(kernel.sessions.snapshot(draft.id).info.role, 'executor', 'rejected edit changed nothing')
  // With the repos dropped in the same patch the edit lands.
  await kernel.editDraft(draft.id, { role: 'operator', repos: [], env: m.OPERATOR_ENV_NAME })
  assert.equal(kernel.sessions.snapshot(draft.id).info.role, 'operator')
  kernel.sessions.deleteSession(draft.id)
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
  for (const role of ['executor', 'researcher', 'reviewer']) {
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
  const holder = kernel.sessions.createSession(ref2('dev'), ['alpha'], 'a1', 'hi', 'draft', [], true, {}, 'executor')
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

// --- operatorEnv resolution (§2.2) ------------------------------------------

test('operatorEnv: absent → bundled, set → that env', async () => {
  assert.equal(m.operatorEnvName({}), m.OPERATOR_ENV_NAME, 'absent resolves to the bundled default')
  assert.equal(m.operatorEnvName({ operatorEnv: 'dev' }), 'dev', 'set resolves to that env')

  const bundled = await m.bundledOperatorEnv()
  assert.equal(bundled.name, m.OPERATOR_ENV_NAME)
  assert.match(bundled.devcontainer, /node:22-test/, 'reads the bundled config (override seam)')

  await m.setOperatorEnv(ws, 'dev')
  assert.equal((await m.getWorkspace(ws)).operatorEnv, 'dev', 'persisted')
  await assert.rejects(m.setOperatorEnv(ws, 'nope'), /not registered/, 'unknown env refused')
  await m.setOperatorEnv(ws, undefined)
  assert.equal((await m.getWorkspace(ws)).operatorEnv, undefined, 'cleared back to bundled')

  // The name is reserved: a workspace env may not take it (§2.2).
  await assert.rejects(
    m.addEnv(ws, { name: m.OPERATOR_ENV_NAME, devcontainer: '{"image":"x"}' }),
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
  // The wrapper workspace-folder was staged, empty — zero repos is the mounted
  // case, and the mount list is empty (§2.1).
  const wrapper = path.join(GURT_ROOT, ws, task, '.multirepo', op.id, 'repos')
  assert.ok(fs.existsSync(wrapper), 'empty wrapper dir staged as --workspace-folder')
  assert.deepEqual(fs.readdirSync(wrapper), [], 'and it holds no mounts')
  kernel.sessions.deleteSession(op.id)
})

// --- up and exec resolve the same config (the first-real-run regression) ----

test('exec resolves exactly the config up wrote — zero mounts included', () => {
  const info = (role, repos, skills) => ({
    id: 's1', env: 'dev', role, repos, task, workspace: ws, title: 't',
    state: 'draft', startPrompt: '', ...(skills ? { skills } : {})
  })
  const envConfig = ['--override-config', path.join(GURT_ROOT, ws, '.devcontainers', 'dev.json')]
  const sessionConfig = [
    '--override-config',
    path.join(GURT_ROOT, ws, task, '.multirepo', 's1', 'devcontainer.json')
  ]
  // A repo-less operator's `up` runs on the env's own materialized file and
  // writes no per-session merged copy — every exec (the adapter probe, the
  // install, the spawn) must resolve that same file, not a merged copy that
  // was never written. This is the "ACP adapter install failed (exit 1)" of
  // the first real repo-less start.
  assert.deepEqual(m.sessionConfigArgs(info('operator', []), 's1', '.claude/skills'), envConfig)
  // With a skills bind there IS a merged copy (the bind is a mount of gurt's
  // own), and both sides resolve it.
  assert.deepEqual(
    m.sessionConfigArgs(info('operator', [], [{ name: 'greet' }]), 's1', '.claude/skills'),
    sessionConfig
  )
  // The existing pairings are untouched: a mounted role WITH repos merges, a
  // plain single-repo executor stays on the env's file.
  assert.deepEqual(m.sessionConfigArgs(info('researcher', ['alpha']), 's1', null), sessionConfig)
  assert.deepEqual(m.sessionConfigArgs(info('executor', ['alpha']), 's1', null), envConfig)
})

/** A ref on another env of the same task. */
function ref2(env) {
  return { workspace: ws, task, env }
}
