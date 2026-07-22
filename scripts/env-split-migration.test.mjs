// Pure-fs tests for the env/repo split migration (no docker, no electron):
// legacy workspace.json / task.json / sessions.json read back in the new shape,
// and the read-time write-back happens exactly once. Bundles store.ts with
// esbuild on the fly, like agent-migration.test.mjs.
//
//   node scripts/env-split-migration.test.mjs
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-env-split-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

// gurtRoot is read from GURT_ROOT at module load — set it before the import.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-env-split-'))
process.env.GURT_ROOT = GURT_ROOT

await build({
  stdin: {
    contents: `export { getWorkspace, getTask, readSessions } from ${S('src/main/store.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['electron'],
  outfile,
  logLevel: 'silent'
})

const m = await import(pathToFileURL(outfile).href)
const read = (p) => fs.readFileSync(p, 'utf8')
const readJson = (p) => JSON.parse(read(p))

try {
  const ws = 'ws1'
  const task = 't'
  fs.mkdirSync(path.join(GURT_ROOT, ws, task), { recursive: true })

  // --- workspace.json: repos fuse devcontainer, no envs ---
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

  const wsData = await m.getWorkspace(ws)
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
  await m.getWorkspace(ws)
  assert.equal(read(wsPath), migratedWs, 'workspace.json write-back happens exactly once')
  console.log('workspace.json migration + write-once OK')

  // --- task.json: env records key by repo, no env ---
  const taskPath = path.join(GURT_ROOT, ws, task, 'task.json')
  fs.writeFileSync(
    taskPath,
    JSON.stringify({
      envs: [
        { repo: 'alpha', status: 'stopped' },
        { repo: 'beta', status: 'running', containerId: 'cid', remoteWorkspaceFolder: '/workspaces/beta' }
      ]
    })
  )
  const legacyTask = read(taskPath)
  assert.ok(!legacyTask.includes('"env"'), 'fixture starts without env identity')

  const taskData = await m.getTask(ws, task)
  // env = repo, the provisioned repo is kept
  assert.equal(taskData.envs[0].env, 'alpha')
  assert.equal(taskData.envs[0].repo, 'alpha')
  assert.equal(taskData.envs[1].env, 'beta')
  assert.equal(taskData.envs[1].repo, 'beta')
  assert.equal(taskData.envs[1].containerId, 'cid')

  const migratedTask = read(taskPath)
  assert.notEqual(migratedTask, legacyTask, 'task.json rewritten on first read')
  await m.getTask(ws, task)
  assert.equal(read(taskPath), migratedTask, 'task.json write-back happens exactly once')
  console.log('task.json migration + write-once OK')

  // --- sessions.json: info.envRepo fuses env + repo ---
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
  const [rec] = await m.readSessions(ws, task)
  assert.equal(rec.info.env, 'alpha', 'env taken from envRepo')
  assert.equal(rec.info.repo, 'alpha', 'repo taken from envRepo')
  assert.ok(!('envRepo' in rec.info), 'legacy envRepo dropped')
  // write-back happened (legacy key left the disk) … and exactly once
  const migratedSess = read(sessPath)
  assert.notEqual(migratedSess, legacySess, 'sessions.json rewritten on first read')
  assert.ok(!migratedSess.includes('envRepo'), 'legacy key gone from disk')
  await m.readSessions(ws, task)
  assert.equal(read(sessPath), migratedSess, 'sessions.json write-back happens exactly once')
  console.log('sessions.json migration OK')

  // --- already-migrated workspace.json is not rewritten ---
  const ws2 = 'ws2'
  fs.mkdirSync(path.join(GURT_ROOT, ws2), { recursive: true })
  const ws2Path = path.join(GURT_ROOT, ws2, 'workspace.json')
  fs.writeFileSync(
    ws2Path,
    JSON.stringify({ repos: [{ name: 'x', url: 'https://github.com/o/x.git' }], envs: [] }, null, 2) + '\n'
  )
  const before2 = read(ws2Path)
  const ws2Data = await m.getWorkspace(ws2)
  assert.deepEqual(ws2Data.envs, [])
  assert.equal(read(ws2Path), before2, 'already-migrated workspace.json is left untouched')
  console.log('no-op on already-migrated OK')

  console.log('env-split-migration.test: PASS')
} catch (e) {
  console.error('env-split-migration.test: FAIL')
  console.error(e)
  process.exitCode = 1
} finally {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
}
