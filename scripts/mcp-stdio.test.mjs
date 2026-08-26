// Local (stdio) MCP servers — docs/requirements-mcp-stdio.md.
//
// Four things, in the order the feature is used:
//
//   1. **Pasting.** `parseMcpSnippet` is how a registry entry is actually
//      going to be created: the whole ecosystem publishes itself as
//      `{"command":"npx","args":["-y","pkg@latest"]}` and the user has that in
//      the clipboard. It is pure, so it is where the density of the tests goes.
//   2. **Validation, per kind**, and the compatibility promise underneath it:
//      an entry with no `kind` is an http entry, and every `workspace.json`
//      written before this change reads unchanged.
//   3. **Routing.** A local entry is a `host` upstream and a remote one is a
//      `registry` upstream — the difference that keeps `gurt-proxy.mjs`
//      untouched (§4.4).
//   4. **Lifecycle.** The refcount is computed from the live sessions, never
//      stored (§6), and the JSON-RPC framing the bridge speaks is exercised
//      against two fake streams rather than a real child process.
//
// No docker, no electron, no spawned server.
//
//   node scripts/mcp-stdio.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-mcp-stdio-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

// store.ts reads GURT_ROOT at module load — set it before the import.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-mcp-stdio-'))
process.env.GURT_ROOT = GURT_ROOT
// No keystore outside real Electron: credential writes stay plaintext.
process.env.GURT_FORCE_PLAINTEXT = '1'

await bundle({
  stdin: {
    contents: `
      export {
        parseMcpSnippet, validateMcpEntry, normalizeMcpEntry, mcpEntries, mcpEntry,
        mcpEntryDetail, mcpEntryKind, mcpHasModes, mcpIdFromName, isLocalMcpEntry,
        isHttpMcpEntry, npmPackageSpec, splitPackageSpec, LOCAL_MCP_NOTICE
      } from ${S('src/shared/mcp.ts')}
      export { resolveMcpEnvSecret } from ${S('src/shared/credentials.ts')}
      export { planProxy } from ${S('src/main/proxy/config.ts')}
      export { localMcpWants, localMcpSpec } from ${S('src/main/mcp/manager.ts')}
      export {
        stdioFramer, encodeStdioMessage, isJsonRpcRequest, resolveHostCommand, hostPath,
        checkMcpCommand, mcpInstallDir, startStdioBridge
      } from ${S('src/main/mcp/stdioBridge.ts')}
      export { addMcpServer, getMcpServers, createWorkspace } from ${S('src/main/store.ts')}
    `,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  external: ['electron'],
  outfile
})

const m = await import(pathToFileURL(outfile).href)

after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

/** The entry a snippet produces, or the assertion failure that it did not. */
const parsed = (snippet) => {
  const r = m.parseMcpSnippet(snippet)
  assert.equal(r.error, undefined, `unexpected error: ${r.error}`)
  return r.entry
}

/** The error a snippet produces, or the assertion failure that it did not. */
const rejected = (snippet) => {
  const r = m.parseMcpSnippet(snippet)
  assert.equal(r.entry, undefined, `expected an error, got ${JSON.stringify(r.entry)}`)
  assert.ok(r.error, 'an error must say something')
  return r.error
}

// --- pasting a published snippet (§5) ---------------------------------------

test('the canonical npx snippet becomes an npm entry', () => {
  assert.deepEqual(
    parsed({
      mcpServers: {
        kubernetes: { command: 'npx', args: ['-y', 'kubernetes-mcp-server@latest', '--read-only'] }
      }
    }),
    {
      kind: 'npm',
      id: 'kubernetes',
      package: 'kubernetes-mcp-server',
      version: 'latest',
      args: ['--read-only']
    }
  )
})

test('npx without -y, and a package with no version', () => {
  // The `-y` is a convenience of the snippet, not part of what runs: gurt
  // installs the package itself, so its presence or absence changes nothing.
  assert.deepEqual(parsed({ docs: { command: 'npx', args: ['some-mcp'] } }), {
    kind: 'npm',
    id: 'docs',
    package: 'some-mcp'
  })
  assert.deepEqual(parsed({ docs: { command: 'npx', args: ['-y', 'some-mcp'] } }), {
    kind: 'npm',
    id: 'docs',
    package: 'some-mcp'
  })
  assert.deepEqual(parsed({ docs: { command: 'npx', args: ['--yes', 'some-mcp@2.1.0'] } }), {
    kind: 'npm',
    id: 'docs',
    package: 'some-mcp',
    version: '2.1.0'
  })
})

test('a scoped package keeps its scope and splits only a real version', () => {
  assert.deepEqual(m.splitPackageSpec('@modelcontextprotocol/server-filesystem'), {
    name: '@modelcontextprotocol/server-filesystem',
    version: ''
  })
  assert.deepEqual(m.splitPackageSpec('@scope/pkg@1.2.3'), { name: '@scope/pkg', version: '1.2.3' })
  assert.deepEqual(m.splitPackageSpec('pkg'), { name: 'pkg', version: '' })

  const entry = parsed({
    mcpServers: {
      filesystem: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem@0.6.2', '/srv/data']
      }
    }
  })
  assert.deepEqual(entry, {
    kind: 'npm',
    id: 'filesystem',
    package: '@modelcontextprotocol/server-filesystem',
    version: '0.6.2',
    args: ['/srv/data']
  })
})

