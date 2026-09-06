// The host half of the proxy contract (docs/requirements-mcp-proxy.md §4.3,
// §5.3): `planProxy` turning a session's MCP selection + the workspace registry
// + the credential store into the proxy's scope and the ACP descriptors the
// agent receives, and `writeProxyConfig` putting the result where the proxy
// container reads it.
//
// Two properties this file exists for. First, the secret boundary: a resolved
// credential appears in the config file and *nowhere* in a descriptor, because
// the descriptors go into the session container and the config file does not.
// Second, the contract is pinned end to end — the config built here is fed to
// the real proxy's own parser (`resources/proxy/gurt-proxy.mjs`), so the two
// halves cannot drift apart silently.
//
//   node scripts/proxy-config.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import * as proxy from '../resources/proxy/gurt-proxy.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-proxy-config-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

// store.ts reads GURT_ROOT at module load — set it before the import.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-proxy-config-'))
process.env.GURT_ROOT = GURT_ROOT
// No keystore outside real Electron: credential writes stay plaintext.
process.env.GURT_FORCE_PLAINTEXT = '1'

await bundle({
  stdin: {
    contents: `
      export {
        planProxy, resolveProxyPlan, writeProxyConfig, removeProxyConfig,
        removeProxyConfigDir, proxyConfigPath, proxyConfigDir, proxyConfigMount,
        readProxyToken, mintProxyToken
      } from ${S('src/main/proxy/config.ts')}
      export { PROXY_ALIAS, PROXY_PORT, proxyBaseUrl, proxyMcpUrl } from ${S('src/shared/proxy.ts')}
      export { createWorkspace, addMcpServer } from ${S('src/main/store.ts')}
      export { setCredentials } from ${S('src/main/credentials.ts')}
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

const TOKEN = 'session-token-aaaabbbbccccdddd'
const HOST_MCP = 'http://host.docker.internal:54321/mcp/HOST-TOKEN-9f8e7d'
const SECRET = 'sk-linear-1a2b3c4d5e6f'

const CREDENTIALS = [
  { id: 'c-mcp', label: 'linear token', kind: 'mcp-token', hosts: [], data: { secret: SECRET } },
  {
    id: 'c-key',
    label: 'api key',
    kind: 'mcp-token',
    hosts: [],
    data: { secret: 'k-2', header: 'X-Api-Key', scheme: '' }
  },
  { id: 'c-agent', label: 'claude', kind: 'agent-token', hosts: [], data: { secret: 'sk-a' } }
]

const REGISTRY = [
  {
    id: 'linear',
    label: 'Linear',
    url: 'https://mcp.linear.app/mcp',
    headers: [{ name: 'X-Team', value: 'core' }],
    credentialId: 'c-mcp'
  },
  { id: 'docs', url: 'https://docs.internal/mcp' },
  { id: 'keyed', url: 'https://keyed.internal/mcp', credentialId: 'c-key' }
]

const plan = (selection, extra = {}) =>
  m.planProxy({
    sessionId: 's1',
    token: TOKEN,
    selection,
    registry: REGISTRY,
    credentials: CREDENTIALS,
    hostMcpUrl: HOST_MCP,
    ...extra
  })

const sel = (id, mode = 'full') => ({ id, mode })

test('a built-in is routed to gurt’s host listener, on the URL that carries the host token', () => {
  const { config, mcpServers, errors } = plan([sel('github', 'read-only')])
  assert.deepEqual(errors, [])
  assert.deepEqual(config.mcp.github, { kind: 'host', url: `${HOST_MCP}/github` })
  // The agent is handed the proxy, never the host: this URL is the only address
  // it ever learns for an MCP server.
  assert.deepEqual(mcpServers[0], {
    type: 'http',
    name: 'github',
    url: `http://gurt-proxy:8100/mcp/${TOKEN}/github`,
    headers: []
  })
})

