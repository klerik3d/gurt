// The docker runtime (docs/requirements-env-docker.md §3, §13.4), driven
// against a fake `docker` on PATH that records argv + stdin: container create
// argv and mounts per session shape, setup/start semantics, the id-after-setup
// rule, every exec's target (-u/-w/-e PATH, container id), secrets never in
// argv, file content through stdin, uid alignment, the node runtime volume,
// the adapter install/launch, and boot reconcile. The setup *retry* contract
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
      mounts: [{ type: 'bind', source: dir, target: '/workspaces/repo' }]
    }),
    noop
  )
  assert.equal(r.containerId, 'cid-1')
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

const info = (role, repos) => ({ id: 's1', workspace: 'ws', task: 'task', env: 'dev', role, repos })

test('layout: single read-write clone → /workspaces/<repo>, workdir is the clone', () => {
  const l = m.containerLayout(info('executor', ['alpha']), [{ name: 'alpha', dir: '/h/alpha' }], false)
  assert.deepEqual(l.mounts, [{ type: 'bind', source: '/h/alpha', target: '/workspaces/alpha' }])
  assert.equal(l.workdir, '/workspaces/alpha')
})

test('layout: mounted sessions → /workspaces/<name>, readonly per role', () => {
  const one = m.containerLayout(info('researcher', ['a']), [{ name: 'a', dir: '/h/a' }], true)
  assert.deepEqual(one.mounts, [{ type: 'bind', source: '/h/a', target: '/workspaces/a', readonly: true }])
  assert.equal(one.workdir, '/workspaces/a')
  // a reviewer is read-only by role but its mount stays writable (readonly=false)
  const rev = m.containerLayout(info('reviewer', ['a']), [{ name: 'a', dir: '/h/a' }], false)
  assert.equal(rev.mounts[0].readonly, undefined)
  const multi = m.containerLayout(
    info('executor', ['a', 'b']),
    [{ name: 'a', dir: '/h/a' }, { name: 'b', dir: '/h/b' }],
    false
  )
  assert.deepEqual(multi.mounts.map((x) => x.target), ['/workspaces/a', '/workspaces/b'])
  assert.equal(multi.workdir, '/workspaces')
  // repo-less operator: no repo mounts, workdir is the (created) parent
  const op = m.containerLayout(info('operator', []), [], false)
  assert.deepEqual(op.mounts, [])
  assert.equal(op.workdir, '/workspaces')
  assert.throws(() => m.containerLayout(info('executor', ['a']), [], false), /no repository/)
})

test('layout: skills read-only and history read-write binds land at their own targets', () => {
  const claude = m.agentDef('claude-code')
  const extra = [
    { hostDir: '/h/skills', target: m.SKILLS_MOUNT, readonly: true },
    ...m.historyHostMounts('ws', 'task', 's1', claude.historyPaths)
  ]
  const l = m.containerLayout(info('executor', ['a']), [{ name: 'a', dir: '/h/a' }], false, extra)
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
    info('executor', ['a', 'b']),
    [{ name: 'a', dir: a }, { name: 'b', dir: b }],
    false
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
  assert.equal(p2, '/usr/local/bin:/usr/bin:/bin:/opt/gurt/node/bin:/home/dev/.gurt/npm/bin')
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

test('the env probe: -lic, then PATH gets gurt’s node and npm bins appended', async () => {
  fake.ctl({ volumeExists: true, volumeReady: true })
  const r = await m.createContainer(spec(), noop)
  assert.equal(r.path, '/usr/local/bin:/usr/bin:/bin:/opt/gurt/node/bin:/home/dev/.gurt/npm/bin')
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
  assert.equal(c.path, '/usr/local/bin:/usr/bin:/bin:/opt/gurt/node/bin:/home/dev/.gurt/npm/bin')
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
  await m.linkContainerSkills(T, '.claude/skills', noop)
  await m.adapterPresent(T, agent)
  await m.probeAdapterAndLinkSkills(T, agent, '.claude/skills', noop)
  await m.writeContainerUserFile(T, '.x/y', 'z')
  fake.ctl({ volumeExists: true })
  const execs = fake.execs()
  assert.ok(execs.length >= 6)
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

// --- adapter install and launch ---------------------------------------------------------

test('install: gurt’s node must run first (glibc message), then npm runs from the volume under a user prefix', async () => {
  const agent = m.agentDef('claude-code')
  fake.ctl({ exec: [{ match: '/opt/gurt/node/bin/node', codes: [127], stderr: 'not found\n' }] })
  await assert.rejects(m.installAcpAdapter(T, agent, noop), /glibc.*Alpine/s)
  assert.equal(fake.execs().length, 1, 'npm never ran')
  fake.reset()
  await m.installAcpAdapter(T, agent, noop)
  const [pre, npm] = fake.execs()
  assert.deepEqual(pre.cmd, ['/opt/gurt/node/bin/node', '--version'])
  const script = npm.cmd[2]
  assert.ok(script.includes('NPM_CONFIG_PREFIX="$HOME/.gurt/npm"'))
  assert.ok(script.includes('/opt/gurt/node/bin/npm install -g'))
  assert.ok(script.includes(`'${agent.adapterPackages[0]}'`))
  assert.ok(script.includes('export PATH="/opt/gurt/node/bin:$PATH"'))
  assert.ok(script.includes('.gurt/adapter-versions/claude-code'))
})

test('launch: a JS bin runs under gurt’s node, a non-JS bin is exec’d directly', async () => {
  const child = m.spawnAcpAdapter(T, m.agentDef('opencode'), '', 'K', {}, {})
  child.stdin.end()
  await once(child, 'close')
  const [e] = fake.execs()
  const script = e.cmd[2]
  assert.deepEqual(e.cmd.slice(3), ['opencode', 'acp'])
  // run the script for real against a temp HOME, with gurt's node swapped for a stub
  const home = fs.mkdtempSync(path.join(tmp, 'home-'))
  const pkg = path.join(home, '.gurt/npm/lib/pkg')
  fs.mkdirSync(path.join(home, '.gurt/npm/bin'), { recursive: true })
  fs.mkdirSync(pkg, { recursive: true })
  const stubNode = path.join(home, 'node')
  fs.writeFileSync(stubNode, '#!/bin/sh\necho "NODE $@"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(pkg, 'index.js'), '')
  fs.writeFileSync(path.join(pkg, 'opencode.exe'), '#!/bin/sh\necho "NATIVE $@"\n', { mode: 0o755 })
  fs.symlinkSync(path.join(pkg, 'index.js'), path.join(home, '.gurt/npm/bin/jsbin'))
  fs.symlinkSync(path.join(pkg, 'opencode.exe'), path.join(home, '.gurt/npm/bin/opencode'))
  const patched = script.replaceAll('/opt/gurt/node/bin/node', stubNode)
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
      user: 'dev', path: '/cached/bin', repos: ['repo']
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