test('anything that is not npx is a command entry, verbatim', () => {
  // uvx, docker, node, a shell script: gurt has no installer for these and does
  // not pretend to — it runs exactly what the snippet says.
  assert.deepEqual(
    parsed({ git: { command: 'uvx', args: ['mcp-server-git', '--repository', '/w/r'] } }),
    { kind: 'command', id: 'git', command: 'uvx', args: ['mcp-server-git', '--repository', '/w/r'] }
  )
  assert.deepEqual(
    parsed({
      mcpServers: {
        gh: { command: 'docker', args: ['run', '-i', 'ghcr.io/x/mcp'], env: { TOKEN: 'set-me' } }
      }
    }),
    {
      kind: 'command',
      id: 'gh',
      command: 'docker',
      args: ['run', '-i', 'ghcr.io/x/mcp'],
      env: { TOKEN: 'set-me' }
    }
  )
})

test('an npx invocation gurt cannot read is an error, not a guess', () => {
  // The package is what gurt installs; getting it wrong would install and run
  // the wrong thing, so a flag it does not recognise stops the paste.
  assert.match(
    rejected({ x: { command: 'npx', args: ['-y'] } }),
    /could not tell which package/
  )
  assert.match(
    rejected({ x: { command: 'npx', args: ['-p', 'pkg', '-c', 'thing'] } }),
    /could not tell which package/
  )
})

test('a remote snippet stays a remote entry, headers and all', () => {
  assert.deepEqual(
    parsed({
      mcpServers: {
        linear: { url: 'https://mcp.linear.app/mcp', headers: { 'X-Team': 'core' } }
      }
    }),
    { id: 'linear', url: 'https://mcp.linear.app/mcp', headers: [{ name: 'X-Team', value: 'core' }] }
  )
  assert.equal(m.mcpEntryKind(parsed({ linear: { url: 'https://x/mcp' } })), 'http')
})

test('the wrappers the ecosystem ships, and a body with no wrapper at all', () => {
  const want = { kind: 'npm', id: 'docs', package: 'some-mcp' }
  assert.deepEqual(parsed({ mcpServers: { docs: { command: 'npx', args: ['some-mcp'] } } }), want)
  // VS Code's mcp.json calls the map `servers`.
  assert.deepEqual(parsed({ servers: { docs: { command: 'npx', args: ['some-mcp'] } } }), want)
  assert.deepEqual(parsed({ docs: { command: 'npx', args: ['some-mcp'] } }), want)
  // No id anywhere: derived from the package, which is the name the user knows.
  assert.deepEqual(parsed({ command: 'npx', args: ['-y', 'some-mcp@1'] }), {
    kind: 'npm',
    id: 'some-mcp',
    package: 'some-mcp',
    version: '1'
  })
  // A bare remote body falls back to the endpoint's host.
  assert.deepEqual(parsed({ url: 'https://mcp.linear.app/mcp' }), {
    id: 'mcp.linear.app',
    url: 'https://mcp.linear.app/mcp'
  })
})

test('a snippet is accepted as text as well as as an object', () => {
  assert.deepEqual(parsed('{"mcpServers":{"docs":{"command":"npx","args":["some-mcp"]}}}'), {
    kind: 'npm',
    id: 'docs',
    package: 'some-mcp'
  })
  assert.match(rejected('{not json'), /not valid JSON/)
  assert.match(rejected('   '), /paste a server snippet/)
})

test('an id that is not an id is squeezed into one', () => {
  assert.equal(m.mcpIdFromName('Kubernetes MCP'), 'kubernetes-mcp')
  assert.equal(m.mcpIdFromName('@scope/pkg'), 'scope-pkg')
  assert.equal(m.mcpIdFromName('__weird__'), 'weird')
  assert.equal(m.mcpIdFromName('   '), '')
  assert.equal(parsed({ 'My Docs Server': { command: 'npx', args: ['x'] } }).id, 'my-docs-server')
})

