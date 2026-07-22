// Pure-fs tests for the store's CRUD surface and the kernel operations that
// need no docker/ACP (no electron): workspace/repo/env/task round-trips on
// disk, guard errors, agents + agent-config files, session persistence write
// paths the migration tests don't cover, the session JSONL log, and tree
// building over fixtures.
import { afterAll, it } from 'vitest'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

// gurtRoot is read from GURT_ROOT at module load — set it before the import.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-store-crud-'))
process.env.GURT_ROOT = GURT_ROOT
const store = await import('../src/main/store')
const { createKernel } = await import('../src/main/kernel')

const read = (p: string) => fs.readFileSync(p, 'utf8')
const readJson = (p: string) => JSON.parse(read(p))

afterAll(() => {
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

// --- workspaces ------------------------------------------------------------

it('createWorkspace: empty file on disk, listed, readable, duplicate rejected', async () => {
  await store.createWorkspace('alpha')
  const file = path.join(GURT_ROOT, 'alpha', 'workspace.json')
  assert.deepEqual(readJson(file), { repos: [], envs: [] })
  assert.deepEqual(await store.getWorkspace('alpha'), { repos: [], envs: [] })
  assert.ok((await store.listWorkspaces()).includes('alpha'))
  await assert.rejects(store.createWorkspace('alpha'), /already exists/)
})

it('listWorkspaces: only dirs carrying a workspace.json count', async () => {
  fs.mkdirSync(path.join(GURT_ROOT, 'stray-dir'))
  fs.writeFileSync(path.join(GURT_ROOT, 'stray-file'), 'x')
  const names = await store.listWorkspaces()
  assert.ok(!names.includes('stray-dir'))
  assert.ok(!names.includes('stray-file'))
})

it('getWorkspace of an absent workspace: empty defaults, nothing created', async () => {
  assert.deepEqual(await store.getWorkspace('nope'), { repos: [], envs: [] })
  assert.ok(!fs.existsSync(path.join(GURT_ROOT, 'nope')))
})

it('name validation: empty, path-y and reserved names are rejected', async () => {
  for (const bad of ['', '  ', 'a/b', 'a\\b', '.', '..'])
    await assert.rejects(store.createWorkspace(bad), /must not/)
  // reserved names are per-kind and case-insensitive
  await assert.rejects(store.createWorkspace('Agents.JSON'), /reserved/)
  await store.createWorkspace('names')
  await assert.rejects(store.createTask('names', 'workspace.json'), /reserved/)
  await assert.rejects(store.createTask('names', '.devcontainers'), /reserved/)
  await assert.rejects(
    store.addRepo('names', { name: 'sessions', url: 'https://x/r.git' }),
    /reserved/
  )
  await assert.rejects(
    store.addRepo('names', { name: 'task.json', url: 'https://x/r.git' }),
    /reserved/
  )
  // env names only ever become .devcontainers/<env>.json — no reserved list,
  // segment rules still apply
  await store.addEnv('names', { name: 'task.json', devcontainer: '' })
  await assert.rejects(store.addEnv('names', { name: 'a/b', devcontainer: '' }), /must not/)
})

// --- repos -----------------------------------------------------------------

it('repo add/update round-trip on disk; duplicates and unknowns rejected', async () => {
  await store.createWorkspace('repos')
  await store.addRepo('repos', { name: 'r1', url: 'https://github.com/o/r1.git' })
  await assert.rejects(
    store.addRepo('repos', { name: 'r1', url: 'https://elsewhere/r1.git' }),
    /already exists/
  )
  await store.updateRepo('repos', {
    name: 'r1',
    url: 'https://github.com/o/r1-moved.git',
    credentialId: 'cred-1'
  })
  await assert.rejects(store.updateRepo('repos', { name: 'ghost', url: 'x' }), /not found/)
  // the round-trip is on disk, not just in memory
  assert.deepEqual(readJson(path.join(GURT_ROOT, 'repos', 'workspace.json')).repos, [
    { name: 'r1', url: 'https://github.com/o/r1-moved.git', credentialId: 'cred-1' }
  ])
})

it('removeRepo: blocked while an env defaults to it or a clone exists on disk', async () => {
  await store.addEnv('repos', { name: 'e1', devcontainer: '', repo: 'r1' })
  await assert.rejects(store.removeRepo('repos', 'r1'), /default of env\(s\): e1/)
  await store.updateEnv('repos', { name: 'e1', devcontainer: '' }) // drop the default

  // a live clone (a <task>/<repo>/.git on disk) still blocks — clones outlive records
  await store.createTask('repos', 't1')
  fs.mkdirSync(path.join(GURT_ROOT, 'repos', 't1', 'r1', '.git'), { recursive: true })
  assert.deepEqual(await store.tasksUsingRepo('repos', 'r1'), ['t1'])
  await assert.rejects(store.removeRepo('repos', 'r1'), /clone in task\(s\): t1/)

  fs.rmSync(path.join(GURT_ROOT, 'repos', 't1', 'r1'), { recursive: true })
  await store.removeRepo('repos', 'r1')
  assert.deepEqual(readJson(path.join(GURT_ROOT, 'repos', 'workspace.json')).repos, [])
})

// --- envs ------------------------------------------------------------------

it('env add/update round-trip; duplicates and unknowns rejected', async () => {
  await store.createWorkspace('envs')
  await store.addEnv('envs', { name: 'e1', devcontainer: '{"image":"a"}' })
  await assert.rejects(store.addEnv('envs', { name: 'e1', devcontainer: '' }), /already exists/)
  await store.updateEnv('envs', { name: 'e1', devcontainer: '{"image":"b"}', repo: 'r9' })
  await assert.rejects(store.updateEnv('envs', { name: 'ghost', devcontainer: '' }), /not found/)
  assert.deepEqual(readJson(path.join(GURT_ROOT, 'envs', 'workspace.json')).envs, [
    { name: 'e1', devcontainer: '{"image":"b"}', repo: 'r9' }
  ])
})

it('removeEnv: blocked by an instance record or a session on the env', async () => {
  await store.createTask('envs', 't1')
  await store.ensureTaskEnv('envs', 't1', 'e1', 'sess-a')
  assert.deepEqual(await store.tasksUsingEnv('envs', 'e1'), ['t1'])
  await assert.rejects(store.removeEnv('envs', 'e1'), /used by task\(s\): t1/)
  await store.removeTaskEnv('envs', 't1', 'sess-a')

  // sessions outlive their instances — a session on the env still blocks
  await store.writeSessions('envs', 't1', [
    {
      info: {
        id: 'sess-a',
        env: 'e1',
        task: 't1',
        workspace: 'envs',
        title: 's',
        state: 'draft',
        startPrompt: ''
      }
    }
  ])
  await assert.rejects(store.removeEnv('envs', 'e1'), /used by task\(s\): t1/)
  await store.writeSessions('envs', 't1', [])
})

it('removeEnv: drops the definition and its override devcontainer file', async () => {
  const override = store.overrideConfigPath('envs', 'e1')
  fs.mkdirSync(path.dirname(override), { recursive: true })
  fs.writeFileSync(override, '{"image":"b"}')
  await store.removeEnv('envs', 'e1')
  assert.deepEqual(readJson(path.join(GURT_ROOT, 'envs', 'workspace.json')).envs, [])
  assert.ok(!fs.existsSync(override), 'override config removed with the env')
})

// --- tasks + per-session instance records ----------------------------------

it('createTask/listTasks: empty task.json, duplicate rejected, absent reads empty', async () => {
  await store.createWorkspace('tasks')
  await store.createTask('tasks', 't1')
  assert.deepEqual(readJson(path.join(GURT_ROOT, 'tasks', 't1', 'task.json')), { envs: [] })
  await assert.rejects(store.createTask('tasks', 't1'), /already exists/)
  // a dir without task.json is not a task
  fs.mkdirSync(path.join(GURT_ROOT, 'tasks', 'not-a-task'))
  assert.deepEqual(await store.listTasks('tasks'), ['t1'])
  // absent task.json reads as empty and is not created by the read
  assert.deepEqual(await store.getTask('tasks', 'ghost'), { envs: [] })
  assert.ok(!fs.existsSync(path.join(GURT_ROOT, 'tasks', 'ghost')))
})

it('ensureTaskEnv: creates stopped record, idempotent, adopts a re-pointed env', async () => {
  const taskFile = path.join(GURT_ROOT, 'tasks', 't1', 'task.json')
  await store.ensureTaskEnv('tasks', 't1', 'e1', 's1')
  assert.deepEqual(readJson(taskFile).envs, [{ session: 's1', env: 'e1', status: 'stopped' }])
  // same (session, env): a pure no-op — the file is not rewritten
  const before = read(taskFile)
  await store.ensureTaskEnv('tasks', 't1', 'e1', 's1')
  assert.equal(read(taskFile), before, 'idempotent call leaves the file untouched')
  // re-pointed draft: env adopted on the existing record, rest kept
  await store.updateTaskEnv('tasks', 't1', 's1', { containerId: 'c-old' })
  await store.ensureTaskEnv('tasks', 't1', 'e2', 's1')
  assert.deepEqual(readJson(taskFile).envs, [
    { session: 's1', env: 'e2', status: 'stopped', containerId: 'c-old' }
  ])
})

it('updateTaskEnv: merges a patch; unknown session rejected', async () => {
  await store.updateTaskEnv('tasks', 't1', 's1', {
    status: 'running',
    containerId: 'c1',
    remoteWorkspaceFolder: '/w',
    repo: 'r1'
  })
  const [inst] = (await store.getTask('tasks', 't1')).envs
  assert.deepEqual(inst, {
    session: 's1',
    env: 'e2',
    status: 'running',
    containerId: 'c1',
    remoteWorkspaceFolder: '/w',
    repo: 'r1'
  })
  await assert.rejects(store.updateTaskEnv('tasks', 't1', 'ghost', { status: 'stopped' }), /no env instance/)
})

it('removeTaskEnv: drops only the addressed session record', async () => {
  await store.ensureTaskEnv('tasks', 't1', 'e1', 's2')
  await store.removeTaskEnv('tasks', 't1', 's1')
  const data = await store.getTask('tasks', 't1')
  assert.deepEqual(data.envs.map((e) => e.session), ['s2'])
  await store.removeTaskEnv('tasks', 't1', 's2')
  assert.deepEqual((await store.getTask('tasks', 't1')).envs, [])
})

it('taskCloneRepos: only task subdirs carrying a .git count', async () => {
  fs.mkdirSync(path.join(GURT_ROOT, 'tasks', 't1', 'cloned', '.git'), { recursive: true })
  fs.mkdirSync(path.join(GURT_ROOT, 'tasks', 't1', 'no-git'), { recursive: true })
  assert.deepEqual(await store.taskCloneRepos('tasks', 't1'), ['cloned'])
  assert.deepEqual(await store.taskCloneRepos('tasks', 'absent-task'), [])
})

// --- agents.json -----------------------------------------------------------

it('agents file: absent reads empty; setAgents/getAgents round-trip', async () => {
  assert.deepEqual(await store.getAgents(), {})
  const agents = {
    work: {
      kind: 'codex',
      label: 'codex work',
      credentialId: 'cred-9',
      secretEnv: 'MY_KEY',
      env: { OPENAI_BASE_URL: 'https://proxy' }
    }
  }
  await store.setAgents(agents)
  assert.deepEqual(await store.getAgents(), agents)
})

it('getAgents normalizes raw shapes: kind lifting, label fallback, junk dropped', async () => {
  fs.writeFileSync(
    path.join(GURT_ROOT, 'agents.json'),
    JSON.stringify({
      // legacy per-kind entry: no `kind`, the key is a known kind — lifted
      'claude-code': { enabled: true, oauthToken: 'LEAKY' },
      // instance with kind but no label — falls back to the kind def's label
      inst: { kind: 'codex', credentialId: 'cred-1' },
      // unknown kind keeps its kind string, label falls back to the kind itself
      odd: { kind: 'mystery' },
      // unknown key without a kind cannot be lifted — dropped
      ghost: { label: 'nope' },
      // non-object entries are skipped
      junk: 42,
      gone: null
    })
  )
  const agents = await store.getAgents()
  assert.deepEqual(Object.keys(agents).sort(), ['claude-code', 'inst', 'odd'])
  assert.equal(agents['claude-code'].kind, 'claude-code')
  assert.equal(agents['claude-code'].label, 'claude code')
  assert.equal(agents.inst.label, 'codex')
  assert.equal(agents.odd.label, 'mystery')
  // inline secrets / flags never surface through the model
  const flat = JSON.stringify(agents)
  assert.ok(!flat.includes('LEAKY') && !flat.includes('oauthToken') && !flat.includes('enabled'))
})

// --- agent-config-cache.json -----------------------------------------------

it('agent config: cache miss serves the kind default without writing it back', async () => {
  const cacheFile = path.join(GURT_ROOT, 'agent-config-cache.json')
  assert.deepEqual(await store.getAgentConfigs(), {})
  assert.ok(!fs.existsSync(cacheFile))
  // instance id resolves its kind through agents.json ('claude-code' from above)
  const viaKind = await store.getAgentConfig('claude-code')
  assert.equal(viaKind.configOptions.find((o) => o.id === 'model')?.currentValue, 'sonnet')
  // unknown agent id: kind defaults to the id itself → empty config
  assert.deepEqual(await store.getAgentConfig('stranger'), { configOptions: [], commands: [] })
  assert.ok(!fs.existsSync(cacheFile), 'defaults are never persisted by a read')
})

it('agent config: setAgentConfig persists and shadows the default', async () => {
  const reported = { configOptions: [], commands: [{ name: 'deploy', description: 'ship it' }] }
  await store.setAgentConfig('inst', reported)
  assert.deepEqual(await store.getAgentConfig('inst'), reported)
  assert.deepEqual(readJson(path.join(GURT_ROOT, 'agent-config-cache.json')), { inst: reported })
  // other ids still fall through to their defaults
  assert.equal(
    (await store.getAgentConfig('claude-code')).configOptions.length > 0,
    true,
    'unaffected id still gets its kind default'
  )
})

// --- sessions.json read fixups (beyond the envRepo migration tests) --------

it('readSessions: modern records round-trip byte-identical (no write-back)', async () => {
  await store.createWorkspace('sess')
  await store.createTask('sess', 't')
  const records = [
    {
      info: {
        id: 's1',
        env: 'e1',
        repo: 'r1',
        task: 't',
        workspace: 'sess',
        title: 'one',
        agent: 'claude-code',
        state: 'started' as const,
        startPrompt: 'hi'
      },
      acpSessionId: 'acp-1'
    }
  ]
  await store.writeSessions('sess', 't', records)
  const file = path.join(GURT_ROOT, 'sess', 't', 'sessions.json')
  const before = read(file)
  assert.deepEqual(await store.readSessions('sess', 't'), records)
  assert.equal(read(file), before, 'a modern file is not rewritten on read')
})

it('readSessions: state/startPrompt fixups are in-memory only', async () => {
  const file = path.join(GURT_ROOT, 'sess', 't', 'sessions.json')
  fs.writeFileSync(
    file,
    JSON.stringify([
      // pre-queue record: no state, no startPrompt
      { info: { id: 'old', env: 'e', task: 't', workspace: 'sess', title: 'o' } },
      // crashed mid-start: `starting` is runtime-only, restores as draft
      {
        info: {
          id: 'crash',
          env: 'e',
          task: 't',
          workspace: 'sess',
          title: 'c',
          state: 'starting',
          startPrompt: 'go',
          queuedAt: '2026-01-01T00:00:00Z'
        }
      }
    ])
  )
  const before = read(file)
  const [old, crash] = await store.readSessions('sess', 't')
  assert.equal(old.info.state, 'started', 'stateless legacy record reads as started')
  assert.equal(old.info.startPrompt, '', 'missing startPrompt defaults to empty')
  assert.equal(crash.info.state, 'draft', 'starting restores as draft')
  assert.equal(crash.info.queuedAt, undefined, 'queue slot released')
  // no legacy envRepo key involved → the fixups are not written back
  assert.equal(read(file), before, 'fixups stay in memory')
})

// --- per-session JSONL log -------------------------------------------------

it('session log: append batches, read back in order; absent file is empty', async () => {
  assert.deepEqual(await store.readSessionLog('sess', 't', 'log-1'), [])
  const r = (seq: number) => ({ seq, type: 'entry' as const, entry: { id: seq, kind: 'user' as const, text: `m${seq}` } })
  await store.appendSessionLog('sess', 't', 'log-1', [r(1), r(2)])
  await store.appendSessionLog('sess', 't', 'log-1', [r(3)])
  assert.deepEqual(
    (await store.readSessionLog('sess', 't', 'log-1')).map((x) => x.seq),
    [1, 2, 3]
  )
})

it('session log: re-appended and torn records are skipped on read', async () => {
  const r = (seq: number) => ({ seq, type: 'entry' as const, entry: { id: seq, kind: 'user' as const, text: `m${seq}` } })
  // a batch retried after a partial flush re-appends seq 2-3 — non-advancing, skipped
  await store.appendSessionLog('sess', 't', 'log-1', [r(2), r(3), r(4)])
  // a crash mid-append leaves a torn trailing line — dropped
  const file = path.join(GURT_ROOT, 'sess', 't', 'sessions', 'log-1.jsonl')
  fs.appendFileSync(file, '{"seq":5,"type":"en')
  const seqs = (await store.readSessionLog('sess', 't', 'log-1')).map((x) => x.seq)
  assert.deepEqual(seqs, [1, 2, 3, 4])
})

it('session log: delete removes the file; the log can restart afterwards', async () => {
  const file = path.join(GURT_ROOT, 'sess', 't', 'sessions', 'log-1.jsonl')
  await store.deleteSessionLog('sess', 't', 'log-1')
  assert.ok(!fs.existsSync(file))
  assert.deepEqual(await store.readSessionLog('sess', 't', 'log-1'), [])
  await store.appendSessionLog('sess', 't', 'log-1', [
    { seq: 1, type: 'entry', entry: { id: 1, kind: 'user', text: 'fresh' } }
  ])
  assert.equal((await store.readSessionLog('sess', 't', 'log-1')).length, 1)
})

// --- buildTree + kernel ----------------------------------------------------

it('buildTree: workspaces/tasks/instances fold into the tree, sessions empty', async () => {
  await store.createWorkspace('tree')
  await store.addRepo('tree', { name: 'r1', url: 'https://github.com/o/r1.git' })
  await store.addEnv('tree', { name: 'e1', devcontainer: '', repo: 'r1' })
  await store.createTask('tree', 't1')
  await store.ensureTaskEnv('tree', 't1', 'e1', 's1')
  await store.updateTaskEnv('tree', 't1', 's1', { status: 'error', error: 'boom', repo: 'r1' })

  const tree = await store.buildTree()
  assert.ok(!tree.workspaces.some((w) => w.name === 'stray-dir'), 'dirs without workspace.json skipped')
  const ws = tree.workspaces.find((w) => w.name === 'tree')
  assert.ok(ws, 'workspace present')
  assert.deepEqual(ws.repos, [{ name: 'r1', url: 'https://github.com/o/r1.git' }])
  assert.deepEqual(ws.envs, [{ name: 'e1', devcontainer: '', repo: 'r1' }])
  assert.equal(ws.tasks.length, 1)
  assert.deepEqual(ws.tasks[0], {
    name: 't1',
    envs: [
      {
        session: 's1',
        env: 'e1',
        repo: 'r1',
        containerId: undefined,
        remoteWorkspaceFolder: undefined,
        status: 'error',
        error: 'boom'
      }
    ],
    sessions: [] // the session manager overlays those
  })
})

// The kernel composes the store with the session manager — its tree overlay,
// draft guard and dirty-repo scan all run without docker/ACP.
it('kernel: session overlay, editDraft guards, dirty-repo scan, deleteTask', async () => {
  await store.createWorkspace('kws')
  await store.addRepo('kws', { name: 'r1', url: 'https://github.com/o/r1.git' })
  await store.addEnv('kws', { name: 'e1', devcontainer: '', repo: 'r1' })
  await store.createTask('kws', 'kt')
  await store.writeSessions('kws', 'kt', [
    {
      info: {
        id: 'draft-1',
        env: 'e1',
        repo: 'r1',
        task: 'kt',
        workspace: 'kws',
        title: 'a draft',
        agent: 'claude-code',
        state: 'draft',
        startPrompt: 'go'
      }
    }
  ])

  const kernel = createKernel()
  // restore runs fire-and-forget — poll until the session shows up
  let snap
  for (let i = 0; i < 100 && !snap; i++) {
    await new Promise((r) => setTimeout(r, 50))
    snap = kernel.sessions.snapshot('draft-1')
  }
  assert.ok(snap, 'restored draft must be visible')

  // tree(): buildTree + the restored session overlaid on its task
  const tree = await kernel.tree()
  const task = tree.workspaces.find((w) => w.name === 'kws')?.tasks.find((t) => t.name === 'kt')
  assert.ok(task)
  assert.deepEqual(task.sessions.map((s) => s.id), ['draft-1'])
  assert.equal(task.sessions[0].state, 'draft')

  // editDraft: repo/env must be registered in the workspace
  await assert.rejects(kernel.editDraft('draft-1', { repo: 'ghost' }), /not registered/)
  await assert.rejects(kernel.editDraft('draft-1', { env: 'ghost' }), /not registered/)
  await kernel.editDraft('draft-1', { startPrompt: 'updated', repo: null })
  const edited = kernel.sessions.snapshot('draft-1')!
  assert.equal(edited.info.startPrompt, 'updated')
  assert.equal(edited.info.repo, undefined, 'repo: null clears the draft repo')
  await kernel.editDraft('draft-1', { repo: 'r1' })
  assert.equal(kernel.sessions.snapshot('draft-1')!.info.repo, 'r1')

  // taskDirtyRepos: disk-based over real clones — clean repo no, untracked file yes
  const clone = store.cloneDir('kws', 'kt', 'r1')
  fs.mkdirSync(clone, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: clone })
  assert.deepEqual(await kernel.taskDirtyRepos('kws', 'kt'), [])
  fs.writeFileSync(path.join(clone, 'untracked.txt'), 'x')
  assert.deepEqual(await kernel.taskDirtyRepos('kws', 'kt'), ['r1'])

  // deleteTask: drops the sessions and removes the task dir from disk
  await kernel.deleteTask('kws', 'kt')
  assert.equal(kernel.sessions.snapshot('draft-1'), undefined)
  assert.ok(!fs.existsSync(path.join(GURT_ROOT, 'kws', 'kt')))
  assert.deepEqual(await store.listTasks('kws'), [])
})
