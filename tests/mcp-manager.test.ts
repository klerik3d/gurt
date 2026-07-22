// Pure-node test for the host MCP server manager: which servers start for a
// session's selection, the ACP descriptor handed to the container, idempotent
// resolve, mode-change restart, and per-session teardown. The per-repo github
// server is stubbed with a plain http server that echoes its build args, so
// every URL can be probed over real HTTP without git/credentials; the store
// (task.json → env instance → repo) is the real one under a temp GURT_ROOT.
import { afterAll, it, vi } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EnvRef } from '../src/shared/types'

// GURT_ROOT must be set before the store module loads (read at import time).
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-mcpmgr-'))
process.env.GURT_ROOT = GURT_ROOT

/** Every buildGithubHttpServer call the manager made, in order. */
const state = vi.hoisted(() => ({
  builds: [] as { session: string; repo: string; dir: string; mode: string; token: string }[]
}))
vi.mock('../src/main/mcp/githubServer', async () => {
  const { createServer } = await import('node:http')
  return {
    buildGithubHttpServer: (
      ref: EnvRef,
      repo: string,
      dir: string,
      mode: string,
      token: string
    ) => {
      state.builds.push({ session: ref.session, repo, dir, mode, token })
      return createServer((req, res) => {
        // connection: close — no keep-alive sockets, so a closed server is
        // observably down on the next fetch.
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
        res.end(JSON.stringify({ token, mode, url: req.url }))
      })
    }
  }
})

const { resolveMcpServers, stopMcpServers } = await import('../src/main/mcp/manager')
const { cloneDir } = await import('../src/main/store')

// --- fixtures: a task with per-session env instances ------------------------

const ws = 'w'
const task = 't'
fs.mkdirSync(path.join(GURT_ROOT, ws, task), { recursive: true })
fs.writeFileSync(path.join(GURT_ROOT, ws, 'workspace.json'), JSON.stringify({ repos: [] }))
fs.writeFileSync(
  path.join(GURT_ROOT, ws, task, 'task.json'),
  JSON.stringify({
    envs: [
      { session: 's1', env: 'dev', repo: 'alpha', status: 'running' },
      { session: 's2', env: 'dev', repo: 'alpha', status: 'running' },
      { session: 's3', env: 'dev', status: 'stopped' } // provisioned repo not stamped yet
    ]
  })
)

const mkRef = (session: string): EnvRef => ({ workspace: ws, task, env: 'dev', session })
const ref1 = mkRef('s1')
const ref2 = mkRef('s2')

afterAll(() => {
  for (const s of ['s1', 's2', 's3', 'ghost']) stopMcpServers(mkRef(s))
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

/** The descriptor URL targets host.docker.internal; probe it from the host. */
const localUrl = (u: string) => u.replace('host.docker.internal', '127.0.0.1')
async function probe(u: string): Promise<{ token: string; mode: string; url: string }> {
  const res = await fetch(localUrl(u))
  return res.json() as Promise<{ token: string; mode: string; url: string }>
}

// --- resolve: decision logic -------------------------------------------------

it('empty or missing selection: no servers started, empty descriptor list', async () => {
  assert.deepEqual(await resolveMcpServers(ref1, undefined), [])
  assert.deepEqual(await resolveMcpServers(ref1, []), [])
  assert.equal(state.builds.length, 0)
})

it('unknown mcp ids are skipped — only registry entries can start', async () => {
  assert.deepEqual(await resolveMcpServers(ref1, [{ id: 'jira', mode: 'full' }]), [])
  assert.equal(state.builds.length, 0)
})

it('no provisioned repo on the session instance (or unknown session): no servers', async () => {
  const sel = [{ id: 'github', mode: 'full' as const }]
  assert.deepEqual(await resolveMcpServers(mkRef('s3'), sel), [], 'instance without a repo')
  assert.deepEqual(await resolveMcpServers(mkRef('ghost'), sel), [], 'session not in task.json')
  assert.equal(state.builds.length, 0)
})

// --- resolve: start + descriptor shape ---------------------------------------

it('starts the github server on the instance clone and returns the container descriptor', async () => {
  const out = await resolveMcpServers(ref1, [{ id: 'github', mode: 'read-only' }])
  assert.equal(out.length, 1)
  const d = out[0]
  assert.equal(d.type, 'http')
  assert.equal(d.name, 'github')
  assert.deepEqual(d.headers, [])
  assert.match(
    d.url,
    /^http:\/\/host\.docker\.internal:\d+\/mcp\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'container-reachable URL with a uuid token'
  )
  assert.equal(state.builds.length, 1)
  const b = state.builds[0]
  assert.equal(b.session, 's1', 'built for the owning session instance')
  assert.equal(b.repo, 'alpha', 'repo comes from the instance record')
  assert.equal(b.dir, cloneDir(ws, task, 'alpha'), 'serves the instance clone dir')
  assert.equal(b.mode, 'read-only')
  assert.ok(d.url.endsWith(`/mcp/${b.token}`), 'the URL carries the token given to the server')
  // the URL is live and routes to exactly that server
  const body = await probe(d.url)
  assert.equal(body.token, b.token)
  assert.equal(body.url, `/mcp/${b.token}`)
})

it('resolve is idempotent: same selection reuses the running server', async () => {
  const first = (await resolveMcpServers(ref1, [{ id: 'github', mode: 'read-only' }]))[0]
  const again = (await resolveMcpServers(ref1, [{ id: 'github', mode: 'read-only' }]))[0]
  assert.deepEqual(again, first, 'same descriptor (URL, port, token)')
  assert.equal(state.builds.length, 1, 'no second server was built')
})

it('a mode change restarts the server: new port + token, old endpoint dead', async () => {
  const old = (await resolveMcpServers(ref1, [{ id: 'github', mode: 'read-only' }]))[0]
  const now = (await resolveMcpServers(ref1, [{ id: 'github', mode: 'full' }]))[0]
  assert.notEqual(now.url, old.url, 'the descriptor changed')
  assert.equal(state.builds.length, 2)
  assert.equal(state.builds[1].mode, 'full', 'rebuilt with the granted mode')
  assert.notEqual(state.builds[1].token, state.builds[0].token, 'fresh token')
  assert.equal((await probe(now.url)).mode, 'full')
  await assert.rejects(fetch(localUrl(old.url)), 'the old server no longer listens')
})

// --- per-session isolation + teardown ----------------------------------------

it('each session instance gets its own server; stop tears down only its own', async () => {
  const d1 = (await resolveMcpServers(ref1, [{ id: 'github', mode: 'full' }]))[0]
  const d2 = (await resolveMcpServers(ref2, [{ id: 'github', mode: 'full' }]))[0]
  assert.notEqual(d2.url, d1.url, 'two sessions on the same repo run separate servers')
  assert.equal(state.builds[state.builds.length - 1].session, 's2')

  stopMcpServers(ref2)
  await assert.rejects(fetch(localUrl(d2.url)), 's2 server is down after stop')
  assert.equal((await probe(d1.url)).token, state.builds[1].token, 's1 server survived')
})

it('resolve after stop starts a fresh server', async () => {
  const before = (await resolveMcpServers(ref1, [{ id: 'github', mode: 'full' }]))[0]
  stopMcpServers(ref1)
  await assert.rejects(fetch(localUrl(before.url)))
  const builds = state.builds.length
  const fresh = (await resolveMcpServers(ref1, [{ id: 'github', mode: 'full' }]))[0]
  assert.equal(state.builds.length, builds + 1, 'a new server was built')
  assert.notEqual(fresh.url, before.url)
  assert.equal((await probe(fresh.url)).token, state.builds[builds].token)
})