test('garbage is refused with a sentence, never half-parsed', () => {
  assert.match(rejected(42), /a snippet is a JSON object/)
  assert.match(rejected([]), /a snippet is a JSON object/)
  assert.match(rejected({}), /names no server/)
  assert.match(rejected({ mcpServers: {} }), /names no server/)
  assert.match(rejected({ a: { command: 'x' }, b: { command: 'y' } }), /names 2 servers \(a, b\)/)
  assert.match(rejected({ docs: 'not an object' }), /\{"<id>": \{…\}\}/)
  assert.match(rejected({ mcpServers: { docs: 'not an object' } }), /is not an object/)
  assert.match(rejected({ docs: { label: 'nothing runnable' } }), /needs "url" .* or "command"/)
  assert.match(rejected({ docs: { url: 'https://x/mcp', command: 'npx' } }), /never both/)
  assert.match(rejected({ docs: { command: 'x', args: 'not-an-array' } }), /"args" must be an array/)
  assert.match(rejected({ docs: { command: 'x', args: [1, 2] } }), /"args" must be an array/)
  assert.match(rejected({ docs: { command: 'x', env: { A: 5 } } }), /env "A" must be a string/)
  assert.match(rejected({ docs: { url: 'https://x/mcp', headers: { A: 5 } } }), /header "A" must be a string/)
  // The store's own rules apply at the paste, not one save later.
  assert.match(rejected({ github: { command: 'npx', args: ['x'] } }), /reserved by a built-in/)
  assert.match(rejected({ docs: { url: 'ftp://x/mcp' } }), /must be http\(s\)/)
})

// --- validation, per kind (§3.2) --------------------------------------------

test('validator: an npm entry needs a package, and a version of its own', () => {
  const ok = { kind: 'npm', id: 'k8s', package: 'kubernetes-mcp-server' }
  assert.equal(m.validateMcpEntry(ok), null)
  assert.equal(m.validateMcpEntry({ ...ok, version: '1.2.3', args: ['--read-only'] }), null)
  assert.match(m.validateMcpEntry({ kind: 'npm', id: 'k8s', package: '' }), /package must not be empty/)
  assert.match(m.validateMcpEntry({ ...ok, package: 'a b' }), /must not contain whitespace/)
  // The version is its own field because it is what the reinstall check reads.
  assert.match(m.validateMcpEntry({ ...ok, package: 'pkg@1.2.3' }), /must not carry a version/)
  // A scope's leading @ is part of the name, not a version.
  assert.equal(m.validateMcpEntry({ ...ok, package: '@scope/pkg' }), null)
  assert.match(m.validateMcpEntry({ ...ok, args: 'nope' }), /args must be an array/)
  assert.match(m.validateMcpEntry({ ...ok, args: ['a\0b'] }), /NUL byte/)
})

test('validator: a command entry needs a command', () => {
  const ok = { kind: 'command', id: 'git', command: 'uvx' }
  assert.equal(m.validateMcpEntry(ok), null)
  assert.equal(m.validateMcpEntry({ ...ok, args: ['mcp-server-git'], cwd: '/w' }), null)
  assert.match(m.validateMcpEntry({ kind: 'command', id: 'git', command: '  ' }), /command must not be empty/)
})

test('validator: env names, and the credential a local entry has nowhere to put', () => {
  const ok = { kind: 'npm', id: 'k8s', package: 'p' }
  assert.equal(m.validateMcpEntry({ ...ok, env: { KUBECONFIG: '/home/u/.kube/config' } }), null)
  assert.equal(m.validateMcpEntry({ ...ok, env: { _A1: 'v' } }), null)
  assert.match(m.validateMcpEntry({ ...ok, env: { '1BAD': 'v' } }), /not a valid environment variable name/)
  assert.match(m.validateMcpEntry({ ...ok, env: { 'A-B': 'v' } }), /not a valid environment variable name/)
  assert.match(m.validateMcpEntry({ ...ok, env: ['A=B'] }), /env must be an object/)
  // The whole point of the local credential rule: a header has a default name,
  // an environment variable does not, so linking without naming one is refused.
  assert.match(
    m.validateMcpEntry({ ...ok, credentialId: 'c-1' }),
    /needs credentialEnvVar/
  )
  assert.equal(m.validateMcpEntry({ ...ok, credentialId: 'c-1', credentialEnvVar: 'API_KEY' }), null)
  assert.match(
    m.validateMcpEntry({ ...ok, credentialId: 'c-1', credentialEnvVar: 'api key' }),
    /not a valid environment variable name/
  )
})

test('validator: ids and unknown kinds', () => {
  assert.match(m.validateMcpEntry({ kind: 'npm', id: 'Bad', package: 'p' }), /must be lowercase/)
  assert.match(m.validateMcpEntry({ kind: 'npm', id: 'gurt', package: 'p' }), /reserved/)
  assert.match(
    m.validateMcpEntry({ kind: 'npm', id: 'k8s', package: 'p' }, { takenIds: ['k8s'] }),
    /already used/
  )
  // An unfamiliar transport is refused, never read as http: it would otherwise
  // be called as a URL, or spawned, on the strength of a guess.
  assert.match(m.validateMcpEntry({ kind: 'sse', id: 'x', url: 'https://x/mcp' }), /is not one of http/)
})

