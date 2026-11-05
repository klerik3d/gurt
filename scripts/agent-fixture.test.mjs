// A sixth agent needs no core change (docs/requirements-agent-plugins.md §9.3).
//
// Adding an agent is one folder under src/plugins/agents/ and its line in the
// list files. This test does exactly that and nothing else: the bundle below
// is the real core, with the shared list (src/plugins/agents/index.ts)
// resolved to the real list plus one more entry — a minimal, data-only
// manifest, no shared half and no main half, so the main list is untouched.
// Every check then goes through the code the five built-in agents use, and
// pins what "optional means absent" promises a kind that declares nothing
// beyond the basics:
//
//   - launch resolution takes its bin, args and secret env from the manifest;
//   - no skills mount (skillsDir null) and no history mount (no paths), so the
//     container config is the env's own;
//   - an empty seed config, the generic icon, no sign-in, no native config;
//   - its token is "not checked", and its plan is never polled;
//   - modes, tool titles and limit notices are read with the core's plain
//     words only — no other agent's vocabulary leaks onto it.
//
// No docker: `resolveLaunch`'s two container steps (`ensure`, and the adapter
// install racing the proxy scope) are stubbed on the instance, the pattern of
// scripts/proxy-adapter-parallel.test.mjs. No network: `fetch` is a parameter.
//
//   node scripts/agent-fixture.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

// store.ts reads GURT_ROOT at module load — set it before the import.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-agent-fixture-'))
process.env.GURT_ROOT = GURT_ROOT
process.env.GURT_FORCE_PLAINTEXT = '1'

/** The sixth agent: the required fields of a manifest, nothing optional. */
const FIXTURE = {
  id: 'fixture-agent',
  label: 'fixture',
  vendor: 'Example Labs',
  adapterPackages: ['fixture-acp@1.0.0'],
  bin: 'fixture-acp',
  binArgs: ['--acp', '--quiet'],
  secretEnv: 'FIXTURE_API_KEY',
  oauthProvider: null,
  skillsDir: null,
  historyPaths: []
}

/** "One line in the list file": the real shared list, plus the fixture. */
const withFixture = {
  name: 'sixth-agent',
  setup(build) {
    build.onResolve({ filter: /^\.\.\/plugins\/agents$/ }, (args) =>
      args.importer.endsWith(path.join('src', 'shared', 'agents.ts'))
        ? { path: 'shared-list', namespace: 'sixth-agent' }
        : undefined
    )
    build.onLoad({ filter: /.*/, namespace: 'sixth-agent' }, () => ({
      contents: `
        import { AGENT_PLUGINS as BUILTIN } from ${S('src/plugins/agents/index.ts')}
        export const AGENT_PLUGINS = [...BUILTIN, { manifest: ${JSON.stringify(FIXTURE)} }]
      `,
      resolveDir: ROOT,
      loader: 'ts'
    }))
  }
}

