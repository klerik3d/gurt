// Per-session MCP selection across both sources (docs/requirements-mcp-proxy.md
// §3.3): the user picks from gurt's built-ins *and* the workspace's registry,
// the picks are the session's record, and that record is what every scope
// builder reads.
//
// Three properties, in the order they matter:
//
//   1. The selection is persisted and restored verbatim, registry ids included —
//      it is what the user chose, not a cache of what happened to resolve.
//   2. An id that stops resolving (a registry entry deleted behind the session)
//      is *kept* and reported, never silently dropped: the difference between
//      "not selected" and "selected, unavailable" is the whole point.
//   3. Both scope builders agree on the selection — the proxy plan routes both
//      sources, and the host-server path serves the built-ins and leaves the
//      rest alone (a registry server is a remote URL; there is no host server to
//      start for it).
//
// No docker and no agent: every session here stays a draft. The host MCP
// servers are real, though — that is how "narrowing the selection stops what it
// dropped" is checked.
//
//   node scripts/mcp-selection.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import net from 'node:net'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-mcp-selection-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

// store.ts reads GURT_ROOT at module load — set it before the import.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-mcp-selection-'))
process.env.GURT_ROOT = GURT_ROOT
// No keystore outside real Electron: credential writes stay plaintext.
process.env.GURT_FORCE_PLAINTEXT = '1'

