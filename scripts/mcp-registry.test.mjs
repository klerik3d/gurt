// Pure-fs tests for the workspace MCP registry (docs/requirements-mcp-proxy.md
// §3): the shared validator and unified built-in/registry lookup, the
// store.ts mutators over workspace.json, the mcp-token credential policy, and
// the delete rules (a session's selection, a credential's link). No docker, no
// electron — bundles the real TypeScript with esbuild like the rest of the
// suite. Harness style of scripts/env-config.test.mjs.
//
//   node scripts/mcp-registry.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-mcp-registry-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

// gurtRoot is read from GURT_ROOT at module load — set it before the import.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-mcp-registry-'))
process.env.GURT_ROOT = GURT_ROOT
// No keystore outside real Electron: credential writes stay plaintext.
process.env.GURT_FORCE_PLAINTEXT = '1'

await bundle({
  stdin: {
    contents: `
      export {
        MCP_DEFS, RESERVED_MCP_IDS, mcpDef, mcpEntry, mcpEntries, mcpHasModes,
        mcpLabel, normalizeMcpEntry, validateMcpEntry
      } from ${S('src/shared/mcp.ts')}
      export { resolveMcpCredential, mcpCredentials, isGitKind } from ${S('src/shared/credentials.ts')}
      export {
        getWorkspace, createWorkspace, getMcpServers, addMcpServer, updateMcpServer,
        removeMcpServer, tasksUsingMcp, createTask
      } from ${S('src/main/store.ts')}
      export {
        setCredentials, listCredentials, credentialUsedBy, checkMcpCredential
      } from ${S('src/main/credentials.ts')}
    `,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  external: ['electron'],
  outfile
})

const m = await import(pathToFileURL(outfile).href)

const ws = 'ws1'
const wsPath = path.join(GURT_ROOT, ws, 'workspace.json')
const readWs = () => JSON.parse(fs.readFileSync(wsPath, 'utf8'))
const entry = (over = {}) => ({ id: 'linear', url: 'https://mcp.linear.app/mcp', ...over })

after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

// --- the shared validator ---------------------------------------------------

test('validator: ids', () => {
  assert.equal(m.validateMcpEntry(entry()), null, 'a plain http(s) entry is valid')
  assert.match(m.validateMcpEntry(entry({ id: '' })), /must not be empty/)
  assert.match(m.validateMcpEntry(entry({ id: 'My Server' })), /lowercase/)
  assert.match(m.validateMcpEntry(entry({ id: '-lead' })), /lowercase/)
  assert.equal(m.validateMcpEntry(entry({ id: 'docs.internal_v2-1' })), null)
  // Built-in ids are reserved in the validator, not just in the UI (§3.3) —
  // both spaces share the proxy's route namespace. `gurt` is reserved even
  // though it has no McpDef: it is not user-selectable, but it owns the route.
  assert.deepEqual([...m.RESERVED_MCP_IDS].sort(), ['github', 'gurt'])
  for (const id of m.RESERVED_MCP_IDS)
    assert.match(m.validateMcpEntry(entry({ id })), /reserved/, `${id} is reserved`)
  assert.match(
    m.validateMcpEntry(entry({ id: 'taken' }), { takenIds: ['other', 'taken'] }),
    /already used/
  )
  assert.equal(m.validateMcpEntry(entry({ id: 'free' }), { takenIds: ['other'] }), null)
})

test('validator: url must be http(s)', () => {
  assert.match(m.validateMcpEntry(entry({ url: '' })), /must not be empty/)
  assert.match(m.validateMcpEntry(entry({ url: 'mcp.example.com/mcp' })), /not a valid URL/)
  assert.match(m.validateMcpEntry(entry({ url: '/local/path' })), /not a valid URL/)
  // stdio and local processes are out of scope: the transport is HTTP, period.
  assert.match(m.validateMcpEntry(entry({ url: 'stdio:///usr/bin/server' })), /must be http\(s\)/)
  assert.match(m.validateMcpEntry(entry({ url: 'file:///tmp/x' })), /must be http\(s\)/)
  assert.match(m.validateMcpEntry(entry({ url: 'ws://example.com' })), /must be http\(s\)/)
  assert.equal(m.validateMcpEntry(entry({ url: 'http://localhost:3000/mcp' })), null)
})

test('validator: headers', () => {
  assert.equal(m.validateMcpEntry(entry({ headers: [{ name: 'X-Team', value: 'core' }] })), null)
  assert.match(m.validateMcpEntry(entry({ headers: [{ name: '', value: 'v' }] })), /must not be empty/)
  assert.match(m.validateMcpEntry(entry({ headers: [{ name: 'X Team', value: 'v' }] })), /not a valid header name/)
  assert.match(
    m.validateMcpEntry(entry({ headers: [{ name: 'X-A', value: 'a' }, { name: 'x-a', value: 'b' }] })),
    /duplicate header/
  )
  // A newline in a value would inject a second header at the proxy.
  assert.match(
    m.validateMcpEntry(entry({ headers: [{ name: 'X-A', value: 'a\r\nX-Admin: 1' }] })),
    /newline/
  )
})

test('normalizeMcpEntry drops blank optionals', () => {
  const n = m.normalizeMcpEntry({
    id: '  linear  ',
    label: '   ',
    url: ' https://x/mcp ',
    headers: [{ name: ' X-A ', value: 'v' }, { name: '  ', value: 'dropped' }],
    credentialId: ''
  })
  assert.deepEqual(n, { id: 'linear', url: 'https://x/mcp', headers: [{ name: 'X-A', value: 'v' }] })
  assert.equal(m.mcpLabel(n), 'linear', 'an unlabelled entry shows its id')
  assert.equal(m.mcpLabel({ ...n, label: 'Linear' }), 'Linear')
})

// --- one lookup path for both sources (§3.3) --------------------------------

test('mcpEntry resolves built-ins and registry entries alike', () => {
  const registry = [entry(), entry({ id: 'docs', label: 'Docs', url: 'https://docs/mcp' })]
  const ids = m.mcpEntries(registry).map((e) => e.id)
  assert.deepEqual(ids, ['github', 'linear', 'docs'], 'built-ins first, then the registry')

  const builtin = m.mcpEntry('github', registry)
  assert.equal(builtin.source, 'builtin')
  assert.equal(builtin.label, 'github')
  assert.equal(builtin.def, m.mcpDef('github'))
  assert.ok(m.mcpHasModes(builtin), 'gurt knows which of its own tools write')

  const reg = m.mcpEntry('docs', registry)
  assert.equal(reg.source, 'registry')
  assert.equal(reg.label, 'Docs')
  assert.equal(reg.description, 'https://docs/mcp')
  assert.equal(reg.entry.url, 'https://docs/mcp')
  // An upstream's tool semantics are unknown, so it is off or on — never
  // read-only, which would claim an enforcement gurt does not have.
  assert.equal(m.mcpHasModes(reg), false)

  assert.equal(m.mcpEntry('nope', registry), undefined)
  // A hand-edited workspace.json cannot shadow a built-in.
  const shadowed = m.mcpEntry('github', [{ id: 'github', url: 'https://evil/mcp' }])
  assert.equal(shadowed.source, 'builtin')
  assert.equal(m.mcpEntries([{ id: 'github', url: 'https://evil/mcp' }]).length, m.MCP_DEFS.length)
})

// --- the credential policy (§3.2) -------------------------------------------

const creds = [
  { id: 'c-mcp', label: 'linear token', kind: 'mcp-token', hosts: [], data: { secret: 'sk-1' } },
  {
    id: 'c-hdr',
    label: 'api key',
    kind: 'mcp-token',
    hosts: [],
    data: { secret: 'k-2', header: 'X-Api-Key', scheme: '' }
  },
  { id: 'c-agent', label: 'claude', kind: 'agent-token', hosts: [], data: { secret: 'sk-a' } }
]

test('resolveMcpCredential', () => {
  assert.deepEqual(m.resolveMcpCredential(creds, undefined), {}, 'no link ⇒ unauthenticated, no error')
  assert.deepEqual(m.resolveMcpCredential(creds, 'c-mcp'), {
    header: { name: 'Authorization', value: 'Bearer sk-1' }
  })
  // Explicitly empty scheme ⇒ the bare secret (X-Api-Key style).
  assert.deepEqual(m.resolveMcpCredential(creds, 'c-hdr'), {
    header: { name: 'X-Api-Key', value: 'k-2' }
  })
  assert.match(m.resolveMcpCredential(creds, 'gone').error, /no longer exists/)
  assert.match(m.resolveMcpCredential(creds, 'c-agent').error, /is not an MCP token/)
  assert.deepEqual(m.mcpCredentials(creds).map((c) => c.id), ['c-mcp', 'c-hdr'])
  // An mcp-token is not a git transport and must never host-match.
  assert.equal(m.isGitKind('mcp-token'), false)
})

test('a secret that cannot be a header value fails to resolve, and never becomes one', () => {
  // Entries saved before the save-time check existed still exist, so this layer
  // is the one that has to hold. A poisoned value handed to the proxy would
  // throw ERR_INVALID_CHAR inside a request listener — a dead proxy, not a 401.
  const mk = (id, data) => ({ id, label: id, kind: 'mcp-token', hosts: [], data })
  const legacy = [
    mk('c-nl', { secret: 'sk-1\nX-Injected: yes' }),
    mk('c-cr', { secret: 'sk\r-1' }),
    mk('c-nul', { secret: 'sk-1\0' }),
    mk('c-scheme', { secret: 'sk-1', scheme: 'Bear\ner' }),
    mk('c-name', { secret: 'sk-1', header: 'X Api Key' }),
    mk('c-pad', { secret: '  sk-1\n\n' })
  ]
  const expected = {
    'c-nl': /newline/,
    'c-cr': /newline/,
    'c-nul': /NUL/,
    'c-scheme': /newline/,
    'c-name': /not a valid header name/
  }
  for (const id of Object.keys(expected)) {
    const got = m.resolveMcpCredential(legacy, id)
    assert.match(got.error, expected[id], id)
    assert.equal(got.header, undefined, `${id} must resolve to no header at all`)
  }
  // Whitespace around a token is a paste artifact with no meaning — including
  // the line break a terminal copy carries. Trimmed, not refused; a break
  // *inside* a token is the unfixable case, and that is what errors above.
  assert.deepEqual(m.resolveMcpCredential(legacy, 'c-pad'), {
    header: { name: 'Authorization', value: 'Bearer sk-1' }
  })
})

// --- the store (§3.1) -------------------------------------------------------

test('absent mcpServers stays absent', async () => {
  await m.createWorkspace(ws)
  const data = await m.getWorkspace(ws)
  assert.equal(data.mcpServers, undefined, 'getWorkspace tolerates the field being absent')
  assert.deepEqual(await m.getMcpServers(ws), [], 'the list reads as empty')
  assert.equal('mcpServers' in readWs(), false, 'reading does not rewrite the file')
})

test('add / update / remove', async () => {
  await m.addMcpServer(ws, entry({ label: '  Linear  ', headers: [{ name: 'X-Team', value: 'core' }] }))
  assert.deepEqual(readWs().mcpServers, [
    {
      id: 'linear',
      label: 'Linear',
      url: 'https://mcp.linear.app/mcp',
      headers: [{ name: 'X-Team', value: 'core' }]
    }
  ])
  // repos/envs are untouched by an mcp write.
  assert.deepEqual(readWs().repos, [])

  await m.addMcpServer(ws, entry({ id: 'docs', url: 'https://docs.internal/mcp' }))
  assert.deepEqual((await m.getMcpServers(ws)).map((e) => e.id), ['linear', 'docs'])

  await m.updateMcpServer(ws, entry({ id: 'docs', url: 'https://docs.internal/v2/mcp' }))
  assert.equal((await m.getMcpServers(ws)).find((e) => e.id === 'docs').url, 'https://docs.internal/v2/mcp')
  await assert.rejects(
    m.updateMcpServer(ws, entry({ id: 'ghost' })),
    /not found/,
    'update matches by the immutable id'
  )

  await m.removeMcpServer(ws, 'docs')
  assert.deepEqual((await m.getMcpServers(ws)).map((e) => e.id), ['linear'])
  await assert.rejects(m.removeMcpServer(ws, 'docs'), /not found/)
})

test('store rejects what the validator rejects', async () => {
  await assert.rejects(m.addMcpServer(ws, entry({ id: 'github' })), /reserved/)
  await assert.rejects(m.addMcpServer(ws, entry({ id: 'gurt' })), /reserved/)
  await assert.rejects(m.addMcpServer(ws, entry()), /already used/, 'ids are unique per workspace')
  await assert.rejects(m.addMcpServer(ws, entry({ id: 'ftp', url: 'ftp://x/mcp' })), /http\(s\)/)
  await assert.rejects(
    m.updateMcpServer(ws, entry({ headers: [{ name: 'bad name', value: 'v' }] })),
    /header name/
  )
  assert.deepEqual((await m.getMcpServers(ws)).map((e) => e.id), ['linear'], 'nothing was written')
})

test('concurrent adds do not lose each other', async () => {
  await Promise.all([
    m.addMcpServer(ws, entry({ id: 'a', url: 'https://a/mcp' })),
    m.addMcpServer(ws, entry({ id: 'b', url: 'https://b/mcp' })),
    m.addMcpServer(ws, entry({ id: 'c', url: 'https://c/mcp' }))
  ])
  assert.deepEqual((await m.getMcpServers(ws)).map((e) => e.id), ['linear', 'a', 'b', 'c'])
  await Promise.all(['a', 'b', 'c'].map((id) => m.removeMcpServer(ws, id)))
  assert.deepEqual((await m.getMcpServers(ws)).map((e) => e.id), ['linear'])
})

test('a hand-edited file degrades entry by entry', async () => {
  const file = readWs()
  fs.writeFileSync(
    wsPath,
    JSON.stringify({
      ...file,
      mcpServers: [
        { id: 'ok', url: 'https://ok/mcp', label: 42, headers: 'nope' },
        { id: 'no-url' },
        { url: 'https://no-id/mcp' },
        'garbage',
        { id: 'ok', url: 'https://dupe/mcp' },
        { id: 'linked', url: 'https://linked/mcp', credentialId: 'c-mcp', extra: 'kept out' }
      ]
    })
  )
  const servers = await m.getMcpServers(ws)
  assert.deepEqual(servers, [
    { id: 'ok', url: 'https://ok/mcp' },
    { id: 'linked', url: 'https://linked/mcp', credentialId: 'c-mcp' }
  ])
  // A bad field degrades to absent; a record with no id/url, a duplicate id and
  // a non-object are dropped — one bad entry never empties the registry.
  fs.writeFileSync(wsPath, JSON.stringify({ ...file, mcpServers: 'not an array' }))
  assert.deepEqual(await m.getMcpServers(ws), [])
  fs.writeFileSync(wsPath, JSON.stringify(file))
})

test('remove is refused while a session selects the server', async () => {
  await m.createTask(ws, 't1')
  fs.writeFileSync(
    path.join(GURT_ROOT, ws, 't1', 'sessions.json'),
    JSON.stringify([{ info: { id: 's1', mcp: [{ id: 'github', mode: 'full' }, { id: 'linear', mode: 'full' }] } }])
  )
  assert.deepEqual(await m.tasksUsingMcp(ws, 'linear'), ['t1'])
  assert.deepEqual(await m.tasksUsingMcp(ws, 'docs'), [])
  await assert.rejects(m.removeMcpServer(ws, 'linear'), /selected by session\(s\) in task\(s\): t1/)
  // Editing it is still allowed — only the id (the route key) is frozen.
  await m.updateMcpServer(ws, entry({ url: 'https://mcp.linear.app/v2/mcp' }))
  fs.writeFileSync(path.join(GURT_ROOT, ws, 't1', 'sessions.json'), JSON.stringify([]))
  await m.removeMcpServer(ws, 'linear')
  assert.deepEqual(await m.getMcpServers(ws), [])
})

test('a credential link must resolve to an mcp-token', async () => {
  await m.setCredentials({ credentials: creds })
  await m.checkMcpCredential(undefined)
  await m.checkMcpCredential('c-mcp')
  await assert.rejects(m.checkMcpCredential('gone'), /no longer exists/)
  await assert.rejects(m.checkMcpCredential('c-agent'), /is not an MCP token/)

  // A linked entry blocks deleting the credential, exactly as a repo link does.
  await m.addMcpServer(ws, entry({ label: 'Linear', credentialId: 'c-mcp' }))
  assert.deepEqual(await m.credentialUsedBy('c-mcp'), [`mcp "Linear" (${ws})`])
  assert.deepEqual(await m.credentialUsedBy('c-hdr'), [])
  await assert.rejects(
    m.setCredentials({ credentials: creds.filter((c) => c.id !== 'c-mcp') }),
    /is linked by/
  )
  await m.removeMcpServer(ws, 'linear')
  assert.deepEqual(await m.credentialUsedBy('c-mcp'), [])
})

test('an mcp-token secret is checked before it is stored', async () => {
  await m.setCredentials({ credentials: creds })
  const withBad = (data) => ({
    credentials: [...creds, { id: 'c-bad', label: 'pasted', kind: 'mcp-token', hosts: [], data }]
  })
  const ids = async () => (await m.listCredentials()).map((c) => c.id)
  const before = await ids()

  // The paste artifact this exists for: a token copied with its line break.
  await assert.rejects(m.setCredentials(withBad({ secret: 'sk-1\nX-Injected: yes' })), /newline/)
  await assert.rejects(m.setCredentials(withBad({ secret: 'sk\r-1' })), /newline/)
  await assert.rejects(m.setCredentials(withBad({ secret: 'sk\u0000-1' })), /NUL/)
  await assert.rejects(m.setCredentials(withBad({ secret: 'sk\u0001-1' })), /control character/)
  await assert.rejects(
    m.setCredentials(withBad({ secret: 'sk-1', header: 'X Api Key' })),
    /not a valid header name/
  )
  await assert.rejects(m.setCredentials(withBad({ secret: 'sk-1', scheme: 'Bear\ner' })), /scheme/)
  assert.deepEqual(await ids(), before, 'a refused save leaves the store exactly as it was')

  // Padding — the trailing newline of a terminal copy included — is stripped on
  // the way in, so the stored entry is the header it will produce, and nothing
  // downstream has to trim it again to agree.
  await m.setCredentials(withBad({ secret: ' \tsk-good\r\n' }))
  const saved = await m.listCredentials()
  assert.equal(saved.find((c) => c.id === 'c-bad').data.secret, 'sk-good')
  assert.deepEqual(m.resolveMcpCredential(saved, 'c-bad'), {
    header: { name: 'Authorization', value: 'Bearer sk-good' }
  })

  // Other kinds are none of this check's business: an agent token is not a
  // header value, and a git token's secret is nobody's header either.
  await m.setCredentials({
    credentials: [...creds, { id: 'c-a', label: 'a', kind: 'agent-token', hosts: [], data: { secret: 'x\ny' } }]
  })
  await m.setCredentials({ credentials: creds })
})
