// Pure-fs tests for the env/repo split migration (no docker, no electron):
// legacy workspace.json / task.json / sessions.json read back in the new shape,
// and the read-time write-back happens exactly once.
import { afterAll, it } from 'vitest'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

// gurtRoot is read from GURT_ROOT at module load — set it before the import.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-env-split-'))
process.env.GURT_ROOT = GURT_ROOT
const { getWorkspace, getTask, readSessions } = await import('../src/main/store')

const read = (p: string) => fs.readFileSync(p, 'utf8')
const readJson = (p: string) => JSON.parse(read(p))
const ws = 'ws1'
const task = 't'

afterAll(() => {
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

fs.mkdirSync(path.join(GURT_ROOT, ws, task), { recursive: true })

it('workspace.json: repos fuse devcontainer into envs, write-back exactly once', async () => {
  const wsPath = path.join(GURT_ROOT, ws, 'workspace.json')
  fs.writeFileSync(
    wsPath,
    JSON.stringify({
      repos: [
        { name: 'alpha', url: 'https://github.com/o/alpha.git', devcontainer: '{"image":"x"}', credentialId: 'c1' },
        { name: 'beta', url: 'https://github.com/o/beta.git', devcontainer: '' }
      ]
    })
  )
  const legacyWs = read(wsPath)
  assert.ok(!legacyWs.includes('"envs"'), 'fixture starts without envs')

  const wsData = await getWorkspace(ws)
  // one env per repo, same name, seeded with the repo's devcontainer + itself as default
  assert.deepEqual(wsData.envs, [
    { name: 'alpha', devcontainer: '{"image":"x"}', repo: 'alpha' },
    { name: 'beta', devcontainer: '', repo: 'beta' }
  ])
  // repos are stripped of devcontainer, credential link preserved
  assert.deepEqual(wsData.repos, [
    { name: 'alpha', url: 'https://github.com/o/alpha.git', credentialId: 'c1' },
    { name: 'beta', url: 'https://github.com/o/beta.git' }
  ])
  assert.ok(wsData.repos.every((r) => !('devcontainer' in r)), 'no repo carries devcontainer')

  // write-back happened (file changed, now has envs) …
  const migratedWs = read(wsPath)
  assert.notEqual(migratedWs, legacyWs, 'workspace.json rewritten on first read')
  assert.ok(readJson(wsPath).envs.length === 2, 'envs persisted')
  // … and exactly once: a second read leaves the file byte-identical
  await getWorkspace(ws)
  assert.equal(read(wsPath), migratedWs, 'workspace.json write-back happens exactly once')
})

it('task.json: sessionless instance records are shed, session-keyed kept', async () => {
  // instances are per-session now — records without a `session` belong to no
  // session and are shed; session-keyed records are kept.
  const taskPath = path.join(GURT_ROOT, ws, task, 'task.json')
  fs.writeFileSync(
    taskPath,
    JSON.stringify({
      envs: [
        { repo: 'alpha', status: 'stopped' },
        { env: 'beta', repo: 'beta', status: 'stopped' },
        { session: 's1', env: 'beta', repo: 'beta', status: 'running', containerId: 'cid' }
      ]
    })
  )
  const legacyTask = read(taskPath)

  const taskData = await getTask(ws, task)
  // only the session-keyed record survives, untouched
  assert.equal(taskData.envs.length, 1)
  assert.equal(taskData.envs[0].session, 's1')
  assert.equal(taskData.envs[0].env, 'beta')
  assert.equal(taskData.envs[0].repo, 'beta')
  assert.equal(taskData.envs[0].containerId, 'cid')

  const migratedTask = read(taskPath)
  assert.notEqual(migratedTask, legacyTask, 'task.json rewritten on first read')
  await getTask(ws, task)
  assert.equal(read(taskPath), migratedTask, 'task.json write-back happens exactly once')
})

it('sessions.json: info.envRepo fuses into env + repo', async () => {
  const sessPath = path.join(GURT_ROOT, ws, task, 'sessions.json')
  fs.writeFileSync(
    sessPath,
    JSON.stringify([
      {
        info: {
          id: 's1',
          envRepo: 'alpha',
          task,
          workspace: ws,
          title: 'session 1',
          agent: 'claude-code',
          state: 'started',
          startPrompt: 'hi'
        },
        acpSessionId: 'a1'
      }
    ])
  )
  const legacySess = read(sessPath)
  const [rec] = await readSessions(ws, task)
  assert.equal(rec.info.env, 'alpha', 'env taken from envRepo')
  assert.equal(rec.info.repo, 'alpha', 'repo taken from envRepo')
  assert.ok(!('envRepo' in rec.info), 'legacy envRepo dropped')
  // write-back happened (legacy key left the disk) … and exactly once
  const migratedSess = read(sessPath)
  assert.notEqual(migratedSess, legacySess, 'sessions.json rewritten on first read')
  assert.ok(!migratedSess.includes('envRepo'), 'legacy key gone from disk')
  await readSessions(ws, task)
  assert.equal(read(sessPath), migratedSess, 'sessions.json write-back happens exactly once')
})

it('already-migrated workspace.json is not rewritten', async () => {
  const ws2 = 'ws2'
  fs.mkdirSync(path.join(GURT_ROOT, ws2), { recursive: true })
  const ws2Path = path.join(GURT_ROOT, ws2, 'workspace.json')
  fs.writeFileSync(
    ws2Path,
    JSON.stringify({ repos: [{ name: 'x', url: 'https://github.com/o/x.git' }], envs: [] }, null, 2) + '\n'
  )
  const before2 = read(ws2Path)
  const ws2Data = await getWorkspace(ws2)
  assert.deepEqual(ws2Data.envs, [])
  assert.equal(read(ws2Path), before2, 'already-migrated workspace.json is left untouched')
})