await bundle({
  stdin: {
    contents: `
      export { createKernel } from ${S('src/main/kernel.ts')}
      export { mcpEntries, mcpHasModes, resolveMcpSelection } from ${S('src/shared/mcp.ts')}
      export { planProxy, resolveProxyPlan } from ${S('src/main/proxy/config.ts')}
      export { resolveMcpServers, stopMcpServers } from ${S('src/main/mcp/manager.ts')}
      export { addMcpServer, getMcpServers, readSessions } from ${S('src/main/store.ts')}
    `,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  external: ['electron'],
  outfile
})

const m = await import(pathToFileURL(outfile).href)

const ws = 'w'
const task = 't'
const ref = { workspace: ws, task, env: 'dev' }
const workspaceFile = path.join(GURT_ROOT, ws, 'workspace.json')

fs.mkdirSync(path.join(GURT_ROOT, ws, task), { recursive: true })
fs.writeFileSync(
  workspaceFile,
  JSON.stringify({
    repos: [{ name: 'alpha', url: 'https://github.com/o/alpha.git' }],
    envs: [{ name: 'dev', devcontainer: '{"image":"x"}', repo: 'alpha' }]
  })
)
fs.writeFileSync(path.join(GURT_ROOT, ws, task, 'task.json'), JSON.stringify({}))
fs.writeFileSync(path.join(GURT_ROOT, ws, 'agents.json'), JSON.stringify({}))

await m.addMcpServer(ws, { id: 'linear', label: 'Linear', url: 'https://mcp.linear.app/mcp' })
await m.addMcpServer(ws, { id: 'docs', url: 'https://docs.internal/mcp' })

const kernel = m.createKernel()

after(() => {
  m.stopMcpServers(session?.id ?? '')
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

/** The persisted record of a session, straight off disk. */
const persisted = async (id) =>
  (await m.readSessions(ws, task)).find((r) => r.info.id === id)?.info

/** sessions.json is written on a 300ms debounce. */
const flushed = () => new Promise((r) => setTimeout(r, 400))

/** Port out of a host MCP descriptor (`http://host.docker.internal:PORT/mcp/…`). */
const portOf = (descriptor) => Number(new URL(descriptor.url).port)

/** Whether anything still answers on `port` — how a stopped server is told from
 *  a running one without reaching into the manager's private map. */
const listening = (port) =>
  new Promise((resolve) => {
    const sock = net
      .connect(port, '127.0.0.1')
      .on('connect', () => {
        sock.destroy()
        resolve(true)
      })
      .on('error', () => resolve(false))
  })

let session

// --- what the picker is offered -----------------------------------------

test('the picker is offered both sources, and only built-ins carry modes', async () => {
  const entries = m.mcpEntries(await m.getMcpServers(ws))
  assert.deepEqual(
    entries.map((e) => [e.source, e.id, e.label]),
    [
      ['builtin', 'github', 'github'],
      ['registry', 'linear', 'Linear'],
      // No label in the registry entry — the id stands in for one.
      ['registry', 'docs', 'docs']
    ]
  )
  assert.deepEqual(
    entries.map(m.mcpHasModes),
    [true, false, false],
    'read-only/full is gurt claiming to know which tools write — true of its own servers only'
  )
})

test('the renderer may supply the built-ins it was told about', () => {
  // `getMcpDefs` is main's answer, not this module's constant: the picker must
  // be able to build the union out of what it was handed.
  const defs = [{ id: 'github', label: 'github', description: 'd', tools: [] }]
  const entries = m.mcpEntries([{ id: 'linear', url: 'https://mcp.linear.app/mcp' }], defs)
  assert.deepEqual(
    entries.map((e) => e.id),
    ['github', 'linear']
  )
  // Reserved ids stay reserved whatever the caller passes, so a hand-edited
  // workspace.json cannot shadow a gurt server by naming itself after one.
  assert.deepEqual(
    m.mcpEntries([{ id: 'gurt', url: 'https://evil.example/mcp' }], defs).map((e) => e.id),
    ['github']
  )
})

// --- resolving a selection against what is offered now -------------------

test('a selection resolves in the user’s order, deduplicated, orphans kept', async () => {
  const entries = m.mcpEntries(await m.getMcpServers(ws))
  const resolved = m.resolveMcpSelection(
    [
      { id: 'linear', mode: 'full' },
      { id: 'github', mode: 'read-only' },
      { id: 'linear', mode: 'read-only' },
      { id: 'ghost', mode: 'full' }
    ],
    entries
  )
  assert.deepEqual(
    resolved.map((r) => [r.selection.id, r.selection.mode, r.entry?.source]),
    [
      ['linear', 'full', 'registry'],
      ['github', 'read-only', 'builtin'],
      // The second `linear` is gone, and the first — the user's — decided the mode.
      ['ghost', 'full', undefined]
    ]
  )
})

// --- persistence ---------------------------------------------------------

test('a mixed selection is persisted verbatim', async () => {
  session = kernel.sessions.createSession(
    ref,
    ['alpha'],
    'a1',
    'do the thing',
    'draft',
    [
      { id: 'github', mode: 'read-only' },
      { id: 'linear', mode: 'full' }
    ],
    true,
    false,
    {},
    'executor'
  )
  await flushed()
  assert.deepEqual((await persisted(session.id)).mcp, [
    { id: 'github', mode: 'read-only' },
    // A registry entry is off or on; on is recorded as `full` so the selection
    // keeps one shape (§3.3).
    { id: 'linear', mode: 'full' }
  ])
})

test('editing the draft rewrites the selection', async () => {
  kernel.sessions.editDraft(session.id, {
    mcp: [
      { id: 'linear', mode: 'full' },
      { id: 'docs', mode: 'full' }
    ]
  })
  await flushed()
  assert.deepEqual((await persisted(session.id)).mcp, [
    { id: 'linear', mode: 'full' },
    { id: 'docs', mode: 'full' }
  ])
  assert.deepEqual(kernel.sessions.sessionInfo(session.id).mcp, [
    { id: 'linear', mode: 'full' },
    { id: 'docs', mode: 'full' }
  ])
})

test('a duplicate carries the whole selection, both sources', () => {
  const copy = kernel.sessions.duplicateSession(session.id)
  assert.deepEqual(copy.mcp, [
    { id: 'linear', mode: 'full' },
    { id: 'docs', mode: 'full' }
  ])
  // Copied, not shared: editing one draft's picks must not move the other's.
  kernel.sessions.editDraft(copy.id, { mcp: [] })
  assert.equal(kernel.sessions.sessionInfo(session.id).mcp.length, 2)
})

test('a restart restores the selection, registry ids and all', async () => {
  kernel.sessions.editDraft(session.id, {
    mcp: [
      { id: 'github', mode: 'read-only' },
      { id: 'linear', mode: 'full' }
    ]
  })
  await flushed()
  const next = m.createKernel()
  await next.ready
  assert.deepEqual(next.sessions.sessionInfo(session.id).mcp, [
    { id: 'github', mode: 'read-only' },
    { id: 'linear', mode: 'full' }
  ])
})

// --- scope resolution ----------------------------------------------------

const HOST_MCP = 'http://host.docker.internal:5555/mcp/host-token'

test('the proxy plan routes both sources from the one selection', async () => {
  const plan = await m.resolveProxyPlan(ref, session.id, 'tok', kernel.sessions.sessionInfo(session.id).mcp, {
    hostMcpUrl: HOST_MCP
  })
  assert.deepEqual(plan.errors, [])
  assert.equal(plan.config.mcp.github.kind, 'host')
  assert.equal(plan.config.mcp.linear.kind, 'registry')
  assert.equal(plan.config.mcp.linear.url, 'https://mcp.linear.app/mcp')
  // Not selected, so not in scope — and `gurt` is in it either way.
  assert.deepEqual(Object.keys(plan.config.mcp).sort(), ['github', 'gurt', 'linear'])
  assert.deepEqual(
    plan.mcpServers.map((s) => s.name),
    ['github', 'linear', 'gurt']
  )
})

test('the host path serves the built-ins and leaves the registry alone', async () => {
  const servers = await m.resolveMcpServers(ref, session.id, 'alpha', [
    { id: 'github', mode: 'read-only' },
    { id: 'linear', mode: 'full' }
  ])
  assert.deepEqual(
    servers.map((s) => s.name),
    ['github'],
    'a registry entry is a remote URL reached through the proxy — there is no host server to start'
  )
  assert.ok(await listening(portOf(servers[0])))
})

test('a mode change restarts the server; narrowing the selection stops it', async () => {
  const [readOnly] = await m.resolveMcpServers(ref, session.id, 'alpha', [
    { id: 'github', mode: 'read-only' }
  ])
  const [full] = await m.resolveMcpServers(ref, session.id, 'alpha', [
    { id: 'github', mode: 'full' }
  ])
  assert.notEqual(portOf(full), portOf(readOnly), 'the granted mode is baked into the tool set')
  assert.equal(await listening(portOf(readOnly)), false)

  assert.deepEqual(await m.resolveMcpServers(ref, session.id, 'alpha', []), [])
  assert.equal(
    await listening(portOf(full)),
    false,
    'a dropped selection must revoke the server, not just stop naming it'
  )
})

// --- an id that stopped resolving ---------------------------------------

test('a registry entry deleted behind the session is kept, and reported', async () => {
  // Hand-edited out — `removeMcpServer` refuses while a session selects it
  // (covered in mcp-registry.test.mjs), which is exactly why the *other* ways it
  // can happen have to degrade rather than throw.
  const data = JSON.parse(fs.readFileSync(workspaceFile, 'utf8'))
  data.mcpServers = data.mcpServers.filter((e) => e.id !== 'linear')
  fs.writeFileSync(workspaceFile, JSON.stringify(data))

  const selection = kernel.sessions.sessionInfo(session.id).mcp
  assert.deepEqual(selection, [
    { id: 'github', mode: 'read-only' },
    { id: 'linear', mode: 'full' }
  ])

  // The picker still lists it, as an id and nothing more.
  const resolved = m.resolveMcpSelection(selection, m.mcpEntries(await m.getMcpServers(ws)))
  assert.equal(resolved[1].entry, undefined)

  // The scope drops it — with a reason, and without taking the rest down.
  const plan = m.planProxy({
    sessionId: session.id,
    token: 'tok',
    selection,
    registry: await m.getMcpServers(ws),
    hostMcpUrl: HOST_MCP
  })
  assert.deepEqual(Object.keys(plan.config.mcp).sort(), ['github', 'gurt'])
  assert.match(plan.errors.join('\n'), /"linear" is not a built-in and is not in this workspace/)

  // And the host path, which never served it, is unbothered.
  assert.deepEqual(
    (await m.resolveMcpServers(ref, session.id, 'alpha', selection)).map((s) => s.name),
    ['github']
  )
})
