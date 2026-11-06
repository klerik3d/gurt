// Agent history mount (docs/requirements-agent-history.md), phase 1: the
// mechanism and claude-code. Pure node, no daemon — everything here is the
// mount-list contract and the host-side directory bookkeeping; the live
// "does a rebuilt container actually resume" check is §9 item 6, out of
// scope for an automated test.
//
// The properties, in the order they matter:
//
//   1. A kind with an empty `historyPaths` (opencode, §3.3) changes nothing:
//      same mount list, no link exec.
//   2. A kind with entries (claude-code) adds exactly ONE read-write
//      `hostMounts` entry targeting `/gurt/history`, regardless of how many
//      entries `historyPaths` has, plus one link per entry.
//   3. A plain single-repo executor on claude-code gets the history bind in
//      its `containerLayout` (read-write, at /gurt/history) next to its clone
//      — and none on a kind without history.
//   4. The mount is never `readonly`, and slugs from different agent homes
//      do not collide.
//   5. Ensuring the history directory twice, with a file written in
//      between, keeps the file — the `rmTree` skills has that history must
//      not (§4 step 2).
//
//   node scripts/session-history-mount.test.mjs
import { test, after, beforeEach } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { installFakeDocker } from './lib/fake-docker.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-history-mount-'))
process.env.GURT_ROOT = path.join(tmp, 'gurt')

const fake = installFakeDocker(tmp)

const outfile = path.join(tmp, 'entry.mjs')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await bundle({
  stdin: {
    contents: `
      export { AGENT_MANIFESTS as AGENT_DEFS, agentDef } from ${S('src/shared/agents.ts')}
      export {
        usesSkillMounts, usesHistoryMounts, historyHostMounts, containerLayout
      } from ${S('src/main/containers.ts')}
      export { HISTORY_MOUNT, linkContainerHistory } from ${S('src/main/provision.ts')}
      export {
        historySlug, ensureSessionHistory, sessionHistoryDir, sessionScratchDir
      } from ${S('src/main/store.ts')}
    `,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  external: ['electron'],
  outfile
})

const m = await import(pathToFileURL(outfile).href)
beforeEach(() => fake.reset())

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const T = { containerId: 'cid-h', user: 'dev', cwd: '/workspaces/repo', path: '/p/bin' }

const ws = 'w'
const task = 't'
const sessionId = 's1'

/** Minimal `SessionInfo`, the shape `containerLayout` reads. */
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

  const clone = [{ name: 'alpha', dir: '/h/alpha' }]
  const layout = m.containerLayout(info('executor', ['alpha']), clone, false, m.historyHostMounts(ws, task, sessionId, opencode.historyPaths))
  assert.deepEqual(layout.mounts.map((x) => x.target), ['/workspaces/alpha'], 'the clone, nothing else')

  const log = []
  await m.linkContainerHistory(T, sessionId, 'opencode', opencode.historyPaths, (l) => log.push(l))
  assert.deepEqual(fake.calls(), [], 'no exec was run for an empty historyPaths')
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
  await m.linkContainerHistory(T, sessionId, 'claude-code', claude.historyPaths, (l) => log.push(l))
  const calls = fake.execs()
  assert.equal(calls.length, claude.historyPaths.length, 'one exec per entry')
  for (const [i, entry] of claude.historyPaths.entries()) {
    const e = calls[i]
    assert.equal(e.id, 'cid-h')
    assert.equal(e.user, 'dev')
    assert.equal(e.cwd, '/workspaces/repo')
    const script = e.cmd.at(-1)
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
  fake.ctl({ exec: [{ match: 'ln -s', codes: [1] }] })
  const log = []
  await m.linkContainerHistory(T, sessionId, 'claude-code', ['.claude/projects'], (l) => log.push(l))
  assert.ok(log.some((l) => l.includes('could not link') && l.includes('.claude/projects')), JSON.stringify(log))
})

// --- 3. §4.1 regression: a plain single-repo executor on claude-code -------

test('a plain single-repo executor on claude-code gets the history bind beside its clone; on opencode it does not', () => {
  const claude = m.agentDef('claude-code')
  const clone = [{ name: 'alpha', dir: '/h/alpha' }]
  const plain = info('executor', ['alpha'])
  const withHistory = m.containerLayout(plain, clone, false, m.historyHostMounts(ws, task, sessionId, claude.historyPaths))
  assert.deepEqual(withHistory.mounts, [
    { type: 'bind', source: '/h/alpha', target: '/workspaces/alpha' },
    { type: 'bind', source: m.sessionHistoryDir(ws, task, sessionId), target: m.HISTORY_MOUNT }
  ])
  const opencode = m.agentDef('opencode')
  const without = m.containerLayout(plain, clone, false, m.historyHostMounts(ws, task, sessionId, opencode.historyPaths))
  assert.equal(without.mounts.length, 1)
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