test('normalizeMcpEntry: local optionals drop, and an http entry never gains a kind', () => {
  assert.deepEqual(
    m.normalizeMcpEntry({
      kind: 'npm',
      id: '  k8s ',
      label: '  ',
      package: ' kubernetes-mcp-server ',
      version: '  ',
      args: [],
      env: { '  ': 'dropped', OK: 'kept' },
      credentialId: '',
      credentialEnvVar: '  '
    }),
    { kind: 'npm', id: 'k8s', package: 'kubernetes-mcp-server', env: { OK: 'kept' } }
  )
  assert.deepEqual(
    m.normalizeMcpEntry({ kind: 'command', id: 'g', command: ' uvx ', cwd: ' /w ', args: ['a'] }),
    { kind: 'command', id: 'g', command: 'uvx', cwd: '/w', args: ['a'] }
  )
  // The compatibility promise, in the normalizer: the canonical spelling of an
  // http entry has no `kind` field, so nothing already on disk is rewritten.
  const http = m.normalizeMcpEntry({ kind: 'http', id: 'linear', url: 'https://x/mcp' })
  assert.deepEqual(http, { id: 'linear', url: 'https://x/mcp' })
  assert.equal('kind' in http, false)
})

// --- backwards compatibility (§3.1) -----------------------------------------

test('an entry with no kind is an http entry, everywhere that asks', () => {
  const legacy = { id: 'linear', url: 'https://mcp.linear.app/mcp' }
  assert.equal(m.mcpEntryKind(legacy), 'http')
  assert.equal(m.isHttpMcpEntry(legacy), true)
  assert.equal(m.isLocalMcpEntry(legacy), false)
  assert.equal(m.validateMcpEntry(legacy), null)
  assert.equal(m.mcpEntryDetail(legacy), 'https://mcp.linear.app/mcp')
})

test('a workspace.json written before local servers existed reads unchanged', async () => {
  const ws = 'legacy'
  const wsPath = path.join(GURT_ROOT, ws, 'workspace.json')
  fs.mkdirSync(path.join(GURT_ROOT, ws), { recursive: true })
  fs.writeFileSync(
    wsPath,
    JSON.stringify({
      repos: [],
      envs: [],
      mcpServers: [
        { id: 'linear', label: 'Linear', url: 'https://mcp.linear.app/mcp', credentialId: 'c-1' },
        { id: 'docs', url: 'https://docs.internal/mcp', headers: [{ name: 'X-A', value: 'v' }] }
      ]
    })
  )
  assert.deepEqual(await m.getMcpServers(ws), [
    { id: 'linear', label: 'Linear', url: 'https://mcp.linear.app/mcp', credentialId: 'c-1' },
    { id: 'docs', url: 'https://docs.internal/mcp', headers: [{ name: 'X-A', value: 'v' }] }
  ])
  // Reading did not rewrite the file, and did not invent a `kind`.
  assert.equal(JSON.parse(fs.readFileSync(wsPath, 'utf8')).mcpServers[0].kind, undefined)
})

test('the store round-trips every kind, and drops a record it cannot read', async () => {
  const ws = 'mixed'
  fs.mkdirSync(path.join(GURT_ROOT, ws), { recursive: true })
  const wsPath = path.join(GURT_ROOT, ws, 'workspace.json')
  fs.writeFileSync(wsPath, JSON.stringify({ repos: [], envs: [] }))
  await m.addMcpServer(ws, { id: 'linear', url: 'https://mcp.linear.app/mcp' })
  await m.addMcpServer(ws, { kind: 'npm', id: 'k8s', package: 'kubernetes-mcp-server', version: 'latest' })
  await m.addMcpServer(ws, { kind: 'command', id: 'git', command: '/usr/bin/env', args: ['true'] })
  assert.deepEqual(
    (await m.getMcpServers(ws)).map((e) => [m.mcpEntryKind(e), e.id]),
    [['http', 'linear'], ['npm', 'k8s'], ['command', 'git']]
  )

  const file = JSON.parse(fs.readFileSync(wsPath, 'utf8'))
  fs.writeFileSync(
    wsPath,
    JSON.stringify({
      ...file,
      mcpServers: [
        ...file.mcpServers,
        { kind: 'npm', id: 'no-package' },
        { kind: 'command', id: 'no-command' },
        { kind: 'stdio', id: 'unknown-kind', command: 'x' },
        { kind: 'npm', id: 'bad-args', package: 'p', args: 'nope', env: { A: 1 } }
      ]
    })
  )
  const back = await m.getMcpServers(ws)
  assert.deepEqual(back.map((e) => e.id), ['linear', 'k8s', 'git', 'bad-args'])
  // A field gurt cannot read degrades to absent; a record missing what its kind
  // requires, or naming a kind this build does not have, is dropped whole.
  assert.deepEqual(back[3], { kind: 'npm', id: 'bad-args', package: 'p' })
})

// --- what a local entry does and does not promise (§3.3) --------------------

