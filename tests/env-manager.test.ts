// EnvManager unit tests (no docker, no git, no electron): the provisioning
// layer (src/main/provision) is mocked, the store runs against a temp
// GURT_ROOT, and SessionManager/bus are recording fakes. Covers the
// per-session instance lifecycle (start → running → stop), session-keyed
// state, the failure path, leftover-container replacement, release/remove
// semantics and the idle auto-stop policy.
import { afterAll, beforeEach, it, vi } from 'vitest'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import type { EnvRef } from '../src/shared/types'
import type { Bus } from '../src/main/bus'
import type { SessionManager } from '../src/main/sessions'

// Everything envs.ts shells out through is faked — no container runtime here.
vi.mock('../src/main/provision', () => ({
  run: vi.fn(),
  ensureClone: vi.fn(),
  removeClone: vi.fn(),
  isDirty: vi.fn(),
  discoverDevcontainer: vi.fn(),
  overrideConfigArgs: vi.fn(),
  devcontainerUp: vi.fn(),
  installAcpAdapter: vi.fn(),
  installGitShims: vi.fn(),
  spawnAcpAdapter: vi.fn(),
  dockerRunning: vi.fn(),
  dockerStop: vi.fn(),
  dockerRemove: vi.fn()
}))

// GURT_ROOT must be set before the store module loads (read at import time).
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-env-manager-'))
process.env.GURT_ROOT = GURT_ROOT

const provision = await import('../src/main/provision')
const store = await import('../src/main/store')
const { EnvManager } = await import('../src/main/envs')

const WS = 'w'
const TASK = 't'