test('the turn-contract server is always in scope, selected or not', () => {
  const empty = plan(undefined)
  assert.deepEqual(Object.keys(empty.config.mcp), ['gurt'])
  assert.deepEqual(empty.mcpServers.map((s) => s.name), ['gurt'])
  // A session is over when the agent cannot report that it is, so `gurt` is not
  // a thing the picker can switch off.
  const picked = plan([sel('github')])
  assert.deepEqual(picked.mcpServers.map((s) => s.name), ['github', 'gurt'])
})

test('a registry entry carries its static headers plus the resolved credential', () => {
  const { config, errors } = plan([sel('linear')])
  assert.deepEqual(errors, [])
  assert.deepEqual(config.mcp.linear, {
    kind: 'registry',
    url: 'https://mcp.linear.app/mcp',
    headers: [
      { name: 'X-Team', value: 'core' },
      { name: 'Authorization', value: `Bearer ${SECRET}` }
    ]
  })
  // A bare-secret credential (X-Api-Key style) resolves the same way.
  assert.deepEqual(plan([sel('keyed')]).config.mcp.keyed.headers, [{ name: 'X-Api-Key', value: 'k-2' }])
  // No link is legal — an unauthenticated upstream is a normal thing to have.
  assert.equal(plan([sel('docs')]).config.mcp.docs.headers, undefined)
})

test('the resolved credential wins over a static header of the same name, whatever its spelling', () => {
  const registry = [{ id: 'linear', url: 'https://mcp.linear.app/mcp', headers: [{ name: 'authorization', value: 'Bearer stale' }], credentialId: 'c-mcp' }]
  const { config } = m.planProxy({
    sessionId: 's1',
    token: TOKEN,
    selection: [sel('linear')],
    registry,
    credentials: CREDENTIALS,
    hostMcpUrl: HOST_MCP
  })
  assert.deepEqual(config.mcp.linear.headers, [{ name: 'Authorization', value: `Bearer ${SECRET}` }])
})

test('no secret reaches the session container: the descriptors are URLs and nothing else', () => {
  const { config, mcpServers } = plan([sel('linear'), sel('github')])
  const descriptors = JSON.stringify(mcpServers)
  assert.ok(!descriptors.includes(SECRET), 'the credential lives in the proxy, not in the agent')
  assert.ok(!descriptors.includes('HOST-TOKEN-9f8e7d'), 'nor does the host listener’s token')
  assert.ok(!descriptors.includes('mcp.linear.app'), 'nor even the upstream address')
  for (const s of mcpServers) assert.deepEqual(s.headers, [])
  // All of which is in the config file, which is mounted into the proxy only.
  assert.ok(JSON.stringify(config).includes(SECRET))
})

test('a credential that does not resolve blocks the server — it never falls back to unauthenticated', () => {
  const dangling = [{ id: 'linear', url: 'https://mcp.linear.app/mcp', credentialId: 'gone' }]
  const wrongKind = [{ id: 'linear', url: 'https://mcp.linear.app/mcp', credentialId: 'c-agent' }]
  for (const { registry, pattern } of [
    { registry: dangling, pattern: /no longer exists/ },
    { registry: wrongKind, pattern: /not an MCP token/ }
  ]) {
    const { config, mcpServers, errors } = m.planProxy({
      sessionId: 's1',
      token: TOKEN,
      selection: [sel('linear')],
      registry,
      credentials: CREDENTIALS,
      hostMcpUrl: HOST_MCP
    })
    assert.equal(config.mcp.linear, undefined, 'nothing is routed')
    assert.deepEqual(mcpServers.map((s) => s.name), ['gurt'], 'and the agent is not handed a broken server')
    assert.equal(errors.length, 1)
    assert.match(errors[0], /linear/)
    assert.match(errors[0], pattern)
  }
})

test('an id that is neither a built-in nor in the registry is an error, not a silent drop', () => {
  const { config, errors } = plan([sel('ghost'), sel('docs')])
  assert.equal(config.mcp.ghost, undefined)
  assert.match(errors[0], /"ghost" is not a built-in and is not in this workspace/)
  assert.ok(config.mcp.docs, 'the rest of the selection still resolves')
})