test('a local entry gets no read-only mode, exactly like a remote one', () => {
  const registry = [
    { id: 'linear', url: 'https://x/mcp' },
    { kind: 'npm', id: 'k8s', package: 'kubernetes-mcp-server', args: ['--read-only'] }
  ]
  const entries = m.mcpEntries(registry)
  assert.deepEqual(entries.map((e) => [e.id, m.mcpHasModes(e)]), [
    ['github', true],
    ['linear', false],
    ['k8s', false]
  ])
  // The server's own read-only flag is in its argv, which is what the picker
  // shows — gurt reports it, it does not enforce it.
  assert.equal(m.mcpEntry('k8s', registry).description, 'kubernetes-mcp-server --read-only')
  assert.equal(m.mcpEntryDetail({ kind: 'command', id: 'g', command: 'uvx', args: ['a', 'b'] }), 'uvx a b')
  assert.equal(m.npmPackageSpec({ kind: 'npm', id: 'k', package: 'p', version: '1' }), 'p@1')
  assert.equal(m.npmPackageSpec({ kind: 'npm', id: 'k', package: 'p' }), 'p')
  assert.ok(m.LOCAL_MCP_NOTICE.includes('unsandboxed'))
})

// --- routing (§4.4) ---------------------------------------------------------

const REGISTRY = [
  { id: 'linear', url: 'https://mcp.linear.app/mcp' },
  { kind: 'npm', id: 'k8s', package: 'kubernetes-mcp-server' },
  { kind: 'command', id: 'git', command: 'uvx', args: ['mcp-server-git'] }
]

const plan = (selection, hostMcpUrls) =>
  m.planProxy({
    sessionId: 's1',
    token: 'tok',
    selection: selection.map((id) => ({ id, mode: 'full' })),
    registry: REGISTRY,
    hostMcpUrls: { gurt: 'http://host.docker.internal:1/mcp/g', ...hostMcpUrls }
  })

test('a local entry is a host upstream and a remote one is a registry upstream', () => {
  const { config, mcpServers, errors } = plan(['linear', 'k8s', 'git'], {
    k8s: 'http://host.docker.internal:5001/mcp/t-k8s',
    git: 'http://host.docker.internal:5002/mcp/t-git'
  })
  assert.deepEqual(errors, [])
  assert.equal(config.mcp['linear'].kind, 'registry')
  assert.equal(config.mcp['linear'].url, 'https://mcp.linear.app/mcp')
  assert.equal(config.mcp['k8s'].kind, 'host')
  assert.equal(config.mcp['k8s'].url, 'http://host.docker.internal:5001/mcp/t-k8s')
  assert.equal(config.mcp['git'].kind, 'host')
  assert.equal(config.mcp['git'].url, 'http://host.docker.internal:5002/mcp/t-git')
  // The agent's side is identical for all three — a proxy URL and the session
  // token, which is why nothing about the bridge reaches the container.
  assert.deepEqual(
    mcpServers.map((s) => s.url),
    ['linear', 'k8s', 'git', 'gurt'].map((id) => `http://gurt-proxy:8100/mcp/tok/${id}`)
  )
})

test('a local entry whose process is not running is reported, not routed', () => {
  const { config, mcpServers, errors } = plan(['k8s'], {})
  assert.equal(config.mcp['k8s'], undefined)
  assert.deepEqual(mcpServers.map((s) => s.name), ['gurt'])
  assert.equal(errors.length, 1)
  assert.match(errors[0], /"k8s" runs as a process on this machine/)
})

test('a local entry never falls back to the shared host base URL', () => {
  // The built-ins hang off one per-session listener by id; a bridge has its own
  // listener and its own token, so deriving a path would produce a live-looking
  // URL that answers 404.
  const { config, errors } = m.planProxy({
    sessionId: 's1',
    token: 'tok',
    selection: [{ id: 'k8s', mode: 'full' }, { id: 'github', mode: 'full' }],
    registry: REGISTRY,
    hostMcpUrl: 'http://host.docker.internal:9000/mcp/hosttoken'
  })
  assert.equal(config.mcp['github'].url, 'http://host.docker.internal:9000/mcp/hosttoken/github')
  assert.equal(config.mcp['k8s'], undefined)
  assert.equal(errors.length, 1)
})

test('an unknown id is still an error, exactly as it was', () => {
  const { errors } = plan(['nope'], {})
  assert.deepEqual(errors, [
    'MCP server "nope" is not a built-in and is not in this workspace\'s registry'
  ])
})

// --- the refcount (§6) ------------------------------------------------------

const registries = new Map([['w1', REGISTRY], ['w2', REGISTRY]])
const holder = (sessionId, workspace, ids) => ({ sessionId, workspace, ids })

