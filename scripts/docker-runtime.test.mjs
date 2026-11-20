// The docker runtime (docs/requirements-env-docker.md §3, §13.4), driven
// against a fake `docker` on PATH that records argv + stdin: container create
// argv and mounts per session shape, setup/start semantics, the id-after-setup
// rule, every exec's target (-u/-w/-e PATH, container id), secrets never in
// argv, file content through stdin, uid alignment, the node runtime volume,
// the adapters volume and its launch, and boot reconcile. The setup *retry* contract
// lives in provision-hook-retry.test.mjs.
//
//   node scripts/docker-runtime.test.mjs
import { test, after, beforeEach } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { installFakeDocker } from './lib/fake-docker.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-docker-runtime-'))
const GURT_ROOT = path.join(tmp, 'gurt')
process.env.GURT_ROOT = GURT_ROOT
process.env.GURT_STALE_BACKOFF_SCALE = '0'
fs.mkdirSync(GURT_ROOT, { recursive: true })
const fake = installFakeDocker(tmp)

// A workspace env the (repo-less) operator resolves by name.
const writeOpEnv = (cfg) => {
  fs.mkdirSync(path.join(process.env.GURT_ROOT, 'ws'), { recursive: true })
  fs.writeFileSync(
    path.join(process.env.GURT_ROOT, 'ws', 'workspace.json'),
    JSON.stringify({ repos: [], envs: [cfg] })
  )
}