test('without a host listener the built-ins report why, and the registry still routes', () => {
  const { config, errors } = m.planProxy({
    sessionId: 's1',
    token: TOKEN,
    selection: [sel('github'), sel('docs')],
    registry: REGISTRY,
    credentials: CREDENTIALS
  })
  assert.deepEqual(Object.keys(config.mcp), ['docs'])
  assert.equal(errors.length, 2, 'github and the always-on gurt server')
  for (const e of errors) assert.match(e, /host listener is not running/)
})

test('a selection is deduplicated, and the granted mode stays out of the scope', () => {
  const { config, mcpServers } = plan([sel('linear', 'read-only'), sel('linear', 'full'), sel('linear')])
  assert.deepEqual(mcpServers.map((s) => s.name), ['linear', 'gurt'])
  // read-only is a property of gurt's *own* servers (buildGithubHttpServer
  // builds a smaller tool set for it). The proxy knows nothing about an
  // upstream's tools and must not look like it enforces something it cannot.
  assert.equal('mode' in config.mcp.linear, false)
  assert.deepEqual(config.mcp.linear, plan([sel('linear', 'full')]).config.mcp.linear)
})

test('the network block defaults to open and observed, and carries what it is given', () => {
  assert.deepEqual(plan([]).config.network, { internal: false, policy: { allow: [] } })
  const strict = plan([], { network: { internal: true, policy: { allow: ['registry.npmjs.org'] } } })
  assert.deepEqual(strict.config.network, {
    internal: true,
    policy: { allow: ['registry.npmjs.org'] }
  })
})

test('the config the host writes is one the proxy accepts', () => {
  const { config } = plan([sel('github'), sel('linear'), sel('docs')], {
    network: { internal: true, policy: { allow: ['registry.npmjs.org'] } }
  })
  // The other half of the contract, parsed by the file the container mounts.
  const parsed = proxy.parseConfig(JSON.parse(JSON.stringify(config)))
  assert.equal(parsed.error, undefined)
  assert.deepEqual(Object.keys(parsed.config.mcp).sort(), ['docs', 'github', 'gurt', 'linear'])
  assert.ok(proxy.tokenMatches(TOKEN, parsed.config.token))
  const policy = parsed.config.network.policy
  assert.equal(proxy.policyDecision('registry.npmjs.org', 443, policy).allowed, true)
  assert.equal(proxy.policyDecision('raw.pastebin.com', 443, policy).allowed, false)
})

test('an allow entry survives the trip, and is the only thing that opens the docker host', () => {
  // Rules 2 and 3 (§6.3), pinned end to end: sanitized on this side, parsed on
  // the proxy's, and meaning the same thing in both. A session pointed at a
  // locally-published MCP or dev server is why an entry can name a port.
  const { config } = plan([sel('linear')], {
    network: {
      internal: true,
      policy: { allow: ['  Host.Docker.Internal.:5173 ', 'host.docker.internal:5173'] }
    }
  })
  assert.deepEqual(
    config.network.policy,
    { allow: ['host.docker.internal:5173'] },
    'lowercased, root dot stripped, deduplicated — the record shows what will be matched'
  )
  const parsed = proxy.parseConfig(JSON.parse(JSON.stringify(config)))
  assert.equal(parsed.error, undefined)
  const vet = (host, port) => proxy.vetTarget(host, port, parsed.config.network.policy)
  assert.equal(vet('host.docker.internal', 5173).allowed, true, 'the built-in denylist is not consulted')
  assert.equal(vet('host.docker.internal', 5174).rule, 'allowlist', 'and nothing else on it')
  assert.equal(vet('registry.npmjs.org', 443).rule, 'allowlist', 'nor anything else at all')
})