test('the refcount is the live sessions, computed not stored', () => {
  const wants = m.localMcpWants(
    [
      holder('s1', 'w1', ['linear', 'k8s']),
      holder('s2', 'w1', ['k8s', 'git']),
      holder('s3', 'w1', [])
    ],
    registries
  )
  assert.deepEqual([...wants.keys()].sort(), ['w1::git', 'w1::k8s'])
  // One process for two sessions — that is the whole reason the id remapping in
  // the bridge exists.
  assert.deepEqual(wants.get('w1::k8s').sessions, ['s1', 's2'])
  assert.deepEqual(wants.get('w1::git').sessions, ['s2'])
  // A remote entry has no process to hold.
  assert.equal(wants.has('w1::linear'), false)

  // The last holder going away is what empties the set: nothing is remembered
  // between calls, so a crashed gurt converges on the next pass instead of
  // reading a stale count.
  assert.equal(m.localMcpWants([holder('s2', 'w1', ['k8s'])], registries).size, 1)
  assert.equal(m.localMcpWants([], registries).size, 0)
})

test('the same id in two workspaces is two processes', () => {
  const wants = m.localMcpWants(
    [holder('s1', 'w1', ['k8s']), holder('s2', 'w2', ['k8s'])],
    registries
  )
  assert.deepEqual([...wants.keys()].sort(), ['w1::k8s', 'w2::k8s'])
})

test('a hand-edited registry cannot put a process behind a built-in id', () => {
  // `mcpEntries` already makes the built-in win the lookup; the refcount has to
  // agree, or a workspace.json could shadow `github` with a spawned process.
  const shadowing = new Map([['w1', [{ kind: 'npm', id: 'github', package: 'not-gurts' }]]])
  assert.equal(m.localMcpWants([holder('s1', 'w1', ['github'])], shadowing).size, 0)
  assert.deepEqual(
    m.mcpEntries([{ kind: 'npm', id: 'github', package: 'not-gurts' }]).map((e) => e.source),
    ['builtin']
  )
})

test('an id that resolves to nothing holds nothing', () => {
  assert.equal(m.localMcpWants([holder('s1', 'w1', ['gone', 'github'])], registries).size, 0)
  assert.equal(m.localMcpWants([holder('s1', 'unknown-ws', ['k8s'])], registries).size, 0)
  // The same session listed twice counts once — a resume is not a second hold.
  const wants = m.localMcpWants(
    [holder('s1', 'w1', ['k8s']), holder('s1', 'w1', ['k8s'])],
    registries
  )
  assert.deepEqual(wants.get('w1::k8s').sessions, ['s1'])
})

test('the process spec changes when the process would, and not when it would not', () => {
  const base = { kind: 'npm', id: 'k8s', package: 'p', version: '1', args: ['--ro'] }
  const spec = m.localMcpSpec(base)
  assert.equal(m.localMcpSpec({ ...base, label: 'renamed' }), spec, 'a label is not a process')
  assert.notEqual(m.localMcpSpec({ ...base, version: '2' }), spec)
  assert.notEqual(m.localMcpSpec({ ...base, args: [] }), spec)
  assert.notEqual(m.localMcpSpec({ ...base, env: { A: 'b' } }), spec)
  assert.notEqual(m.localMcpSpec({ ...base, credentialEnvVar: 'K' }), spec)
  assert.notEqual(m.localMcpSpec({ kind: 'command', id: 'k8s', command: 'p', args: ['--ro'] }), spec)
})

// --- the credential, as an environment variable (§3.4) ----------------------

test('a local entry resolves its credential to a bare secret, not a header', () => {
  const creds = [
    { id: 'c-mcp', kind: 'mcp-token', label: 'k8s', data: { secret: '  s3cret  ' } },
    { id: 'c-agent', kind: 'agent-token', label: 'claude', data: { secret: 'x' } }
  ]
  // No scheme, no header name: it is going into `execve`'s environment.
  assert.deepEqual(m.resolveMcpEnvSecret(creds, 'c-mcp'), { secret: 's3cret' })
  assert.deepEqual(m.resolveMcpEnvSecret(creds, undefined), {})
  assert.match(m.resolveMcpEnvSecret(creds, 'gone').error, /no longer exists/)
  assert.match(m.resolveMcpEnvSecret(creds, 'c-agent').error, /is not an MCP token/)
  // A newline is fine in an environment value and fatal in a header — the two
  // resolvers differ exactly here.
  assert.deepEqual(m.resolveMcpEnvSecret([{ id: 'c', kind: 'mcp-token', label: 'l', data: { secret: 'a\nb' } }], 'c'), {
    secret: 'a\nb'
  })
  assert.match(
    m.resolveMcpEnvSecret([{ id: 'c', kind: 'mcp-token', label: 'l', data: { secret: 'a\0b' } }], 'c').error,
    /NUL byte/
  )
})

// --- JSON-RPC framing, on two fake streams (§4.1) ---------------------------