afterAll(() => {
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

// workspace with two repos and two env definitions; empty task
fs.mkdirSync(path.join(GURT_ROOT, WS, TASK), { recursive: true })
fs.writeFileSync(
  path.join(GURT_ROOT, WS, 'workspace.json'),
  JSON.stringify({
    repos: [
      { name: 'alpha', url: 'https://github.com/o/alpha.git' },
      { name: 'beta', url: 'https://github.com/o/beta.git' }
    ],
    envs: [
      { name: 'env1', devcontainer: '', repo: 'alpha' },
      { name: 'env2', devcontainer: '', repo: 'beta' }
    ]
  })
)
fs.writeFileSync(path.join(GURT_ROOT, WS, TASK, 'task.json'), JSON.stringify({ envs: [] }))
// agent instance registry for resolveEnv
fs.writeFileSync(
  path.join(GURT_ROOT, 'agents.json'),
  JSON.stringify({ a1: { kind: 'claude-code', label: 'cc' } })
)

const R = (session: string, env = 'env1'): EnvRef => ({ workspace: WS, task: TASK, env, session })

// --- recording fakes -------------------------------------------------------

const busEvents: { type: string; payload: any }[] = []
const bus = {
  emit: (type: string, payload: unknown) => {
    busEvents.push({ type, payload })
  },
  on: () => () => {}
} as unknown as Bus

const envStatuses = (session: string): string[] =>
  busEvents
    .filter((e) => e.type === 'env.status' && e.payload.ref.session === session)
    .map((e) => e.payload.status)

function mkManager() {
  const sessions = {
    closeEnv: vi.fn(),
    schedule: vi.fn(),
    isEnvIdle: vi.fn(() => true),
    listForTask: vi.fn(() => [] as { id: string; repo?: string }[])
  }
  const m = new EnvManager({ sessions: () => sessions as unknown as SessionManager, bus })
  return { m, sessions }
}

/** Container ids `dockerRunning` reports as live. */
const runningContainers = new Set<string>()
let upCount = 0

beforeEach(() => {
  vi.resetAllMocks()
  busEvents.length = 0
  runningContainers.clear()
  vi.mocked(provision.ensureClone).mockImplementation(async (ref, repo) =>
    store.cloneDir(ref.workspace, ref.task, repo.name)
  )
  vi.mocked(provision.overrideConfigArgs).mockResolvedValue([])
  vi.mocked(provision.devcontainerUp).mockImplementation(
    async (session, _configArgs, _dir, _log, repoName) => ({
      containerId: `c-${session}-${++upCount}`,
      remoteWorkspaceFolder: `/workspaces/${repoName}`
    })
  )
  vi.mocked(provision.dockerRunning).mockImplementation(async (id) => runningContainers.has(id))
  vi.mocked(provision.dockerStop).mockResolvedValue(undefined)
  vi.mocked(provision.dockerRemove).mockResolvedValue(undefined)
  vi.mocked(provision.installGitShims).mockResolvedValue(undefined)
  vi.mocked(provision.installAcpAdapter).mockResolvedValue(undefined)
  vi.mocked(provision.removeClone).mockResolvedValue(undefined)
})

const readTask = (): { envs: any[] } =>
  JSON.parse(fs.readFileSync(path.join(GURT_ROOT, WS, TASK, 'task.json'), 'utf8'))

const diskEnv = (session: string): any => readTask().envs.find((e) => e.session === session)

async function waitFor<T>(fn: () => T | undefined | false, what: string, timeoutMs = 2000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// --- tests -----------------------------------------------------------------

it('ensureRunning: provisions and persists a session-keyed running instance', async () => {
  const { m } = mkManager()
  const env = await m.ensureRunning(R('s1'), 'alpha')

  assert.equal(env.status, 'running')
  assert.equal(env.session, 's1')
  assert.equal(env.repo, 'alpha')
  assert.ok(env.containerId)
  assert.equal(env.remoteWorkspaceFolder, '/workspaces/alpha')

  // persisted task.json record is keyed by the session and carries the shape
  const rec = diskEnv('s1')
  assert.equal(rec.session, 's1')
  assert.equal(rec.env, 'env1')
  assert.equal(rec.repo, 'alpha')
  assert.equal(rec.status, 'running')
  assert.equal(rec.containerId, env.containerId)

  assert.deepEqual(envStatuses('s1'), ['starting', 'running'])
  assert.equal(vi.mocked(provision.devcontainerUp).mock.calls[0][0], 's1', 'up under the session id-label')
  assert.equal(await m.status(R('s1')), 'running')
  assert.equal(await m.find(R('missing')), undefined)
  assert.equal(await m.status(R('missing')), 'stopped', 'unknown session reads as stopped')
})

it('ensureRunning: concurrent calls for one session share one in-flight up', async () => {
  const { m } = mkManager()
  const gate: { release?: () => void } = {}
  vi.mocked(provision.devcontainerUp).mockImplementation(async (session) => {
    await new Promise<void>((r) => {
      gate.release = r
    })
    return { containerId: `c-${session}`, remoteWorkspaceFolder: '/workspaces/alpha' }
  })
  const p1 = m.ensureRunning(R('s2'), 'alpha')
  const p2 = m.ensureRunning(R('s2'), 'alpha')
  assert.equal(p1, p2, 'second concurrent call gets the same in-flight promise')
  await waitFor(() => gate.release, 'devcontainer up to start')
  gate.release!()
  const env = await p1
  assert.equal(env.status, 'running')
  assert.equal(vi.mocked(provision.devcontainerUp).mock.calls.length, 1, 'exactly one up')
})

it('state is keyed by session id: two sessions on one env/repo get independent containers', async () => {
  const { m } = mkManager()
  const a = await m.ensureRunning(R('s3a'), 'alpha')
  const b = await m.ensureRunning(R('s3b'), 'alpha')
  assert.notEqual(a.containerId, b.containerId)
  assert.equal(diskEnv('s3a').containerId, a.containerId)
  assert.equal(diskEnv('s3b').containerId, b.containerId)

  // stopping one session's instance never touches the other's container
  await m.stop(R('s3a'))
  const stopped = vi.mocked(provision.dockerStop).mock.calls.map((c) => c[0])
  assert.deepEqual(stopped, [a.containerId])
  assert.equal(diskEnv('s3a').status, 'stopped')
  assert.equal(diskEnv('s3b').status, 'running')
})

it('ensureRunning: a live container attaches without a new up; a dead one re-provisions', async () => {
  const { m } = mkManager()
  const first = await m.ensureRunning(R('s4'), 'alpha')
  runningContainers.add(first.containerId!)

  const again = await m.ensureRunning(R('s4'), 'alpha')
  assert.equal(again.containerId, first.containerId)
  assert.equal(vi.mocked(provision.devcontainerUp).mock.calls.length, 1, 'attach path skips up')

  // Docker daemon restart: persisted "running" is stale, the probe fails → re-up
  runningContainers.delete(first.containerId!)
  const third = await m.ensureRunning(R('s4'), 'alpha')
  assert.equal(vi.mocked(provision.devcontainerUp).mock.calls.length, 2)
  assert.notEqual(third.containerId, first.containerId)
  assert.equal(diskEnv('s4').containerId, third.containerId)
})

it('failure: provision rejects → error state, no zombie container, next attempt recovers', async () => {
  const { m } = mkManager()
  vi.mocked(provision.devcontainerUp).mockRejectedValueOnce(new Error('boom'))
  await assert.rejects(m.ensureRunning(R('s5'), 'alpha'), /boom/)

  const rec = diskEnv('s5')
  assert.equal(rec.status, 'error')
  assert.equal(rec.error, 'boom')
  assert.equal(rec.containerId, undefined, 'no zombie container id on the failed instance')
  assert.deepEqual(envStatuses('s5'), ['starting', 'error'])

  // the instance record is reused, the error clears, the session recovers
  const env = await m.ensureRunning(R('s5'), 'alpha')
  assert.equal(env.status, 'running')
  assert.ok(env.containerId)
  assert.equal(diskEnv('s5').error, undefined)
})

it('idle auto-stop never clobbers an error state with stopped', async () => {
  const { m } = mkManager()
  ;(m as unknown as { ENV_IDLE_STOP_MS: number }).ENV_IDLE_STOP_MS = 20
  vi.mocked(provision.devcontainerUp).mockRejectedValueOnce(new Error('kaboom'))
  await assert.rejects(m.ensureRunning(R('s6'), 'alpha'), /kaboom/)

  m.noteIdle(R('s6'))
  await sleep(120)
  assert.equal(diskEnv('s6').status, 'error', 'error status survives the idle timer')
  assert.equal(vi.mocked(provision.dockerStop).mock.calls.length, 0)
})

it('stop: stops the container, persists stopped, closes the env and kicks the scheduler', async () => {
  const { m, sessions } = mkManager()
  const env = await m.ensureRunning(R('s7'), 'alpha')
  await m.stop(R('s7'))

  assert.deepEqual(vi.mocked(provision.dockerStop).mock.calls.map((c) => c[0]), [env.containerId])
  assert.equal(diskEnv('s7').status, 'stopped')
  assert.equal(sessions.closeEnv.mock.calls.length, 1)
  assert.deepEqual(sessions.closeEnv.mock.calls[0][0], R('s7'))
  assert.equal(sessions.schedule.mock.calls.length, 1, 'a freed repo may release queued sessions')
  assert.ok(envStatuses('s7').includes('stopped'))
})

it('re-pointed repo: the leftover container is removed and a new one provisioned', async () => {
  const { m } = mkManager()
  const first = await m.ensureRunning(R('s8'), 'alpha')

  const env = await m.ensureRunning(R('s8'), 'beta')
  assert.deepEqual(
    vi.mocked(provision.dockerRemove).mock.calls.map((c) => c[0]),
    [first.containerId],
    'the container provisioned for the old repo cannot be reused'
  )
  assert.equal(env.repo, 'beta')
  assert.notEqual(env.containerId, first.containerId)
  assert.equal(env.remoteWorkspaceFolder, '/workspaces/beta')
  const cloned = vi.mocked(provision.ensureClone).mock.calls.map((c) => c[1].name)
  assert.deepEqual(cloned, ['alpha', 'beta'])
  const rec = diskEnv('s8')
  assert.equal(rec.repo, 'beta')
  assert.equal(rec.containerId, env.containerId)
})

it('release: drops the container and the instance record, keeps the clone', async () => {
  const { m, sessions } = mkManager()
  const env = await m.ensureRunning(R('s9'), 'alpha')

  await m.release(R('s9'))
  assert.deepEqual(vi.mocked(provision.dockerRemove).mock.calls.map((c) => c[0]), [env.containerId])
  assert.equal(diskEnv('s9'), undefined, 'instance record removed from task.json')
  assert.equal(vi.mocked(provision.removeClone).mock.calls.length, 0, 'the clone outlives the session')
  assert.equal(sessions.schedule.mock.calls.length, 1)

  // releasing a session with no instance is a silent no-op
  await m.release(R('nobody'))
  assert.equal(vi.mocked(provision.dockerRemove).mock.calls.length, 1)
})

it('remove: deletes the clone only when no other instance or session uses the repo', async () => {
  // own task, so instance records left by other tests never share the repo
  const TASK2 = 'trm'
  const R2 = (session: string): EnvRef => ({ workspace: WS, task: TASK2, env: 'env1', session })
  const disk2 = (session: string): any =>
    JSON.parse(fs.readFileSync(path.join(GURT_ROOT, WS, TASK2, 'task.json'), 'utf8')).envs.find(
      (e: any) => e.session === session
    )
  const { m, sessions } = mkManager()
  await m.ensureRunning(R2('s10a'), 'alpha')
  await m.ensureRunning(R2('s10b'), 'alpha')

  await m.remove(R2('s10a'))
  assert.equal(vi.mocked(provision.removeClone).mock.calls.length, 0, 'repo still used by s10b')
  assert.equal(disk2('s10a'), undefined)

  // a live session on the repo (without an instance record) also blocks removal
  sessions.listForTask.mockReturnValue([{ id: 'other', repo: 'alpha' }])
  await m.remove(R2('s10b'))
  assert.equal(vi.mocked(provision.removeClone).mock.calls.length, 0)

  // last user gone → the clone goes too
  await m.ensureRunning(R2('s10c'), 'alpha')
  sessions.listForTask.mockReturnValue([])
  await m.remove(R2('s10c'))
  assert.deepEqual(vi.mocked(provision.removeClone).mock.calls, [[WS, TASK2, 'alpha']])
})

it('idle auto-stop: fires after the grace period; activity cancels it; busy sessions are spared', async () => {
  const { m, sessions } = mkManager()
  ;(m as unknown as { ENV_IDLE_STOP_MS: number }).ENV_IDLE_STOP_MS = 25

  // idle env stops after the grace period
  const env = await m.ensureRunning(R('s11'), 'alpha')
  m.noteIdle(R('s11'))
  await waitFor(() => diskEnv('s11').status === 'stopped', 'idle auto-stop')
  assert.ok(vi.mocked(provision.dockerStop).mock.calls.some((c) => c[0] === env.containerId))

  // activity cancels a pending stop
  await m.ensureRunning(R('s12'), 'beta')
  m.noteIdle(R('s12'))
  m.noteActive(R('s12'))
  await sleep(120)
  assert.equal(diskEnv('s12').status, 'running')

  // a busy owning session blocks the stop even when the timer fires
  sessions.isEnvIdle.mockReturnValue(false)
  m.noteIdle(R('s12'))
  await sleep(120)
  assert.equal(diskEnv('s12').status, 'running')
})

it('resolveEnv: builds the validated launch context; rejects bad agent/repo input', async () => {
  const { m } = mkManager()
  const ref = R('s13')
  const ctx = await m.resolveEnv(ref, 'alpha', 'a1', false)
  assert.equal(ctx.agent.id, 'claude-code')
  assert.equal(ctx.session, 's13')
  assert.equal(ctx.remoteWorkspaceFolder, '/workspaces/alpha')
  assert.equal(ctx.hostWorkspaceFolder, store.cloneDir(WS, TASK, 'alpha'))
  assert.equal(ctx.secretEnv, 'CLAUDE_CODE_OAUTH_TOKEN', "the kind's default secret env")
  assert.equal(ctx.gitBrokerEnv, undefined, 'no git injection when gitAccess is off')
  assert.equal(diskEnv('s13').status, 'running')

  await assert.rejects(m.resolveEnv(ref, 'alpha', 'nope', false), /unknown agent "nope"/)
  await assert.rejects(m.resolveEnv(ref, undefined, 'a1', false), /session has no repository/)
  await assert.rejects(m.resolveEnv(ref, 'gamma', 'a1', false), /not registered/)
})