test('an empty allow list is open, and it is what an old three-mode policy migrates to', () => {
  // §6.3 migration: the modes are gone, and only the entries the user actually
  // wrote survive. `alwaysAllow` was already "connect this as written" (rule 3).
  const policy = (network) => plan([], { network }).config.network.policy
  assert.deepEqual(policy({ policy: { mode: 'allow' } }), { allow: [] })
  assert.deepEqual(policy({ policy: { mode: 'denylist', domains: ['pastebin.com'] } }), { allow: [] })
  assert.deepEqual(policy({ policy: { mode: 'allowlist', domains: ['npmjs.org'] } }), { allow: ['npmjs.org'] })
  assert.deepEqual(policy({ policy: { mode: 'denylist', domains: [], alwaysAllow: ['10.1.2.3'] } }), {
    allow: ['10.1.2.3']
  })
  // Every one of them is a config the proxy accepts.
  for (const p of [{ mode: 'allow' }, { mode: 'allowlist', domains: [] }, { mode: 'denylist', domains: ['x.test'] }])
    assert.equal(proxy.parseConfig(JSON.parse(JSON.stringify(plan([], { network: { policy: p } }).config))).error, undefined)
})

test('a token is 32 random bytes, base64url, and never the same twice', () => {
  const token = m.mintProxyToken()
  assert.match(token, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(token, m.mintProxyToken())
  // It is a path segment, so it must survive being one unescaped.
  assert.equal(m.proxyMcpUrl(token, 'linear'), `http://gurt-proxy:8100/mcp/${token}/linear`)
})

test('the config file is written atomically, 0600, in a 0700 directory', async () => {
  const { config } = plan([sel('linear')])
  const file = await m.writeProxyConfig('s1', config)
  assert.equal(file, m.proxyConfigPath('s1'))
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), config)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the one place a resolved credential is at rest')
  assert.equal(fs.statSync(m.proxyConfigDir()).mode & 0o777, 0o700)
  // One directory per session, because the *directory* is what the proxy
  // container bind-mounts: a file bind mount pins an inode, and the rename
  // below would then be invisible inside the container forever. A shared
  // directory would put every session's credentials in every proxy.
  assert.equal(m.proxyConfigMount('s1'), path.dirname(file))
  assert.equal(fs.statSync(m.proxyConfigMount('s1')).mode & 0o777, 0o700)
  assert.deepEqual(fs.readdirSync(m.proxyConfigDir()), ['s1'])
  // Written through a temp file and renamed, so the proxy's watcher can never
  // read a half-written scope — and nothing is left behind.
  assert.deepEqual(fs.readdirSync(m.proxyConfigMount('s1')), ['proxy.json'])

  // A push is a rewrite of the same path: the proxy re-reads it, and the token
  // the agent already holds is untouched.
  const next = plan([sel('linear'), sel('docs')]).config
  await m.writeProxyConfig('s1', next)
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(Object.keys(onDisk.mcp).sort(), ['docs', 'gurt', 'linear'])
  assert.equal(onDisk.token, config.token)

  // The token is what a reused proxy recovers, so a resumed session's agent
  // keeps talking to the scope it already holds a handle to.
  assert.equal(await m.readProxyToken('s1'), config.token)

  await m.removeProxyConfig('s1')
  assert.equal(fs.existsSync(file), false, 'removing the file revokes the scope')
  assert.equal(await m.readProxyToken('s1'), null, 'and there is no token to recover')
  assert.equal(
    fs.existsSync(m.proxyConfigMount('s1')),
    true,
    'the directory stays — it is a live bind-mount source until the proxy is gone'
  )
  await m.removeProxyConfig('s1')
  await m.removeProxyConfigDir('s1')
  assert.equal(fs.existsSync(m.proxyConfigMount('s1')), false, 'teardown retires the directory')
})

test('resolveProxyPlan reads the workspace registry and the credential store', async () => {
  await m.createWorkspace('ws')
  await m.setCredentials({ credentials: CREDENTIALS })
  await m.addMcpServer('ws', {
    id: 'linear',
    url: 'https://mcp.linear.app/mcp',
    credentialId: 'c-mcp'
  })
  const { config, mcpServers, errors } = await m.resolveProxyPlan(
    { workspace: 'ws', task: 't1', env: 'dev' },
    's2',
    TOKEN,
    [{ id: 'linear', mode: 'full' }],
    { hostMcpUrl: HOST_MCP }
  )
  assert.deepEqual(errors, [])
  assert.deepEqual(config.mcp.linear.headers, [{ name: 'Authorization', value: `Bearer ${SECRET}` }])
  assert.deepEqual(mcpServers.map((s) => s.name), ['linear', 'gurt'])
})