/** Feed a framer from a stream and collect what comes out. */
const framed = async (chunks) => {
  const messages = []
  const noise = []
  const frames = m.stdioFramer((msg) => messages.push(msg), (line) => noise.push(line))
  const stream = new PassThrough()
  stream.on('data', (chunk) => frames.push(chunk))
  for (const chunk of chunks) stream.write(chunk)
  stream.end()
  await new Promise((r) => stream.on('end', r))
  frames.flush()
  return { messages, noise }
}

test('one message per line, split across chunks however the pipe felt like it', async () => {
  const { messages, noise } = await framed([
    '{"jsonrpc":"2.0","id":1,',
    '"result":{"ok":true}}\n{"jsonrpc":"2.0","id":2,"result":2}\n'
  ])
  assert.deepEqual(messages, [
    { jsonrpc: '2.0', id: 1, result: { ok: true } },
    { jsonrpc: '2.0', id: 2, result: 2 }
  ])
  assert.deepEqual(noise, [])
})

test('a multi-byte character straddling a chunk boundary survives', async () => {
  const payload = Buffer.from('{"jsonrpc":"2.0","id":1,"result":"héllo — ok"}\n', 'utf8')
  const at = payload.indexOf(Buffer.from('—', 'utf8')) + 1
  const { messages } = await framed([payload.subarray(0, at), payload.subarray(at)])
  assert.deepEqual(messages, [{ jsonrpc: '2.0', id: 1, result: 'héllo — ok' }])
})

test('a server that logs to stdout is noise, not a broken server', async () => {
  const { messages, noise } = await framed([
    'listening on stdio\n',
    '\n',
    '{"jsonrpc":"2.0","id":1,"result":null}\n',
    'not json either\n'
  ])
  assert.deepEqual(messages, [{ jsonrpc: '2.0', id: 1, result: null }])
  assert.deepEqual(noise, ['listening on stdio', 'not json either'])
})

test('the last line arrives even without a trailing newline', async () => {
  const { messages } = await framed(['{"jsonrpc":"2.0","id":9,"result":1}'])
  assert.deepEqual(messages, [{ jsonrpc: '2.0', id: 9, result: 1 }])
})

test('a batch on one line is delivered message by message', async () => {
  const { messages, noise } = await framed([
    '[{"jsonrpc":"2.0","id":1,"result":1},{"jsonrpc":"2.0","id":2,"result":2}]\n',
    '[]\n',
    '"a bare string"\n'
  ])
  assert.deepEqual(messages, [
    { jsonrpc: '2.0', id: 1, result: 1 },
    { jsonrpc: '2.0', id: 2, result: 2 }
  ])
  // Valid JSON that is not a message is noise, not a message.
  assert.deepEqual(noise, ['"a bare string"'])
})

test('encoding is one compact line, and a newline in the payload cannot break it', () => {
  const line = m.encodeStdioMessage({ jsonrpc: '2.0', id: 1, params: { text: 'a\nb' } })
  assert.equal(line.endsWith('\n'), true)
  assert.equal(line.slice(0, -1).includes('\n'), false)
  assert.deepEqual(JSON.parse(line), { jsonrpc: '2.0', id: 1, params: { text: 'a\nb' } })
})

test('only a request gets a reply, so only a request is renumbered and waited for', () => {
  assert.equal(m.isJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), true)
  assert.equal(m.isJsonRpcRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }), false)
  assert.equal(m.isJsonRpcRequest({ jsonrpc: '2.0', id: 1, result: {} }), false)
  assert.equal(m.isJsonRpcRequest({ jsonrpc: '2.0', id: null, method: 'x' }), false)
})

// --- resolving a command on this machine (§4.3) -----------------------------

test('the PATH gurt searches is the user PATH plus where GUI apps lose it', () => {
  const resolved = m.hostPath({ PATH: '/usr/local/bin:/custom' })
  assert.equal(resolved.startsWith('/usr/local/bin:/custom:'), true, 'the user PATH wins and comes first')
  assert.equal(resolved.includes('/opt/homebrew/bin'), true)
  // De-duplicated: /usr/local/bin is in both halves and appears once.
  assert.equal(resolved.split(':').filter((d) => d === '/usr/local/bin').length, 1)
})

test('a command is resolved to an absolute path, or refused by name', () => {
  const env = { PATH: '/usr/bin:/bin' }
  assert.ok(m.resolveHostCommand('sh', env)?.startsWith('/'), 'a bare name is searched along PATH')
  assert.equal(m.resolveHostCommand('definitely-not-installed-xyz', env), null)
  // A path is checked as a path, never searched.
  assert.equal(m.resolveHostCommand('/bin/sh', env), '/bin/sh')
  assert.equal(m.resolveHostCommand('/bin/definitely-not-there', env), null)
})

test('a command that is not on this machine is refused when the entry is saved', () => {
  // The whole point of the save-time check: the alternative is a session that
  // starts fine an hour later and fails in a log the user never opens.
  assert.throws(
    () => m.checkMcpCommand({ kind: 'command', id: 'git', command: 'definitely-not-installed-xyz' }),
    /was not found on this machine/
  )
  m.checkMcpCommand({ kind: 'command', id: 'git', command: '/bin/sh' })
  // An npm entry has nothing to resolve — it runs with gurt's own node.
  m.checkMcpCommand({ kind: 'npm', id: 'k8s', package: 'p' })
})