const outfile = path.join(tmp, 'entry.mjs')
await bundle({
  stdin: {
    contents: `
      export * from ${S('src/main/provision.ts')}
      export { ContainerManager, containerLayout, historyHostMounts } from ${S('src/main/containers.ts')}
      export { cloneDir, sessionHistoryDir } from ${S('src/main/store.ts')}
      export { agentDef } from ${S('src/shared/agents.ts')}
      export { flushSync } from ${S('src/main/log.ts')}
      export { machinePrepare } from ${S('src/main/doctor.ts')}
      export { AGENT_MANIFESTS } from ${S('src/shared/agents.ts')}
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
beforeEach(() => fake.reset())

const noop = () => {}
const bindDir = (name) => {
  const d = path.join(GURT_ROOT, 'ws', 'task', name)
  fs.mkdirSync(d, { recursive: true })
  return d
}
const argvOf = () => JSON.stringify(fake.calls().map((c) => c.args))
/** The `--mount` values of the one `docker create`. */
const createMounts = () => {
  const [c] = fake.of('create')
  return c.args.flatMap((x, i) => (c.args[i - 1] === '--mount' ? [x] : []))
}
const spec = (over = {}) => ({
  session: 's1',
  image: 'img:1',
  env: { name: 'e', image: 'img:1' },
  workdir: '/workspaces/repo',
  mounts: [],
  skipSetup: false,
  ...over
})
const withPlatform = async (platform, uid, fn) => {
  const p = Object.getOwnPropertyDescriptor(process, 'platform')
  const u = process.getuid
  const g = process.getgid
  Object.defineProperty(process, 'platform', { value: platform })
  process.getuid = () => uid
  process.getgid = () => uid
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', p)
    process.getuid = u
    process.getgid = g
  }
}

// --- create argv --------------------------------------------------------------

test('create: labels, init, keep-alive entrypoint, env, node volume read-only', async () => {
  fake.ctl({ volumeExists: true, volumeReady: true })
  const dir = bindDir('repo')
  const r = await m.createContainer(
    spec({
      env: { name: 'e', image: 'img:1', env: { A: '1', B: 'two words' } },
      mounts: [{ type: 'bind', source: dir, target: '/workspaces/repo' }],
      agent: m.agentDef('claude-code')
    }),
    noop
  )
  assert.equal(r.containerId, 'cid-1')
  assert.match(r.adapters, /^gurt-adapters-[0-9a-f]{12}-amd64$/)
  const [c] = fake.of('create')
  const a = c.args
  const pairs = (flag) => a.flatMap((x, i) => (x === flag ? [a[i + 1]] : []))
  assert.deepEqual(pairs('--label'), ['gurt.session=s1', 'gurt.managed=1', 'gurt.runtime=docker'])
  assert.ok(a.includes('--init'))
  assert.deepEqual(pairs('--env'), ['A=1', 'B=two words'])
  assert.equal(a[a.indexOf('--entrypoint') + 1], '/bin/sh')
  assert.deepEqual(a.slice(a.indexOf('img:1')), [
    'img:1',
    '-c',
    'trap "exit 0" TERM; sleep infinity & wait'
  ])
  assert.equal(a[a.indexOf('-w') + 1], '/workspaces/repo')
  const mounts = createMounts()
  assert.ok(mounts.includes(`type=bind,source=${dir},target=/workspaces/repo`))
  assert.ok(
    mounts.some((x) => /^type=volume,source=gurt-node-[0-9a-f]{12}-amd64,target=\/opt\/gurt\/node,readonly$/.test(x)),
    mounts.join('\n')
  )
  assert.ok(
    mounts.includes(`type=volume,source=${r.adapters},target=/opt/gurt/adapters,readonly`),
    'the agent’s adapters volume is mounted read-only'
  )
  // start follows the create, on the id it printed
  assert.deepEqual(fake.of('start')[0].args, ['start', 'cid-1'])
})

test('mountArg CSV-quotes a path holding a comma or a quote', () => {
  assert.equal(
    m.mountArg({ type: 'bind', source: '/a,b/"c"', target: '/t', readonly: true }),
    'type=bind,"source=/a,b/""c""",target=/t,readonly'
  )
  assert.equal(m.mountArg({ type: 'volume', source: 'v', target: '/t' }), 'type=volume,source=v,target=/t')
})

// --- layouts per session shape --------------------------------------------------

const info = (role, repos, repoModes) => ({
  id: 's1',
  workspace: 'ws',
  task: 'task',
  env: 'dev',
  role,
  repos,
  ...(repoModes ? { repoModes } : {})
})

test('layout: single read-write clone → /workspaces/<repo>, workdir is the clone', () => {
  const l = m.containerLayout(info('executor', ['alpha'], { alpha: 'write' }), [{ name: 'alpha', dir: '/h/alpha' }])
  assert.deepEqual(l.mounts, [{ type: 'bind', source: '/h/alpha', target: '/workspaces/alpha' }])
  assert.equal(l.workdir, '/workspaces/alpha')
})

test('layout: mounted sessions → /workspaces/<name>, readonly per repo mode', () => {
  const one = m.containerLayout(info('researcher', ['a'], { a: 'read-locked' }), [{ name: 'a', dir: '/h/a' }])
  assert.deepEqual(one.mounts, [{ type: 'bind', source: '/h/a', target: '/workspaces/a', readonly: true }])
  assert.equal(one.workdir, '/workspaces/a')
  // the role says nothing about the mount: a researcher may write
  const rw = m.containerLayout(info('researcher', ['a'], { a: 'write' }), [{ name: 'a', dir: '/h/a' }])
  assert.equal(rw.mounts[0].readonly, undefined)
  // a mix: each bind carries its own mode
  const multi = m.containerLayout(
    info('executor', ['a', 'b', 'c'], { a: 'write', b: 'read-locked', c: 'read' }),
    [{ name: 'a', dir: '/h/a' }, { name: 'b', dir: '/h/b' }, { name: 'c', dir: '/h/c' }]
  )
  assert.deepEqual(multi.mounts.map((x) => [x.target, !!x.readonly]), [
    ['/workspaces/a', false],
    ['/workspaces/b', true],
    ['/workspaces/c', true]
  ])
  assert.equal(multi.workdir, '/workspaces')
  // a proactive run reads, whatever its record says
  const pro = m.containerLayout(info('proactive', ['a'], { a: 'write' }), [{ name: 'a', dir: '/h/a' }])
  assert.equal(pro.mounts[0].readonly, true)
  // repo-less operator: no repo mounts, workdir is the (created) parent
  const op = m.containerLayout(info('operator', []), [])
  assert.deepEqual(op.mounts, [])
  assert.equal(op.workdir, '/workspaces')
  assert.throws(() => m.containerLayout(info('executor', ['a']), []), /no repository/)
})

test('layout: skills read-only and history read-write binds land at their own targets', () => {
  const claude = m.agentDef('claude-code')
  const extra = [
    { hostDir: '/h/skills', target: m.SKILLS_MOUNT, readonly: true },
    ...m.historyHostMounts('ws', 'task', 's1', claude.historyPaths)
  ]
  const l = m.containerLayout(info('executor', ['a'], { a: 'write' }), [{ name: 'a', dir: '/h/a' }], extra)
  assert.deepEqual(l.mounts.slice(1).map((x) => [x.target, !!x.readonly]), [
    ['/gurt/skills', true],
    ['/gurt/history', false]
  ])
  assert.equal(l.mounts[2].source, m.sessionHistoryDir('ws', 'task', 's1'))
})

test('a mounted session mounts only its clone dirs — no wrapper dir, no ~/.gurt root', async () => {
  fake.ctl({ volumeExists: true, volumeReady: true })
  const a = bindDir('a')
  const b = bindDir('b')
  const { mounts, workdir } = m.containerLayout(
    info('executor', ['a', 'b'], { a: 'write', b: 'write' }),
    [{ name: 'a', dir: a }, { name: 'b', dir: b }]
  )
  await m.createContainer(spec({ workdir, mounts }), noop)
  const sources = createMounts().map((x) => /source=([^,]+)/.exec(x)[1])
  assert.deepEqual(sources.slice(0, 2), [a, b])
  assert.ok(!sources.includes(GURT_ROOT) && !sources.some((s) => s.endsWith('/repos') || s.includes('.multirepo')))
})

// --- setup / start ---------------------------------------------------------------

const scriptExecs = (needle) => fake.execs().filter((e) => e.cmd.some((c) => c === needle))

test('setup runs once, as the user in the workdir through a login shell; start runs after it', async () => {
  fake.ctl({ volumeExists: true, volumeReady: true })
  await m.createContainer(spec({ env: { name: 'e', image: 'img:1', setup: 'npm ci', start: 'svc up' } }), noop)
  const setup = scriptExecs('npm ci')
  const start = scriptExecs('svc up')
  assert.equal(setup.length, 1)
  assert.equal(start.length, 1)
  for (const e of [setup[0], start[0]]) {
    assert.equal(e.id, 'cid-1')
    assert.equal(e.user, 'dev')
    assert.equal(e.cwd, '/workspaces/repo')
    assert.ok(e.cmd[2].includes('exec "$sh_" -lc "$0"'), e.cmd[2])
  }
  const all = fake.execs().map((e) => e.cmd.join(' '))
  assert.ok(all.findIndex((c) => c.includes('npm ci')) < all.findIndex((c) => c.includes('svc up')))
})

test('setup is skipped for read-only roles; start still runs', async () => {
  fake.ctl({ volumeExists: true, volumeReady: true })
  const logs = []
  await m.createContainer(
    spec({ skipSetup: true, env: { name: 'e', image: 'img:1', setup: 'npm ci', start: 'svc up' } }),
    (l) => logs.push(l)
  )
  assert.equal(scriptExecs('npm ci').length, 0)
  assert.equal(scriptExecs('svc up').length, 1)
  assert.ok(logs.some((l) => /skipping the setup script/.test(l)))
})

test('start runs on restart too, and reuses the cached PATH without probing', async () => {
  const t = { containerId: 'cid-9', user: 'dev', cwd: '/w', path: '/cached/bin' }
  const p = await m.restartContainer(t, { name: 'e', image: 'x', start: 'svc up' }, [], noop)
  assert.equal(p, '/cached/bin')
  assert.deepEqual(fake.of('start')[0].args, ['start', 'cid-9'])
  assert.equal(scriptExecs('svc up').length, 1)
  assert.ok(!argvOf().includes('__GURT_ENV__'), 'no probe on restart')
  // a missing cached PATH is probed again
  fake.reset()
  const p2 = await m.restartContainer({ ...t, path: undefined }, { name: 'e', image: 'x' }, [], noop)
  assert.equal(p2, '/usr/local/bin:/usr/bin:/bin:/opt/gurt/node/bin:/opt/gurt/adapters/bin')
})

test('a failing start script fails the start but keeps the container', async () => {
  fake.ctl({ volumeExists: true, volumeReady: true, exec: [{ match: 'svc up', codes: [3], stdout: 'boom\n' }] })
  const done = []
  await assert.rejects(
    m.createContainer(spec({ env: { name: 'e', image: 'img:1', start: 'svc up' } }), noop, {
      onSetupDone: (id) => done.push(id)
    }),
    /start script failed \(exit 3\)\nboom/
  )
  assert.deepEqual(done, ['cid-1'], 'recorded: setup had succeeded')
  assert.equal(fake.of('rm').length, 0, 'container kept')
})

test('the env probe: -lic, then PATH gets gurt’s node and adapter bins appended', async () => {
  fake.ctl({ volumeExists: true, volumeReady: true })
  const r = await m.createContainer(spec(), noop)
  assert.equal(r.path, '/usr/local/bin:/usr/bin:/bin:/opt/gurt/node/bin:/opt/gurt/adapters/bin')
  const probe = fake.execs().find((e) => e.cmd.join(' ').includes('__GURT_ENV__'))
  assert.ok(probe.cmd[2].includes('-lic'))
  assert.equal(probe.env.length, 0, 'the probe runs without our PATH')
})

// --- id recorded only after setup ---------------------------------------------------

test('hooks: the id is announced only after setup succeeded', async () => {
  fake.ctl({ volumeExists: true, volumeReady: true })
  const events = []
  const mark = (e) => events.push([e, fake.calls().length])
  await m.createContainer(spec({ env: { name: 'e', image: 'img:1', setup: 'npm ci' } }), noop, {
    onCreated: () => mark('created'),
    onSetupDone: (id, user) => mark(`setup-done ${id} ${user}`)
  })
  const setupAt = fake.calls().findIndex((c) => c.args[0] === 'exec' && c.args.includes('npm ci')) + 1
  assert.equal(events[0][0], 'created')
  assert.ok(events[0][1] < setupAt, 'created fires before setup runs')
  assert.equal(events[1][0], 'setup-done cid-1 dev')
  assert.ok(events[1][1] >= setupAt, 'setup-done fires after setup ran')
})

test('ensure (repo-less operator): no patch names the container before setup has run', async () => {
  writeOpEnv({ name: 'op', image: 'op:1', setup: 'echo prep', start: 'echo go' })
  fake.ctl({ volumeExists: true, volumeReady: true })
  const sess = { id: 'op1', workspace: 'ws', task: 't', env: 'op', repos: [], role: 'operator', agent: undefined }
  const patches = []
  const manager = new m.ContainerManager({
    bus: { emit: noop },
    session: () => sess,
    sessions: () => [sess],
    patchContainer: (id, c) => {
      const setupRan = fake.execs().some((e) => e.cmd.some((x) => x === 'echo prep'))
      patches.push({ c: c && { ...c }, setupRan })
      sess.container = c
    },
    isSessionIdle: () => true,
    detach: noop
  })
  const c = await manager.ensure('op1')
  assert.equal(c.status, 'running')
  assert.equal(c.id, 'cid-1')
  assert.equal(c.remoteWorkspaceFolder, '/workspaces')
  assert.equal(c.user, 'dev')
  assert.equal(c.path, '/usr/local/bin:/usr/bin:/bin:/opt/gurt/node/bin:/opt/gurt/adapters/bin')
  for (const p of patches.filter((p) => p.c?.id)) assert.ok(p.setupRan, JSON.stringify(p))
  assert.ok(patches.some((p) => p.c?.status === 'post' && !p.c.id), 'a `post` record without an id exists')
  assert.equal(fake.of('create').length, 1)
  // `echo start` ran after setup; the image was looked up, not pulled
  assert.equal(fake.of('pull').length, 0)
})

// --- every exec ---------------------------------------------------------------------

const T = { containerId: 'cid-7', user: 'dev', cwd: '/workspaces/repo', path: '/p/bin:/opt/gurt/node/bin' }

test('every exec targets the container id and carries -u, -w and PATH', async () => {
  const agent = m.agentDef('claude-code')
  await m.linkContainerHistory(T, 's1', 'claude-code', agent.historyPaths, noop)
  await m.prepareContainer(T, agent, '.claude/skills', noop)
  await m.writeContainerUserFile(T, '.x/y', 'z')
  fake.ctl({ volumeExists: true })
  const execs = fake.execs()
  assert.ok(execs.length >= 3)
  for (const e of execs) {
    assert.equal(e.id, 'cid-7')
    assert.equal(e.user, 'dev')
    assert.equal(e.cwd, '/workspaces/repo')
    assert.ok(e.env.includes('PATH=/p/bin:/opt/gurt/node/bin'), JSON.stringify(e.env))
  }
})

test('secrets never reach argv: names by -e NAME, values in the client env', async () => {
  fake.ctl({ watch: ['AGENT_KEY', 'EXTRA_ONE', 'GIT_CONFIG_COUNT', 'LAUNCH_X'] })
  const agent = m.agentDef('claude-code')
  const child = m.spawnAcpAdapter(
    T, agent, 'sk-SECRET-VALUE', 'AGENT_KEY', { EXTRA_ONE: 'extra-secret-xyz' }, { GIT_CONFIG_COUNT: '1' }
  )
  child.stdin.end()
  await once(child, 'close')
  const child2 = m.spawnInContainer(T, ['cat', '/x'], { LAUNCH_X: 'launch-secret-123' })
  child2.stdin.end()
  await once(child2, 'close')
  const calls = fake.calls()
  const dump = JSON.stringify(calls.map((c) => c.args))
  for (const v of ['sk-SECRET-VALUE', 'extra-secret-xyz', 'launch-secret-123'])
    assert.ok(!dump.includes(v), `${v} leaked into argv`)
  const [adapter, cat] = fake.execs()
  for (const n of ['AGENT_KEY', 'EXTRA_ONE', 'GIT_CONFIG_COUNT']) assert.ok(adapter.env.includes(n), n)
  assert.deepEqual(adapter.raw.env, {
    AGENT_KEY: 'sk-SECRET-VALUE', EXTRA_ONE: 'extra-secret-xyz', GIT_CONFIG_COUNT: '1'
  })
  assert.ok(cat.env.includes('LAUNCH_X'))
  assert.equal(cat.raw.env.LAUNCH_X, 'launch-secret-123')
  assert.deepEqual(cat.cmd, ['cat', '/x'])
  assert.deepEqual(adapter.cmd.slice(0, 2), ['sh', '-c'])
  assert.equal(adapter.cmd[3], 'claude-agent-acp')
})

test('auth-file and client-config content arrives through stdin, not argv', async () => {
  await m.writeContainerUserFile(T, '.codex/auth.json', '{"access":"tok-abcdef"}')
  const [e] = fake.execs()
  assert.equal(e.stdin, '{"access":"tok-abcdef"}')
  assert.ok(e.flags.includes('-i'))
  assert.ok(!argvOf().includes('tok-abcdef'))
  assert.match(e.cmd[2], /umask 077 && mkdir -p "\$HOME\/\.codex" && cat > "\$HOME\/\.codex\/auth\.json"/)
  fake.ctl({ exec: [{ match: 'umask 077', codes: [1] }] })
  await assert.rejects(m.writeContainerUserFile(T, '.a/b', 'c'), /could not write ~\/\.a\/b/)
})

// --- uid alignment ------------------------------------------------------------------

const aligns = () => fake.execs().filter((e) => e.cmd[2]?.includes('usermod'))

test('uid alignment: linux, non-root user, mismatch → one exec as root with host uid/gid', async () => {
  fake.ctl({ volumeExists: true, volumeReady: true })
  await withPlatform('linux', 4242, () => m.createContainer(spec(), noop))
  const [a] = aligns()
  assert.equal(a.user, 'root')
  assert.deepEqual(a.cmd.slice(-3), ['dev', '4242', '4242'])
  assert.equal(a.id, 'cid-1')
})

test('uid alignment: never on macOS/Windows, for a root user, or for a root host', async () => {
  fake.ctl({ volumeExists: true, volumeReady: true })
  await withPlatform('darwin', 501, () => m.createContainer(spec(), noop))
  assert.equal(aligns().length, 0, 'darwin')
  fake.reset({ volumeExists: true, volumeReady: true, image: 'root|amd64' })
  await withPlatform('linux', 4242, () => m.createContainer(spec({ env: { name: 'e', image: 'img:1' } }), noop))
  assert.equal(aligns().length, 0, 'root user')
  fake.reset({ volumeExists: true, volumeReady: true })
  await withPlatform('linux', 0, () => m.createContainer(spec(), noop))
  assert.equal(aligns().length, 0, 'root host')
})

test('uid alignment: the script is a no-op when the uids already match, and failure only warns', async () => {
  fake.ctl({ volumeExists: true, volumeReady: true })
  // run the real script against a stub `id`/`usermod` to prove the equal-uid exit
  await withPlatform('linux', 1000, () => m.createContainer(spec(), noop))
  const script = aligns()[0].cmd[2]
  const bin = fs.mkdtempSync(path.join(tmp, 'align-'))
  fs.writeFileSync(path.join(bin, 'id'), '#!/bin/sh\ncase "$1" in -un) echo dev;; -u) echo 1000;; *) echo x;; esac\n', { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'usermod'), '#!/bin/sh\necho CALLED >> ' + path.join(bin, 'called') + '\n', { mode: 0o755 })
  execFileSync('sh', ['-c', script, 'align', 'dev', '1000', '1000'], { env: { PATH: `${bin}:/usr/bin:/bin` } })
  assert.ok(!fs.existsSync(path.join(bin, 'called')), 'usermod not called for an equal uid')
  fake.reset({ volumeExists: true, volumeReady: true, exec: [{ match: 'usermod', codes: [5], stdout: 'uid taken\n' }] })
  const logs = []
  await withPlatform('linux', 4242, () => m.createContainer(spec(), (l) => logs.push(l)))
  assert.ok(logs.some((l) => /could not align dev's uid/.test(l) && /uid taken/.test(l)), logs.join('\n'))
})

// --- stale bind ---------------------------------------------------------------------

test('stale bind: warm the bind sources and retry; gives up after three with the way out', async () => {
  const dir = bindDir('stale')
  const stale = { stderr: `docker: Error response: bind source path does not exist: /host_mnt${dir}`, code: 125 }
  fake.ctl({ volumeExists: true, volumeReady: true, createFails: [stale] })
  await m.createContainer(spec({ mounts: [{ type: 'bind', source: dir, target: '/w' }] }), noop)
  assert.equal(fake.of('create').length, 2)
  const warm = fake.of('run').find((c) => c.args.includes('alpine'))
  assert.ok(warm, 'the VM path cache was warmed')
  assert.ok(warm.args.join(' ').includes(`/probe${dir.slice(GURT_ROOT.length)}`))
  fake.reset({ volumeExists: true, volumeReady: true, createFails: [stale, stale, stale] })
  await assert.rejects(
    m.createContainer(spec({ mounts: [{ type: 'bind', source: dir, target: '/w' }] }), noop),
    /Docker could not see .*Retried 3×.*gRPC FUSE/s
  )
  assert.equal(fake.of('create').length, 3)
  // any other create failure is not retried
  fake.reset({ volumeExists: true, volumeReady: true, createFails: [{ stderr: 'no space left' }] })
  await assert.rejects(m.createContainer(spec(), noop), /no space left/)
  assert.equal(fake.of('create').length, 1)
})

// --- node runtime volume --------------------------------------------------------------

test('node volume: created with labels, filled from the pinned image for the env arch, once per process', async () => {
  const logs = []
  const name = await m.ensureNodeRuntimeVolume('arm64', (l) => logs.push(l))
  assert.match(name, /^gurt-node-[0-9a-f]{12}-arm64$/)
  const create = fake.of('volume', 'create')[0].args
  assert.deepEqual(create.slice(2, 6), ['--label', 'gurt.managed=1', '--label', 'gurt.kind=node-runtime'])
  assert.equal(create.at(-1), name)
  const fill = fake.of('run').find((c) => c.args.at(-1)?.includes('cp -a'))
  assert.ok(fill.args.includes('linux/arm64'))
  assert.ok(fill.args.includes(m.NODE_RUNTIME_IMAGE))
  assert.match(fill.args.at(-1), /cp -a \/usr\/local\/\. \/out\/ && touch \/out\/\.gurt-ready/)
  assert.ok(fill.args.some((x) => x === `type=volume,source=${name},target=/out`))
  const before = fake.calls().length
  assert.equal(await m.ensureNodeRuntimeVolume('arm64', noop), name)
  assert.equal(fake.calls().length, before, 'a second ensure runs nothing')
})

test('node volume: an existing volume without .gurt-ready is emptied and refilled; a ready one is left', async () => {
  fake.ctl({ volumeExists: true, volumeReady: false })
  await m.ensureNodeRuntimeVolume('s390x', noop)
  assert.equal(fake.of('volume', 'create').length, 0)
  const fill = fake.of('run').find((c) => c.args.at(-1)?.includes('cp -a'))
  assert.match(fill.args.at(-1), /^find \/out -mindepth 1 -delete && cp -a/)
  fake.reset({ volumeExists: true, volumeReady: true })
  await m.ensureNodeRuntimeVolume('riscv64', noop)
  assert.ok(!fake.of('run').some((c) => c.args.at(-1)?.includes('cp -a')))
})

// --- adapters volume --------------------------------------------------------------------

test('adapters volume: name keyed by pins + node digest + arch; labels; filled once by npm install -g into /out', async () => {
  const agent = m.agentDef('pi')
  const logs = []
  const name = await m.ensureAdaptersVolume(agent, 'arm64', (l) => logs.push(l), 's9')
  assert.equal(name, m.adaptersVolumeName(agent, 'arm64'))
  assert.match(name, /^gurt-adapters-[0-9a-f]{12}-arm64$/)
  // the key follows the pins (order-insensitive) and the node digest, not the kind id
  assert.equal(m.adaptersVolumeKey({ adapterPackages: [...agent.adapterPackages].reverse() }), m.adaptersVolumeKey(agent))
  assert.notEqual(m.adaptersVolumeKey(m.agentDef('codex')), m.adaptersVolumeKey(agent))
  assert.notEqual(m.adaptersVolumeKey({ adapterPackages: ['pi-acp@0.0.35'] }), m.adaptersVolumeKey({ adapterPackages: ['pi-acp@0.0.34'] }))
  const create = fake.of('volume', 'create')[0].args
  assert.deepEqual(create.slice(2, 6), ['--label', 'gurt.managed=1', '--label', 'gurt.kind=adapters'])
  assert.equal(create.at(-1), name)
  const fill = fake.of('run').find((c) => c.args.at(-1) === agent.adapterPackages.at(-1))
  assert.ok(fill, 'a throwaway run with the packages as positional args')
  const a = fill.args
  assert.ok(a.includes('--rm') && a.includes('linux/arm64') && a.includes(m.NODE_RUNTIME_IMAGE))
  assert.equal(a[a.indexOf('--entrypoint') + 1], 'sh')
  assert.ok(a.includes('NPM_CONFIG_PREFIX=/out'))
  assert.ok(a.includes('GURT_ADAPTER_BIN=pi-acp'))
  assert.ok(a.includes(`type=volume,source=${name},target=/out`), 'writable only for the fill')
  const script = a[a.indexOf('-c') + 1]
  assert.match(script, /find \/out -mindepth 1 -delete/)
  assert.match(script, /npm install -g .*"\$@"/)
  assert.match(script, /-lname "\/\*"/, 'absolute bin links fail the fill')
  assert.match(script, /touch \/out\/\.gurt-ready$/)
  assert.deepEqual(a.slice(a.indexOf('-c') + 2), ['sh', ...agent.adapterPackages], '$0 is sh, the packages are $@')
  assert.ok(!argvOf().includes('NPM_TOKEN'))
  // the stale sweep ran after the first fill
  assert.equal(fake.of('volume', 'ls').length, 1)
  const before = fake.calls().length
  assert.equal(await m.ensureAdaptersVolume(agent, 'arm64', noop), name)
  assert.equal(fake.calls().length, before, 'a second ensure runs nothing')
})

test('adapters volume: an unmarked one is emptied and refilled; a ready one is left; a failed fill rejects and is retried', async () => {
  const agent = m.agentDef('gemini')
  fake.ctl({ volumeExists: true, volumeReady: false })
  await m.ensureAdaptersVolume(agent, 's390x', noop)
  assert.equal(fake.of('volume', 'create').length, 0)
  assert.ok(fake.of('run').some((c) => c.args.includes(agent.adapterPackages[0])), 'refilled')
  fake.reset({ volumeExists: true, volumeReady: true })
  await m.ensureAdaptersVolume(agent, 'riscv64', noop)
  assert.ok(!fake.of('run').some((c) => c.args.includes(agent.adapterPackages[0])), 'a ready volume is left')
  // a fill that fails (npm network) rejects — the volume stays unmarked, the next call refills
  fake.reset({ fillFails: 1, fillStderr: 'npm ERR! network\n' })
  await assert.rejects(m.ensureAdaptersVolume(agent, 'mips64', noop), /exit|code|1/)
  fake.reset({ volumeExists: true, volumeReady: false })
  await m.ensureAdaptersVolume(agent, 'mips64', noop)
  assert.ok(fake.of('run').some((c) => c.args.includes(agent.adapterPackages[0])))
})

test('adapters volume: concurrent callers share one fill', async () => {
  const agent = m.agentDef('opencode')
  await Promise.all([1, 2, 3].map(() => m.ensureAdaptersVolume(agent, 'ppc64le', noop)))
  assert.equal(fake.of('volume', 'create').length, 1)
  assert.equal(fake.of('run').filter((c) => c.args.includes(agent.adapterPackages[0])).length, 1)
})

test('stale adapters volumes: only ones no registered kind names are removed; an in-use one is kept quietly', async () => {
  const keep = m.adaptersVolumeName(m.agentDef('claude-code'), 'amd64')
  fake.ctl({ volumeNames: [keep, 'gurt-adapters-aaaaaaaaaaaa-amd64', 'gurt-adapters-bbbbbbbbbbbb-arm64', 'not-ours'], volumeRmFails: ['gurt-adapters-bbbbbbbbbbbb-arm64'] })
  const logs = []
  await m.removeStaleAdapterVolumes((l) => logs.push(l))
  assert.deepEqual(fake.of('volume', 'rm').map((c) => c.args[2]), ['gurt-adapters-aaaaaaaaaaaa-amd64', 'gurt-adapters-bbbbbbbbbbbb-arm64'])
  assert.deepEqual(logs, ['removed superseded adapters volume gurt-adapters-aaaaaaaaaaaa-amd64'])
  assert.ok(fake.of('volume', 'ls')[0].args.includes('label=gurt.kind=adapters'))
})

test('phases: docker-create, setup, start, exec-path-probe and both volume fills are logged as provision.phase', async () => {
  fake.ctl({ volumeExists: false, image: 'dev|sparc64' })
  await m.createContainer(
    spec({ session: 'sP', env: { name: 'e', image: 'img:1', setup: 'echo a', start: 'echo b' }, agent: m.agentDef('codex') }),
    noop
  )
  m.flushSync()
  const logFile = path.join(GURT_ROOT, 'logs', 'gurt.log')
  const phases = fs
    .readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((l) => l.includes('provision.phase') && l.includes('sP'))
    .map((l) => /phase[=":\s]+([a-z-]+)/.exec(l)?.[1])
  for (const want of ['node-volume-fill', 'adapters-volume-fill', 'docker-create', 'setup', 'start', 'exec-path-probe'])
    assert.ok(phases.includes(want), `${want} in ${phases}`)
  // a restart times its own steps
  await m.restartContainer({ containerId: 'c', user: 'dev', cwd: '/w' }, { name: 'e', image: 'x', start: 'echo b' }, [], noop, 'sR')
  m.flushSync()
  const restartPhases = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.includes('provision.phase') && l.includes('sR'))
  assert.equal(restartPhases.length, 3, restartPhases.join('\n'))
})

// --- adapter launch ---------------------------------------------------------

test('prepare: one exec links skills, checks gurt’s node and the adapter bin; a musl image fails with the glibc message', async () => {
  const agent = m.agentDef('claude-code')
  const logs = []
  await m.prepareContainer(T, agent, '.claude/skills', (l) => logs.push(l))
  const [e] = fake.execs()
  assert.equal(fake.execs().length, 1, 'one exec, no install')
  assert.match(e.cmd[2], /ln -s \/gurt\/skills "\$HOME\/\.claude\/skills"/)
  assert.ok(e.cmd[2].includes('/opt/gurt/node/bin/node --version'))
  assert.ok(e.cmd[2].includes('[ -e "/opt/gurt/adapters/bin/claude-agent-acp" ]'))
  assert.ok(!e.cmd[2].includes('npm'), 'nothing is installed any more')
  assert.ok(logs.some((l) => l.includes('linked as ~/.claude/skills')))
  // no skills owed: no link in the script
  fake.reset()
  await m.prepareContainer(T, agent, null, noop)
  assert.ok(!fake.execs()[0].cmd[2].includes('ln -s'))
  // node does not run (bit 1) → the glibc/Alpine sentence; skills bit alone is not fatal
  fake.reset({ exec: [{ match: '/opt/gurt/node/bin/node', codes: [2], stderr: 'not found\n' }] })
  await assert.rejects(m.prepareContainer(T, agent, null, noop), /glibc.*Alpine/s)
  fake.reset({ exec: [{ match: '/opt/gurt/node/bin/node', codes: [1] }] })
  const logs2 = []
  await m.prepareContainer(T, agent, '.claude/skills', (l) => logs2.push(l))
  assert.ok(logs2.some((l) => l.includes('could not link')))
  // the bin missing from the volume (bit 4)
  fake.reset({ exec: [{ match: '/opt/gurt/node/bin/node', codes: [4] }] })
  await assert.rejects(m.prepareContainer(T, agent, null, noop), /adapters volume has no claude-agent-acp/)
})

test('prepare: the real shell prints node’s own stderr and exits with the bit; codes outside the mask are not decoded', async () => {
  const agent = m.agentDef('claude-code')
  await m.prepareContainer(T, agent, null, noop)
  const script = fake.execs()[0].cmd[2]
  const home = fs.mkdtempSync(path.join(tmp, 'prep-'))
  fs.mkdirSync(path.join(home, 'adapters/bin'), { recursive: true })
  const badNode = path.join(home, 'node')
  fs.writeFileSync(badNode, '#!/bin/sh\necho "loader: libstdc++.so.6 not found" >&2\nexit 127\n', { mode: 0o755 })
  const patched = script.replaceAll('/opt/gurt/node/bin/node', badNode).replaceAll('/opt/gurt/adapters', path.join(home, 'adapters'))
  let out = ''
  let code = 0
  try {
    execFileSync('sh', ['-c', patched], { encoding: 'utf8' })
  } catch (e) {
    out = e.stdout
    code = e.status
  }
  assert.equal(code, 2 + 4, 'node failed (2) and the bin is absent (4)')
  // a bin without the seal (a fill that died half-way) is still "missing"
  fs.writeFileSync(path.join(home, 'adapters/bin', agent.bin), '')
  const goodNode = path.join(home, 'node-ok')
  fs.writeFileSync(goodNode, '#!/bin/sh\necho v1\n', { mode: 0o755 })
  const unsealed = script.replaceAll('/opt/gurt/node/bin/node', goodNode).replaceAll('/opt/gurt/adapters', path.join(home, 'adapters'))
  assert.throws(() => execFileSync('sh', ['-c', unsealed], { stdio: 'pipe' }), (/** @type {any} */ e) => e.status === 4)
  fs.writeFileSync(path.join(home, 'adapters/.gurt-ready'), '')
  execFileSync('sh', ['-c', unsealed], { stdio: 'pipe' })
  assert.match(out, /libstdc\+\+\.so\.6 not found/)
  fake.reset({ exec: [{ match: '/opt/gurt/node/bin/node', codes: [127], stdout: 'sh: not found\n' }] })
  await assert.rejects(m.prepareContainer(T, agent, null, noop), /container preparation failed \(exit 127\)/)
})

test('prepare via the manager: a volume emptied behind a cached "ready" is dropped from the cache, refilled and re-checked once', async () => {
  withAgent()
  const agent = m.agentDef('claude-code')
  const name = `${m.adaptersVolumeName(agent, 'mips64el')}`
  const sess = { id: 'rf1', workspace: 'wse', task: 'task', env: 'dev', repos: ['repo'], role: 'executor', agent: 'ag', container: adaptersRecord({ status: 'running', adapters: name }) }
  const manager = managerFor(sess)
  // Prepare cached the volume, it was removed while unused, create re-made it empty.
  await m.ensureAdaptersVolume(agent, 'mips64el', noop)
  fake.reset({ volumeExists: true, volumeReady: false, exec: [{ match: '/opt/gurt/node/bin/node', codes: [4, 0] }] })
  manager.pendingPrepare.set('cid-old', { skillsDir: null })
  const logs = []
  manager.logFor = () => (l) => logs.push(l)
  await manager.prepare({ agent, session: 'rf1', containerId: 'cid-old', exec: { containerId: 'cid-old', user: 'dev', cwd: '/w' } })
  assert.ok(fake.of('run').some((c) => c.args.includes(agent.adapterPackages[0])), 'refilled')
  assert.equal(fake.execs().length, 2, 'checked again once')
  assert.ok(logs.some((l) => l.includes('is empty')))
})

test('ensure (outdated container): a failed fill for the replacement’s arch, or a missing replacement image, leaves the container and record alone', async () => {
  withAgent()
  seedWorkspace({ name: 'dev', image: 'img:1' })
  const old = () => adaptersRecord({ status: 'running', adapters: 'gurt-adapters-aaaaaaaaaaaa-amd64' })
  // the replacement image is another arch than the old volume's, and its fill fails
  fake.reset({ psSession: 'cid-old\n', image: 'dev|ppc64', fillFails: 1, fillStderr: 'npm ERR! network\n' })
  let sess = { id: 'ad6', workspace: 'wse', task: 'task', env: 'dev', repos: ['repo'], role: 'executor', agent: 'ag', container: old() }
  await assert.rejects(managerFor(sess).ensure('ad6'), /failed/)
  assert.equal(fake.of('rm').length, 0, 'not removed')
  assert.equal(fake.of('create').length, 0)
  assert.equal(sess.container.id, 'cid-old', 'the record still names it')
  // the replacement image cannot be had
  fake.reset({ psSession: 'cid-old\n', imageMissing: true })
  sess = { id: 'ad7', workspace: 'wse', task: 'task', env: 'dev', repos: ['repo'], role: 'executor', agent: 'ag', container: old() }
  await assert.rejects(managerFor(sess).ensure('ad7'), /not available locally/)
  assert.equal(fake.of('rm').length, 0)
  assert.equal(sess.container.id, 'cid-old')
  // and once everything is ready, the old one goes and the new one comes
  fake.reset({ psSession: 'cid-old\n', volumeExists: true, volumeReady: true })
  sess = { id: 'ad8', workspace: 'wse', task: 'task', env: 'dev', repos: ['repo'], role: 'executor', agent: 'ag', container: old() }
  const c = await managerFor(sess).ensure('ad8')
  assert.deepEqual(fake.of('rm').map((x) => x.args.at(-1)), ['cid-old'])
  assert.notEqual(c.id, 'cid-old')
})

test('prepare: a bin without the .gurt-ready seal is not accepted', async () => {
  await m.prepareContainer(T, m.agentDef('claude-code'), null, noop)
  assert.ok(fake.execs()[0].cmd[2].includes('/opt/gurt/adapters/.gurt-ready'))
})

test('machinePrepare fills the node volume and one adapters volume per distinct pin set', async () => {
  fake.reset({ image: 'riscv32' })
  await m.machinePrepare(noop)
  const keys = new Set(m.AGENT_MANIFESTS.map((a) => m.adaptersVolumeKey(a)))
  const creates = fake.of('volume', 'create').map((c) => c.args.at(-1))
  assert.equal(creates.filter((n) => n.startsWith('gurt-adapters-')).length, keys.size)
  assert.ok(creates.some((n) => n.startsWith('gurt-node-')))
  assert.ok(creates.every((n) => n.endsWith('-riscv32')))
})

test('launch: a JS bin runs under gurt’s node, a non-JS bin is exec’d directly', async () => {
  const child = m.spawnAcpAdapter(T, m.agentDef('opencode'), '', 'K', {}, {})
  child.stdin.end()
  await once(child, 'close')
  const [e] = fake.execs()
  const script = e.cmd[2]
  assert.deepEqual(e.cmd.slice(3), ['opencode', 'acp'])
  // run the script for real against a temp adapters dir, with gurt's node swapped for a stub
  const home = fs.mkdtempSync(path.join(tmp, 'home-'))
  const pkg = path.join(home, 'adapters/lib/pkg')
  fs.mkdirSync(path.join(home, 'adapters/bin'), { recursive: true })
  fs.mkdirSync(pkg, { recursive: true })
  const stubNode = path.join(home, 'node')
  fs.writeFileSync(stubNode, '#!/bin/sh\necho "NODE $@"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(pkg, 'index.js'), '')
  fs.writeFileSync(path.join(pkg, 'opencode.exe'), '#!/bin/sh\necho "NATIVE $@"\n', { mode: 0o755 })
  fs.symlinkSync(path.join(pkg, 'index.js'), path.join(home, 'adapters/bin/jsbin'))
  fs.symlinkSync(path.join(pkg, 'opencode.exe'), path.join(home, 'adapters/bin/opencode'))
  const patched = script.replaceAll('/opt/gurt/node/bin/node', stubNode).replaceAll('/opt/gurt/adapters', path.join(home, 'adapters'))
  const run = (bin, ...args) =>
    execFileSync('sh', ['-c', patched, bin, ...args], { env: { HOME: home, PATH: '/usr/bin:/bin' } }).toString().trim()
  assert.equal(run('jsbin', '--x'), `NODE ${path.join(fs.realpathSync(pkg), 'index.js')} --x`)
  assert.equal(run('opencode', 'acp'), 'NATIVE acp')
  assert.throws(() => run('missing'), /127|status/)
})

// --- reconcile ---------------------------------------------------------------------------

function reconcileSetup(records) {
  const sessions = records.map((r) => ({ id: r.id, workspace: 'ws', task: 't', env: 'e', repos: [], container: r.container }))
  const manager = new m.ContainerManager({
    bus: { emit: noop },
    session: (id) => sessions.find((s) => s.id === id),
    sessions: () => sessions,
    patchContainer: (id, c) => {
      sessions.find((s) => s.id === id).container = c
    },
    isSessionIdle: () => true,
    detach: noop
  })
  return { sessions, manager }
}
const rec = (id) => ({ status: 'running', id, repos: [] })

test('reconcile removes a pre-migration container (no gurt.runtime=docker) and resets its record', async () => {
  fake.ctl({ ps: 'old aaa111 \nnew bbb222 docker\n' })
  const { sessions, manager } = reconcileSetup([
    { id: 'old', container: rec('aaa111') },
    { id: 'new', container: rec('bbb222') }
  ])
  await manager.reconcile()
  assert.deepEqual(fake.of('rm').map((c) => c.args.at(-1)), ['aaa111'])
  assert.equal(sessions[0].container, undefined, 'record reset — the session recreates on next start')
  assert.equal(sessions[1].container.id, 'bbb222', 'the docker-runtime one is kept')
})

test('reconcile leaves everything alone when docker cannot be asked', async () => {
  fake.ctl({ psExit: 1 })
  const { sessions, manager } = reconcileSetup([{ id: 'old', container: rec('aaa111') }])
  await manager.reconcile()
  assert.equal(fake.of('rm').length, 0)
  assert.equal(sessions[0].container.id, 'aaa111')
})

test('reconcile still reaps an orphan (session gone) whatever its runtime label', async () => {
  fake.ctl({ ps: 'known k1 docker\ngone g1 \n' })
  const { manager } = reconcileSetup([{ id: 'known', container: rec('k1') }])
  await manager.reconcile()
  assert.deepEqual(fake.of('rm').map((c) => c.args.at(-1)), ['g1'])
})

// --- ensure, end to end through the manager (real clone, fake docker) ----------------

/** A bare origin with one commit, and a workspace registering it + one env. */
function seedWorkspace(env) {
  const seed = path.join(tmp, 'origin-seed')
  const bare = path.join(tmp, 'origin.git')
  const git = (dir, ...args) =>
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t.test', '-c', 'user.name=t', ...args], { stdio: 'pipe' })
  if (!fs.existsSync(bare)) {
    fs.mkdirSync(seed, { recursive: true })
    git(seed, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(seed, 'README.md'), '# hi\n')
    git(seed, 'add', '-A')
    git(seed, 'commit', '-qm', 'init')
    execFileSync('git', ['clone', '-q', '--bare', seed, bare], { stdio: 'pipe' })
  }
  fs.mkdirSync(path.join(GURT_ROOT, 'wse'), { recursive: true })
  fs.writeFileSync(
    path.join(GURT_ROOT, 'wse', 'workspace.json'),
    JSON.stringify({ repos: [{ name: 'repo', url: `file://${bare}` }], envs: [env] })
  )
}
const managerFor = (sess) =>
  new m.ContainerManager({
    bus: { emit: noop },
    session: () => sess,
    sessions: () => [sess],
    patchContainer: (_id, c) => {
      sess.container = c
    },
    isSessionIdle: () => true,
    detach: noop
  })

test('ensure (executor, image env): clone → create with the clone at /workspaces/<repo>, setup, start, record', async () => {
  seedWorkspace({ name: 'dev', image: 'img:1', setup: 'echo prep', start: 'echo go' })
  fake.ctl({ volumeExists: true, volumeReady: true })
  const sess = { id: 'ex1', workspace: 'wse', task: 'task', env: 'dev', repos: ['repo'], role: 'executor' }
  const c = await managerFor(sess).ensure('ex1')
  const clone = path.join(GURT_ROOT, 'wse', 'task', 'repo')
  assert.ok(fs.existsSync(path.join(clone, 'README.md')), 'the clone exists on the host')
  const [create] = fake.of('create')
  const mounts = create.args.flatMap((x, i) => (create.args[i - 1] === '--mount' ? [x] : []))
  assert.ok(mounts.includes(`type=bind,source=${clone},target=/workspaces/repo`), mounts.join(' | '))
  assert.ok(mounts.includes(`type=bind,source=${path.join(GURT_ROOT, 'wse', 'task', 'artifacts')},target=/workspaces/artifacts`), 'the scope artifacts dir, read-write')
  assert.equal(create.args[create.args.indexOf('-w') + 1], '/workspaces/repo')
  assert.deepEqual(
    fake.execs().filter((e) => e.cmd.some((x) => x === 'echo prep' || x === 'echo go')).map((e) => e.cmd.at(-1)),
    ['echo prep', 'echo go'],
    'setup then start'
  )
  assert.equal(c.remoteWorkspaceFolder, '/workspaces/repo')
  assert.equal(fake.of('pull').length, 0, 'an image already in the store is not pulled')
})

test('ensure (stopped own container): docker start + the start script, no create, cached PATH, no probe', async () => {
  seedWorkspace({ name: 'dev', image: 'img:1', setup: 'echo prep', start: 'echo go' })
  fake.ctl({ volumeExists: true, volumeReady: true, psSession: 'cid-old\n' })
  const sess = {
    id: 'ex2', workspace: 'wse', task: 'task', env: 'dev', repos: ['repo'], role: 'executor',
    container: {
      status: 'stopped', id: 'cid-old', remoteWorkspaceFolder: '/workspaces/repo',
      user: 'dev', path: '/cached/bin', repos: ['repo'], artifacts: true
    }
  }
  const c = await managerFor(sess).ensure('ex2')
  assert.equal(fake.of('create').length, 0, 'restarted in place, not recreated')
  assert.deepEqual(fake.of('start').map((x) => x.args), [['start', 'cid-old']])
  const execs = fake.execs()
  assert.ok(execs.every((e) => e.id === 'cid-old'))
  assert.equal(execs.filter((e) => e.cmd.some((x) => x === 'echo prep')).length, 0, 'setup does not run again')
  const start = execs.find((e) => e.cmd.some((x) => x === 'echo go'))
  assert.ok(start, 'the start script ran')
  assert.ok(start.env.includes('PATH=/cached/bin'), 'with the cached PATH')
  assert.ok(!execs.some((e) => e.cmd.join('\n').includes('__GURT_ENV__')), 'no new probe')
  assert.equal(c.status, 'running')
  assert.equal(c.path, '/cached/bin')
  assert.equal(c.id, 'cid-old')
})

test('ensure (stopped container from before the artifacts bind): re-created with it, not restarted', async () => {
  seedWorkspace({ name: 'dev', image: 'img:1' })
  fake.ctl({ volumeExists: true, volumeReady: true, psSession: 'cid-pre\n' })
  const sess = {
    id: 'ex2b', workspace: 'wse', task: 'task', env: 'dev', repos: ['repo'], role: 'executor',
    container: { status: 'stopped', id: 'cid-pre', remoteWorkspaceFolder: '/workspaces/repo', user: 'dev', path: '/x', repos: ['repo'] }
  }
  const c = await managerFor(sess).ensure('ex2b')
  assert.equal(fake.of('start').filter((x) => x.args[1] === 'cid-pre').length, 0, 'the old container is not restarted')
  const [create] = fake.of('create')
  assert.ok(create, 'a fresh create')
  const mounts = create.args.flatMap((x, i) => (create.args[i - 1] === '--mount' ? [x] : []))
  const artifacts = path.join(GURT_ROOT, 'wse', 'task', 'artifacts')
  assert.ok(mounts.includes(`type=bind,source=${artifacts},target=/workspaces/artifacts`), mounts.join(' | '))
  assert.ok(fs.statSync(artifacts).isDirectory(), 'the bind source exists on the host')
  assert.equal(c.artifacts, true, 'the record says so, so the next start restarts it')
})

// --- adapters volume: a container is reused only while it mounts the current one ---

const withAgent = (kind = 'claude-code') =>
  fs.writeFileSync(path.join(GURT_ROOT, 'agents.json'), JSON.stringify({ ag: { kind, label: 'A', credentialId: '' } }))
const adaptersRecord = (over = {}) => ({
  status: 'stopped', id: 'cid-old', remoteWorkspaceFolder: '/workspaces/repo', user: 'dev', path: '/x',
  repos: ['repo'], artifacts: true, ...over
})

test('ensure (agent session): a fresh create mounts the adapters volume and records its name', async () => {
  withAgent()
  seedWorkspace({ name: 'dev', image: 'img:1' })
  fake.ctl({ volumeExists: true, volumeReady: true })
  const sess = { id: 'ad1', workspace: 'wse', task: 'task', env: 'dev', repos: ['repo'], role: 'executor', agent: 'ag' }
  const c = await managerFor(sess).ensure('ad1')
  assert.match(c.adapters, /^gurt-adapters-[0-9a-f]{12}-amd64$/)
  assert.ok(createMounts().includes(`type=volume,source=${c.adapters},target=/opt/gurt/adapters,readonly`))
  assert.equal(sess.container.adapters, c.adapters)
})

test('ensure (stopped container that mounts the current adapters volume): restarted in place', async () => {
  withAgent()
  seedWorkspace({ name: 'dev', image: 'img:1' })
  fake.ctl({ volumeExists: true, volumeReady: true })
  const adapters = m.adaptersVolumeName(m.agentDef('claude-code'), 'amd64')
  const sess = { id: 'ad2', workspace: 'wse', task: 'task', env: 'dev', repos: ['repo'], role: 'executor', agent: 'ag', container: adaptersRecord({ adapters }) }
  const c = await managerFor(sess).ensure('ad2')
  assert.equal(fake.of('create').length, 0)
  assert.deepEqual(fake.of('start')[0].args, ['start', 'cid-old'])
  assert.equal(c.adapters, adapters, 'the record keeps naming the volume')
})

test('ensure (container from before the volume, or from before a pin bump): removed and re-created with the current one', async () => {
  withAgent()
  seedWorkspace({ name: 'dev', image: 'img:1' })
  for (const [i, adapters] of [[0, undefined], [1, 'gurt-adapters-aaaaaaaaaaaa-amd64']]) {
    fake.reset({ volumeExists: true, volumeReady: true, psSession: 'cid-old\n' })
    const sess = { id: `ad3${i}`, workspace: 'wse', task: 'task', env: 'dev', repos: ['repo'], role: 'executor', agent: 'ag', container: adaptersRecord(adapters ? { adapters } : {}) }
    const logs = []
    const manager = new m.ContainerManager({
      bus: { emit: (n, e) => n === 'provision.log' && logs.push(e.line) },
      session: () => sess,
      sessions: () => [sess],
      patchContainer: (id, c) => { sess.container = c },
      isSessionIdle: () => true,
      detach: noop
    })
    const c = await manager.ensure(sess.id)
    assert.deepEqual(fake.of('rm').map((x) => x.args.at(-1)), ['cid-old'], 'the stale container is removed')
    assert.equal(fake.of('start').filter((x) => x.args[1] === 'cid-old').length, 0)
    assert.equal(fake.of('create').length, 1)
    assert.equal(c.adapters, m.adaptersVolumeName(m.agentDef('claude-code'), 'amd64'))
    assert.ok(logs.some((l) => l.includes('adapters volume')), logs.join('\n'))
  }
})

test('ensure (a RUNNING container without the current adapters volume is not reused either)', async () => {
  withAgent()
  seedWorkspace({ name: 'dev', image: 'img:1' })
  fake.ctl({ volumeExists: true, volumeReady: true, psSession: 'cid-old\n' })
  const sess = { id: 'ad4', workspace: 'wse', task: 'task', env: 'dev', repos: ['repo'], role: 'executor', agent: 'ag', container: adaptersRecord({ status: 'running' }) }
  const c = await managerFor(sess).ensure('ad4')
  assert.equal(fake.of('create').length, 1)
  assert.notEqual(c.id, 'cid-old')
})

test('ensure: the container check is owed once per up, consumed by prepare (skills + node + bin in one exec)', async () => {
  withAgent()
  seedWorkspace({ name: 'dev', image: 'img:1' })
  fake.ctl({ volumeExists: true, volumeReady: true })
  const sess = { id: 'ad5', workspace: 'wse', task: 'task', env: 'dev', repos: ['repo'], role: 'executor', agent: 'ag' }
  const manager = managerFor(sess)
  const c = await manager.ensure('ad5')
  const target = { agent: m.agentDef('claude-code'), session: 'ad5', containerId: c.id, exec: { containerId: c.id, user: 'dev', cwd: '/workspaces/repo', path: c.path } }
  const before = fake.execs().length
  await manager.prepare(target)
  await manager.prepare(target)
  assert.equal(fake.execs().length - before, 1, 'one exec, then nothing owed')
  // the path carries the adapters bin
  assert.ok(c.path.endsWith(':/opt/gurt/node/bin:/opt/gurt/adapters/bin'))
})

test('ensure (stopped record whose container is gone): a fresh create, not a start', async () => {
  seedWorkspace({ name: 'dev', image: 'img:1' })
  fake.ctl({ volumeExists: true, volumeReady: true, inspectExit: 1 })
  const sess = {
    id: 'ex3', workspace: 'wse', task: 'task', env: 'dev', repos: ['repo'], role: 'executor',
    container: { status: 'stopped', id: 'cid-gone', remoteWorkspaceFolder: '/workspaces/repo', user: 'dev', path: '/x', repos: ['repo'] }
  }
  const c = await managerFor(sess).ensure('ex3')
  assert.equal(fake.of('create').length, 1)
  assert.notEqual(c.id, 'cid-gone')
})

test('ensure: an env with no image or Dockerfile fails the start before anything is provisioned', async () => {
  seedWorkspace({ name: 'dev' })
  const sess = { id: 'ex4', workspace: 'wse', task: 'task', env: 'dev', repos: ['repo'], role: 'executor' }
  await assert.rejects(managerFor(sess).ensure('ex4'), /image or a Dockerfile is required/)
  assert.equal(fake.of('create').length, 0)
  assert.equal(sess.container, undefined, 'refused before anything is provisioned')
})
