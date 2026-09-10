// Agent history mount (docs/requirements-agent-history.md), phase 1: the
// mechanism and claude-code. Pure node, no daemon — everything here is the
// mount-list contract and the host-side directory bookkeeping; the live
// "does a rebuilt container actually resume" check is §9 item 6, out of
// scope for an automated test.
//
// The properties, in the order they matter:
//
//   1. A kind with an empty `historyPaths` (opencode, §3.3) changes nothing:
//      same mount list, same `sessionConfigArgs`, no link exec.
//   2. A kind with entries (claude-code) adds exactly ONE read-write
//      `hostMounts` entry targeting `/gurt/history`, regardless of how many
//      entries `historyPaths` has, plus one link per entry.
//   3. `sessionConfigArgs` flips to the per-session merged config for a
//      plain single-repo executor with no skills on claude-code — the §4.1
//      regression a missed condition would surface as a broken `exec`.
//   4. The mount is never `readonly`, and slugs from different agent homes
//      do not collide.
//   5. Ensuring the history directory twice, with a file written in
//      between, keeps the file — the `rmTree` skills has that history must
//      not (§4 step 2).
//
//   node scripts/session-history-mount.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-history-mount-'))
process.env.GURT_ROOT = path.join(tmp, 'gurt')

// A stubbed `@devcontainers/cli` that records one JSON line per invocation to
// FAKE_STATE and answers with the exit code named by FAKE_EXIT (default 0) —
// the same trick scripts/mount-workspace-git-root.test.mjs uses, extended to
// count invocations rather than inspect a single one.
const cliDir = path.join(tmp, 'node_modules', '@devcontainers', 'cli')
fs.mkdirSync(cliDir, { recursive: true })
fs.writeFileSync(
  path.join(cliDir, 'package.json'),
  JSON.stringify({ name: '@devcontainers/cli', version: '0.0.0-stub', main: 'devcontainer.js' })
)
fs.writeFileSync(
  path.join(cliDir, 'devcontainer.js'),
  `const fs = require('fs')
const line = JSON.stringify(process.argv.slice(2)) + '\\n'
fs.appendFileSync(process.env.FAKE_STATE, line)
process.exit(Number(process.env.FAKE_EXIT || '0'))
`
)
const bin = path.join(tmp, 'bin')
fs.mkdirSync(bin)
fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\ntrue\n`)
fs.chmodSync(path.join(bin, 'docker'), 0o755)
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`

const state = path.join(tmp, 'invocations.jsonl')
process.env.FAKE_STATE = state