test('an npm entry installs under ~/.gurt/mcp, keyed by its id', () => {
  assert.equal(m.mcpInstallDir('k8s'), path.join(GURT_ROOT, 'mcp', 'k8s'))
})

// --- the bridge end to end, against a real (tiny) stdio server --------------
//
// Not docker and not an MCP server: a five-line node script speaking the same
// line-framed JSON-RPC, which is enough to pin the two properties the bridge
// exists for — a POST reaches the child's stdin and its reply comes back, and
// two clients that both used request id 1 get their *own* answer back.

const ECHO_SERVER = `
  let rest = ''
  process.stdin.on('data', (c) => {
    rest += c
    const lines = rest.split('\\n')
    rest = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      if (msg.id === undefined) continue
      // Answer out of order on purpose: nothing may depend on the child
      // replying in the order it was asked.
      const delay = msg.params?.delay ?? 0
      setTimeout(
        () => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { echo: msg.params?.mark } }) + '\\n'),
        delay
      )
    }
  })
`

test('a POST reaches the child and its reply comes back', async () => {
  const script = path.join(GURT_ROOT, 'echo-server.mjs')
  fs.writeFileSync(script, ECHO_SERVER)
  const bridge = m.startStdioBridge({
    kind: 'command',
    id: 'echo',
    command: process.execPath,
    args: [script]
  })
  try {
    const url = await bridge.ready
    const call = async (body) => {
      const res = await fetch(url.replace('host.docker.internal', '127.0.0.1'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
      return { status: res.status, body: res.status === 202 ? null : await res.json() }
    }

    assert.deepEqual(await call({ jsonrpc: '2.0', id: 1, method: 'ping', params: { mark: 'a' } }), {
      status: 200,
      body: { jsonrpc: '2.0', id: 1, result: { echo: 'a' } }
    })

    // Two callers, both using id 1, both slow, overlapping on purpose: the
    // bridge renumbers onto its own sequence, so neither reads the other's
    // reply. This is the whole reason one process can be shared by sessions.
    const [first, second] = await Promise.all([
      call({ jsonrpc: '2.0', id: 1, method: 'ping', params: { mark: 'first', delay: 60 } }),
      call({ jsonrpc: '2.0', id: 1, method: 'ping', params: { mark: 'second', delay: 10 } })
    ])
    assert.equal(first.body.result.echo, 'first')
    assert.equal(second.body.result.echo, 'second')
    assert.equal(first.body.id, 1, 'the client gets its own id back, not the bridge id')

    // A notification has no reply to wait for — the transport's own answer.
    assert.deepEqual(await call({ jsonrpc: '2.0', method: 'notifications/initialized' }), {
      status: 202,
      body: null
    })

    // A batch comes back as a batch, whatever order the child answered in.
    const batch = await call([
      { jsonrpc: '2.0', id: 7, method: 'ping', params: { mark: 'slow', delay: 40 } },
      { jsonrpc: '2.0', id: 8, method: 'ping', params: { mark: 'fast' } }
    ])
    assert.equal(batch.status, 200)
    assert.deepEqual(
      batch.body.map((r) => [r.id, r.result.echo]).sort(),
      [[7, 'slow'], [8, 'fast']].sort()
    )

    // Everything else on the route is closed: no SSE stream to GET, no session
    // to DELETE, and the token is the only thing that opens it at all.
    const bad = await fetch(url.replace('host.docker.internal', '127.0.0.1').replace(/\/[^/]+$/, '/wrong-token'), {
      method: 'POST',
      body: '{}'
    })
    assert.equal(bad.status, 404)
    const get = await fetch(url.replace('host.docker.internal', '127.0.0.1'))
    assert.equal(get.status, 405)
  } finally {
    await bridge.stop()
  }
})

test('stopping the bridge closes the listener and the process', async () => {
  const script = path.join(GURT_ROOT, 'echo-server.mjs')
  const bridge = m.startStdioBridge({
    kind: 'command',
    id: 'echo2',
    command: process.execPath,
    args: [script]
  })
  const url = (await bridge.ready).replace('host.docker.internal', '127.0.0.1')
  await bridge.stop()
  // Idempotent: teardown runs from the session path and from app quit.
  await bridge.stop()
  await assert.rejects(fetch(url, { method: 'POST', body: '{}' }))
})

test('a command that cannot be spawned fails at start, with the reason', async () => {
  const bridge = m.startStdioBridge({
    kind: 'command',
    id: 'nope',
    command: 'definitely-not-installed-xyz'
  })
  await assert.rejects(bridge.ready, /was not found on this machine/)
  await bridge.stop()
})
