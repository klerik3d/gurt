// The built-in agent registry (docs/requirements-agent-plugins.md §4, §9.4).
//
// What the plugin lists may never drift on, because something outside the code
// already depends on it:
//
//   - **The ids are persisted formats.** A kind is stored as
//     `AgentInstance.kind` in agents.json, in the turn ledger, and is the key
//     of the legacy agents.json layout; renaming one orphans every instance of
//     it. The order is the order every picker lists them in, and the first is
//     the default kind.
//   - **A manifest is data.** It must come back from `JSON.parse(JSON.stringify
//     (m))` unchanged — the later phase that loads manifests from files can
//     only load what JSON can say, so anything that needs code has to be a
//     hook already.
//   - **The two halves agree.** A main half pairs with the manifest of its id,
//     and a sign-in a manifest names is one a main half declares, under the
//     same provider id credentials.json stores.
//
//   node scripts/agent-plugins.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

// The oauth engine pulls in the credential store, which reads GURT_ROOT at load.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-agent-plugins-'))
process.env.GURT_ROOT = GURT_ROOT

const outfile = path.join(os.tmpdir(), `gurt-agent-plugins-${process.pid}.mjs`)
await bundle({
  stdin: {
    contents: `
      export { AGENT_PLUGINS } from ${S('src/plugins/agents/index.ts')}
      export { AGENT_MAIN_PLUGINS } from ${S('src/plugins/agents/main.ts')}
      export { AGENT_MANIFESTS, DEFAULT_AGENT_KIND, assertAgentManifests } from ${S('src/shared/agents.ts')}
      export { assertAgentMains } from ${S('src/main/agentPlugins.ts')}
      export { OAUTH_PROVIDER_CHOICES } from ${S('src/shared/credentials.ts')}
      export { OAUTH_PROVIDERS } from ${S('src/main/oauth/index.ts')}
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

const manifests = m.AGENT_PLUGINS.map((p) => p.manifest)

test('the ids are the persisted set, in the persisted order', () => {
  assert.deepEqual(
    manifests.map((d) => d.id),
    ['claude-code', 'codex', 'gemini', 'opencode', 'pi']
  )
  assert.equal(new Set(manifests.map((d) => d.id)).size, manifests.length, 'ids are unique')
  assert.equal(m.DEFAULT_AGENT_KIND, 'claude-code', 'the first entry is the default kind')
  assert.deepEqual(m.AGENT_MANIFESTS, manifests, 'the core reads exactly the list')
})

test('every manifest survives a JSON round trip unchanged', () => {
  for (const d of manifests) assert.deepEqual(JSON.parse(JSON.stringify(d)), d, `${d.id} is not plain data`)
})

test('every regex a manifest carries compiles, and a tool title names server and tool', () => {
  for (const d of manifests) {
    const sources = [
      ...(d.toolTitles ?? []),
      ...(d.limits?.errors ?? []),
      ...(d.limits?.replies ?? []),
      ...(d.limits?.resetStamps ?? []),
      ...(d.planWindows?.durations ?? []).map((x) => x.match)
    ]
    for (const src of sources) assert.doesNotThrow(() => new RegExp(src), `${d.id}: ${src}`)
    for (const src of d.toolTitles ?? [])
      assert.ok(new RegExp(`${src}|`).exec('').length - 1 >= 2, `${d.id}: ${src} needs two groups`)
    for (const src of d.limits?.resetStamps ?? [])
      assert.ok(new RegExp(`${src}|`).exec('').length - 1 >= 1, `${d.id}: ${src} needs a group`)
  }
})

test('every main half pairs with a manifest, in registry order', () => {
  const ids = manifests.map((d) => d.id)
  const mains = m.AGENT_MAIN_PLUGINS.map((p) => p.id)
  for (const id of mains) assert.ok(ids.includes(id), `main half "${id}" has no manifest`)
  assert.deepEqual(mains, ids.filter((id) => mains.includes(id)), 'main halves follow the shared order')
  assert.equal(new Set(mains).size, mains.length, 'one main half per kind')
})

test('a sign-in a manifest names is declared by that kind, under the stored provider id', () => {
  for (const d of manifests) {
    const main = m.AGENT_MAIN_PLUGINS.find((p) => p.id === d.id)
    assert.equal(!!d.signIn, d.oauthProvider !== null, `${d.id}: signIn exactly when oauthProvider`)
    if (d.oauthProvider) assert.equal(main?.oauth?.client.id, d.oauthProvider, `${d.id} declares its own sign-in`)
    else assert.equal(main?.oauth, undefined, `${d.id} has no sign-in path, so declares none`)
  }
  // The ids credentials.json already holds — renaming one signs every user out.
  assert.deepEqual(Object.keys(m.OAUTH_PROVIDERS), ['anthropic', 'openai', 'google'])
  assert.deepEqual(m.OAUTH_PROVIDER_CHOICES, [
    { id: 'anthropic', label: 'Claude (Anthropic)' },
    { id: 'openai', label: 'ChatGPT (OpenAI)' },
    { id: 'google', label: 'Gemini (Google)' }
  ])
})

test('a registry that cannot be read unambiguously is refused at load', () => {
  assert.doesNotThrow(() => m.assertAgentManifests(manifests))
  assert.doesNotThrow(() => m.assertAgentMains(manifests, m.AGENT_MAIN_PLUGINS))

  const kind = (id, extra = {}) => ({
    id, label: id, vendor: 'v', adapterPackages: [], bin: id, binArgs: [], secretEnv: 'K',
    oauthProvider: null, skillsDir: null, historyPaths: [], ...extra
  })
  const signingIn = (id, provider) => kind(id, { oauthProvider: provider, signIn: { account: id, label: id } })
  const oauth = (provider) => ({ client: { id: provider }, account: () => '' })

  // The shared half: one plugin per kind, and a sign-in always has a name.
  assert.throws(() => m.assertAgentManifests([kind('a'), kind('b'), kind('a')]), /kind "a" is declared twice/)
  assert.throws(() => m.assertAgentManifests([kind('a', { oauthProvider: 'p' })]), /exactly when/)
  assert.throws(() => m.assertAgentManifests([kind('a', { signIn: { account: 'A', label: 'A' } })]), /exactly when/)

  // The main half: lines up with the manifests, one sign-in per provider id.
  assert.throws(() => m.assertAgentMains([kind('a')], [{ id: 'a' }, { id: 'a' }]), /two main halves/)
  assert.throws(() => m.assertAgentMains([kind('a')], [{ id: 'b' }]), /"b" has no manifest/)
  assert.throws(
    () => m.assertAgentMains([signingIn('a', 'p'), signingIn('b', 'p')], [{ id: 'a', oauth: oauth('p') }, { id: 'b', oauth: oauth('p') }]),
    /sign-in "p" is declared twice/
  )
  assert.throws(() => m.assertAgentMains([signingIn('a', 'p')], [{ id: 'a', oauth: oauth('q') }]), /declares sign-in "q"/)
  assert.throws(() => m.assertAgentMains([signingIn('a', 'p')], [{ id: 'a' }]), /names sign-in "p", which no main half declares/)
})