const outfile = path.join(tmp, 'entry.mjs')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await bundle({
  stdin: {
    contents: `
      export { AGENT_DEFS, agentDef } from ${S('src/shared/agents.ts')}
      export {
        usesSkillMounts, usesHistoryMounts, historyHostMounts, sessionConfigArgs
      } from ${S('src/main/containers.ts')}
      export { HISTORY_MOUNT, linkContainerHistory, sessionConfigPath } from ${S('src/main/provision.ts')}
      export {
        historySlug, ensureSessionHistory, sessionHistoryDir, sessionScratchDir
      } from ${S('src/main/store.ts')}
    `,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  external: ['@devcontainers/cli', 'electron'],
  outfile
})

const m = await import(pathToFileURL(outfile).href)

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** Invocations recorded by the stub CLI since the last call. */
function drainInvocations() {
  const raw = fs.existsSync(state) ? fs.readFileSync(state, 'utf8') : ''
  fs.rmSync(state, { force: true })
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

const ws = 'w'
const task = 't'
const sessionId = 's1'

/** Minimal `SessionInfo`, the shape `sessionConfigArgs` reads. */
function info(role, repos, skills) {
  return {
    id: sessionId, env: 'dev', role, repos, task, workspace: ws, title: 't',
    state: 'draft', startPrompt: '', ...(skills ? { skills } : {})
  }
}

// --- 1. opencode: empty historyPaths changes nothing -----------------------

test('a kind with empty historyPaths mounts nothing and links nothing', async () => {
  const opencode = m.agentDef('opencode')
  assert.deepEqual(opencode.historyPaths, [])
  assert.equal(m.usesHistoryMounts(opencode.historyPaths), false)
  assert.deepEqual(m.historyHostMounts(ws, task, sessionId, opencode.historyPaths), [])

  // Byte-identical to calling sessionConfigArgs without the new parameter at
  // all — the default keeps every existing call site's behaviour.
  const withDefault = m.sessionConfigArgs(info('executor', ['alpha']), sessionId, opencode.skillsDir)
  const withEmpty = m.sessionConfigArgs(info('executor', ['alpha']), sessionId, opencode.skillsDir, opencode.historyPaths)
  assert.deepEqual(withDefault, withEmpty)
  assert.deepEqual(withEmpty, [
    '--override-config',
    path.join(process.env.GURT_ROOT, ws, '.devcontainers', 'dev.json')
  ])

  const log = []
  await m.linkContainerHistory(sessionId, 'opencode', [], '/tmp/does-not-matter', opencode.historyPaths, (l) => log.push(l))
  assert.deepEqual(drainInvocations(), [], 'no exec was run for an empty historyPaths')
  assert.deepEqual(log, [], 'nothing to log either')
})

// --- 2. claude-code: one hostMounts entry, one link per entry --------------

test('a kind with entries adds exactly one read-write hostMounts entry, regardless of count', () => {
  const claude = m.agentDef('claude-code')
  assert.deepEqual(claude.historyPaths, ['.claude/projects', '.claude/todos'])
  assert.equal(m.usesHistoryMounts(claude.historyPaths), true)

  const two = m.historyHostMounts(ws, task, sessionId, claude.historyPaths)
  assert.equal(two.length, 1)
  assert.equal(two[0].target, m.HISTORY_MOUNT)
  assert.equal(two[0].hostDir, m.sessionHistoryDir(ws, task, sessionId))

  // A synthetic kind with more entries still gets exactly one mount — the
  // count of `historyPaths` never changes the mount count, only the links.
  const five = m.historyHostMounts(ws, task, sessionId, ['.a/b', '.a/c', '.d/e', '.d/f', '.g/h'])
  assert.equal(five.length, 1)
  assert.equal(five[0].target, m.HISTORY_MOUNT)
})

test('one link per historyPaths entry, each mkdir/rm/ln-ing its own slug', async () => {
  const claude = m.agentDef('claude-code')
  const log = []
  await m.linkContainerHistory(
    sessionId, 'claude-code', ['--override-config', '/cfg.json'], '/workspace', claude.historyPaths,
    (l) => log.push(l)
  )
  const calls = drainInvocations()
  assert.equal(calls.length, claude.historyPaths.length, 'one exec per entry')
  for (const [i, entry] of claude.historyPaths.entries()) {
    const argv = calls[i]
    assert.equal(argv[0], 'exec')
    assert.ok(argv.includes('--override-config') && argv.includes('/cfg.json'))
    const script = argv.at(-1)
    const slug = m.historySlug(entry)
    assert.ok(script.includes(`mkdir -p "$HOME/${path.posix.dirname(entry)}"`), script)
    assert.ok(script.includes(`rm -rf "$HOME/${entry}"`), script)
    assert.ok(script.includes(`ln -s ${m.HISTORY_MOUNT}/${slug} "$HOME/${entry}"`), script)
  }
  assert.ok(
    log.some((l) => l.includes('history mounted at') && l.includes('~/.claude/projects') && l.includes('~/.claude/todos')),
    `expected a human-readable success line, got: ${JSON.stringify(log)}`
  )
})

test('a failed link is logged per entry and is not fatal', async () => {
  process.env.FAKE_EXIT = '1'
  try {
    const log = []
    await m.linkContainerHistory(sessionId, 'claude-code', [], '/workspace', ['.claude/projects'], (l) => log.push(l))
    assert.ok(log.some((l) => l.includes('could not link') && l.includes('.claude/projects')), JSON.stringify(log))
  } finally {
    delete process.env.FAKE_EXIT
  }
})

// --- 3. §4.1 regression: a plain single-repo executor on claude-code -------

test('sessionConfigArgs returns the per-session merged config for a plain single-repo executor with no skills, on claude-code', () => {
  const claude = m.agentDef('claude-code')
  const plain = info('executor', ['alpha'])
  const args = m.sessionConfigArgs(plain, sessionId, claude.skillsDir, claude.historyPaths)
  assert.deepEqual(args, [
    '--override-config',
    m.sessionConfigPath(m.sessionScratchDir(ws, task, sessionId))
  ])
  // Confirm this really is a flip: the same session on a kind with no
  // history mount stays on the env's shared config, as it does today.
  const opencode = m.agentDef('opencode')
  assert.deepEqual(m.sessionConfigArgs(plain, sessionId, opencode.skillsDir, opencode.historyPaths), [
    '--override-config',
    path.join(process.env.GURT_ROOT, ws, '.devcontainers', 'dev.json')
  ])
})

// --- 4. never readonly; slugs from different homes don't collide -----------

test('the mount is not readonly, and slugs of entries from different agent homes do not collide', () => {
  const [mount] = m.historyHostMounts(ws, task, sessionId, ['.claude/projects'])
  assert.equal(mount.readonly, false)

  assert.equal(m.historySlug('.claude/projects'), 'claude-projects')
  assert.equal(m.historySlug('.claude/todos'), 'claude-todos')
  const slugs = new Set([
    m.historySlug('.claude/projects'),
    m.historySlug('.claude/todos'),
    m.historySlug('.gemini/history'),
    m.historySlug('.codex/sessions')
  ])
  assert.equal(slugs.size, 4, 'every entry gets its own slug')
})

// --- 5. ensuring twice, with a file written in between, keeps it -----------

test('ensuring the history directory twice preserves a file written in between (no rmTree)', async () => {
  const paths = ['.claude/projects', '.claude/todos']
  await m.ensureSessionHistory(ws, task, sessionId, paths)
  const dir = m.sessionHistoryDir(ws, task, sessionId)
  const slugDir = path.join(dir, m.historySlug(paths[0]))
  assert.ok(fs.existsSync(slugDir))
  const marker = path.join(slugDir, 'session-42.jsonl')
  fs.writeFileSync(marker, '{"hello":"world"}\n')

  await m.ensureSessionHistory(ws, task, sessionId, paths)

  assert.ok(fs.existsSync(marker), 'the file survives a second ensure — no wipe-then-recreate')
  assert.equal(fs.readFileSync(marker, 'utf8'), '{"hello":"world"}\n')
})