// Inside the checkout, not the temp dir: the adapter spawn resolves the
// devcontainer CLI (and react-dom/server its built-ins) relative to the bundle.
fs.mkdirSync(path.join(ROOT, 'node_modules', '.cache'), { recursive: true })
const outDir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache', 'gurt-agent-fixture-'))
const outfile = path.join(outDir, 'entry.mjs')
// …but with no Electron, as in every other test: a stub nearer than the real
// package (which would try to download its binary) fails to load like an
// absent one.
fs.mkdirSync(path.join(outDir, 'node_modules', 'electron'), { recursive: true })
fs.writeFileSync(path.join(outDir, 'node_modules', 'electron', 'package.json'), '{"name":"electron","main":"index.js"}')
fs.writeFileSync(
  path.join(outDir, 'node_modules', 'electron', 'index.js'),
  "throw Object.assign(new Error(\"Cannot find module 'electron'\"), { code: 'MODULE_NOT_FOUND' })\n"
)
await bundle({
  stdin: {
    contents: `
      export { AGENT_MANIFESTS, agentDef } from ${S('src/shared/agents.ts')}
      export { ContainerManager } from ${S('src/main/containers.ts')}
      export { spawnAcpAdapter, overrideConfigArgs } from ${S('src/main/provision.ts')}
      export { createBus } from ${S('src/main/bus.ts')}
      export { setAgents, getAgents, getAgentConfig, liftAgent } from ${S('src/main/store.ts')}
      export { upsertCredentialEntry } from ${S('src/main/credentials.ts')}
      export { OAUTH_PROVIDER_CHOICES } from ${S('src/shared/credentials.ts')}
      export { OAUTH_PROVIDERS } from ${S('src/main/oauth/index.ts')}
      export { oauthAuthFile } from ${S('src/main/oauth/materialize.ts')}
      export { defaultAgentConfig, agentOptionView } from ${S('src/shared/agentConfig.ts')}
      export { clientConfigPath, clientConfigFile, clientConfigExample } from ${S('src/shared/clientConfig.ts')}
      export { probeAgentToken, canProbeAgentToken } from ${S('src/main/agentProviders.ts')}
      export { createPlanUsage } from ${S('src/main/planUsage.ts')}
      export { windowElapsedPercent } from ${S('src/shared/planUsage.ts')}
      export { SessionManager, nextModeId } from ${S('src/main/sessions.ts')}
      export { agentVocabulary, isBlanketMode, mcpToolOf } from ${S('src/shared/agentVocabulary.ts')}
      export { firstRunSignIn } from ${S('src/main/firstRun.ts')}
      export { flushSync } from ${S('src/main/log.ts')}
      export { AgentIcon, Icon } from ${S('src/renderer/src/components/icons.tsx')}
      export { createElement } from 'react'
      export { renderToStaticMarkup } from 'react-dom/server'
    `,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  jsx: 'automatic',
  // react-dom/server's node build requires Node built-ins at runtime.
  banner: { js: "import { createRequire as __gurtRequire } from 'node:module'; const require = __gurtRequire(import.meta.url);" },
  plugins: [withFixture],
  external: ['electron'],
  outfile
})
const m = await import(pathToFileURL(outfile).href)

after(() => {
  // The app log writes into GURT_ROOT behind the tests' backs: put it on disk
  // now, or a late write recreates the directory after it is removed.
  m.flushSync()
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

const KIND = FIXTURE.id

test('the fixture is in the registry, after the built-ins, exactly as declared', () => {
  assert.deepEqual(m.AGENT_MANIFESTS.map((d) => d.id), ['claude-code', 'codex', 'gemini', 'opencode', 'pi', KIND])
  assert.deepEqual(m.agentDef(KIND), FIXTURE)
  // And the persisted layouts read it like any other kind — the legacy
  // agents.json shape keyed records by kind.
  assert.equal(m.liftAgent(KIND, { label: '' })?.instance.kind, KIND)
  assert.equal(m.liftAgent(KIND, { label: '' })?.instance.label, FIXTURE.label)
})

test('launch: bin, args and secret env from the manifest; no skills, no history mount', async () => {
  // A plain single-repo session that picked a skill: with a kind that reads
  // skills it would get the skills bind (and the per-session config with it).
  const ws = 'w'
  fs.mkdirSync(path.join(GURT_ROOT, ws, 't'), { recursive: true })
  fs.writeFileSync(
    path.join(GURT_ROOT, ws, 'workspace.json'),
    JSON.stringify({ repos: [{ name: 'r', url: 'https://example.com/r.git' }], envs: [{ name: 'r', devcontainer: '', repo: 'r' }] })
  )
  await m.upsertCredentialEntry({ id: 'fx-key', label: 'fixture key', kind: 'agent-token', hosts: [], data: { secret: 'fx-secret' } })
  await m.setAgents({ fx: { kind: KIND, label: 'Fixture', credentialId: 'fx-key' } })
  const info = {
    id: 's1', title: 's1', workspace: ws, task: 't', env: 'r', repos: ['r'], agent: 'fx',
    skills: [{ name: 'house-style' }], state: 'draft', createdAt: new Date().toISOString(), startPrompt: ''
  }
  const containers = new m.ContainerManager({
    bus: m.createBus(),
    session: (id) => (id === info.id ? info : undefined),
    sessions: () => [info],
    patchContainer: () => {},
    isSessionIdle: () => false,
    detach: () => {}
  })
  containers.ensure = async () => ({ status: 'running', id: 'c0ffee0123456789ab', remoteWorkspaceFolder: '/workspaces/r' })
  /** @type {any} */
  let installed
  containers.installAdapterAndProxy = async (_info, _id, target) => {
    installed = target
    return { session: info.id, token: 't', containerId: 'c0ffee0123456789ab', network: 'n', base: 'http://gurt-proxy:8100', internal: false }
  }

  const ctx = await containers.resolveLaunch(info.id)
  assert.equal(ctx.agent, m.agentDef(KIND))
  assert.equal(installed.agent, m.agentDef(KIND), 'the adapter install gets the same manifest')
  assert.equal(ctx.secret, 'fx-secret')
  assert.equal(ctx.secretEnv, 'FIXTURE_API_KEY')
  assert.equal(ctx.env, undefined, 'no launch env of its own')
  assert.deepEqual(
    ctx.configArgs,
    m.overrideConfigArgs({ workspace: ws, task: 't', env: 'r' }),
    'no skills bind, no history bind: the env’s own config, as if neither feature existed'
  )

  const child = m.spawnAcpAdapter(info.id, ctx.agent, ctx.configArgs, ctx.hostWorkspaceFolder, ctx.secret, ctx.secretEnv, ctx.env)
  child.on('error', () => {})
  child.kill()
  const argv = child.spawnargs
  assert.deepEqual(argv.slice(-3), ['fixture-acp', '--acp', '--quiet'], 'the adapter is the manifest’s bin and args')
  assert.ok(argv.includes('FIXTURE_API_KEY=fx-secret'), 'the secret rides the manifest’s env var')
})

test('no seed config, no option quirks, no native config, the generic icon', async () => {
  assert.deepEqual(m.defaultAgentConfig(KIND), { configOptions: [], commands: [] })
  assert.deepEqual(await m.getAgentConfig('fx'), { configOptions: [], commands: [] })
  const opt = { id: 'model', name: 'Model', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default' }] }
  assert.deepEqual(m.agentOptionView(KIND).selectOptions(opt), opt.options, 'options shown as reported')
  assert.equal(m.clientConfigPath(KIND), undefined)
  assert.deepEqual(m.clientConfigExample(KIND), {})
  assert.throws(() => m.clientConfigFile(KIND, {}), /not supported/)
  const html = (el) => m.renderToStaticMarkup(el)
  assert.equal(
    html(m.createElement(m.AgentIcon, { kind: KIND, size: 11 })),
    html(m.createElement(m.Icon, { name: 'agent-generic', size: 11 }))
  )
})

test('no sign-in: not offered, not runnable, nothing materialized', async () => {
  assert.ok(!m.OAUTH_PROVIDER_CHOICES.some((p) => p.id === KIND))
  assert.deepEqual(Object.keys(m.OAUTH_PROVIDERS), ['anthropic', 'openai', 'google'])
  await assert.rejects(m.firstRunSignIn(/** @type {any} */ (null), KIND), /has no sign-in path/)
  const signIn = { id: 'o', label: 'o', kind: 'oauth', hosts: [], data: { providerId: 'anthropic', access: 'a' } }
  assert.equal(m.oauthAuthFile(KIND, signIn, 'a', Date.now()), null, 'a sign-in would ride the env var')
})

test('the token probe says "not checked", and the plan is never polled', async () => {
  assert.equal(m.canProbeAgentToken(KIND), false)
  const probe = await m.probeAgentToken(KIND, 'fx-secret', async () => assert.fail('no request for a kind without a probe'))
  assert.equal(probe.verdict, 'unreachable')
  assert.match(probe.detail, /no token check exists for "fixture-agent" — not verified/)

  const store = m.createPlanUsage(m.createBus(), {
    agents: async () => ({ fx: { kind: KIND, label: 'Fixture', credentialId: 'fx-key' } }),
    credentials: async () => [{ id: 'fx-key', label: 'k', kind: 'agent-token', hosts: [], data: { secret: 'sk-ant-oat01-x' } }],
    fetchImpl: async () => assert.fail('a kind without plan usage is never polled')
  })
  assert.deepEqual(await store.get(), {}, 'no snapshot, no meters')
  // And no window of its own gets a duration it never declared — not even one
  // spelled like another plugin's: window ids are each provider's own keys.
  const reset = Date.parse('2026-10-22T12:00:00Z')
  const fiveHour = { id: 'five_hour', resetsAt: new Date(reset).toISOString() }
  assert.equal(m.windowElapsedPercent(fiveHour, reset - 2.5 * 3600_000, 'claude-code'), 50, 'claude-code times its own')
  assert.equal(m.windowElapsedPercent(fiveHour, reset - 2.5 * 3600_000, KIND), undefined)
  assert.equal(m.windowElapsedPercent({ id: 'fixture_window', resetsAt: fiveHour.resetsAt }, reset, KIND), undefined)
})

test('modes, tool titles and limits: the core’s plain words, nobody else’s', async () => {
  const words = m.agentVocabulary(KIND)
  assert.deepEqual(words, m.agentVocabulary(undefined), 'the empty vocabulary')
  const modes = {
    currentModeId: 'default',
    availableModes: [
      { id: 'default', name: 'Default' },
      { id: 'review', name: 'Review', kind: 'auto_review' },
      { id: 'yolo', name: 'YOLO' },
      { id: 'bypass', name: 'Bypass permissions' }
    ]
  }
  // Another agent's auto-review kind and blanket word mean nothing here: auto
  // falls through to the plain "bypass", and only that one is hidden.
  assert.equal(m.nextModeId({ autoAllow: true }, modes, words.modes), 'bypass')
  assert.deepEqual(modes.availableModes.filter((x) => m.isBlanketMode(x, words.modes)).map((x) => x.id), ['bypass'])
  assert.equal(m.mcpToolOf('mcp__gurt__complete', words.toolTitles), undefined)
  assert.equal(m.mcpToolOf('Tool: gurt/complete', words.toolTitles), undefined)

  // The limit detector, through the session manager, for an instance of the kind.
  const manager = Object.assign(Object.create(m.SessionManager.prototype), { agentKinds: new Map([['fx', KIND]]) })
  /** @param {{ stopReason?: string, threw: boolean }} [outcome] @param {string} [detail] */
  const detect = (entries, outcome = { stopReason: 'end_turn', threw: false }, detail = undefined) =>
    m.SessionManager.prototype.withLimit.call(manager, { info: { id: 's', agent: 'fx' }, turnRejected: false, entries }, outcome, detail, 10)
  assert.equal(detect([{ id: 10, kind: 'agent', text: "You've hit your session limit · resets 3pm" }]).limit, undefined,
    'another agent’s limit notice is ordinary text from this one')
  assert.ok(detect([], { threw: true }, 'HTTP 429 too many requests').limit, 'the generic wording still reads')

  // A usage report carrying another agent's plan metadata changes nothing.
  let emitted = 0
  const bus = m.createBus()
  bus.on('agent.planUsage', () => emitted++)
  const session = { info: { agent: 'fx' } }
  m.SessionManager.prototype.onSessionUpdate.call(
    { bySessionId: () => session, agentKinds: new Map([['fx', KIND]]), bus },
    { sessionId: 's1', update: { sessionUpdate: 'usage_update', used: 1, size: 2, _meta: { '_claude/rateLimit': { status: 'rejected' } } } }
  )
  assert.equal(emitted, 0)
  assert.deepEqual(session.usage, { used: 1, size: 2 })
})
