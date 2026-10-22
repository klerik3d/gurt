import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-client-config-'))
process.env.GURT_ROOT = root
const outfile = path.join(root, 'test.mjs')
await bundle({
  stdin: {
    contents: `export * from './src/shared/clientConfig';
      export { getAgents, setAgents, liftAgent } from './src/main/store';`,
    resolveDir: process.cwd(), loader: 'ts'
  },
  external: ['electron'], outfile
})
const m = await import(pathToFileURL(outfile).href)
after(() => fs.rmSync(root, { recursive: true, force: true }))

test('rejects non-object config and invalid JSON; blank means reset', () => {
  for (const text of ['null', '[]', 'true', '42', '"text"', '{broken']) {
    assert.throws(() => m.parseClientConfig(text))
  }
  assert.deepEqual(m.parseClientConfig('  '), {})
})

test('native configs survive storage and reset without losing credential links', async () => {
  const agents = {
    claude: { kind: 'claude-code', label: 'Claude', credentialId: 'key1', config: m.clientConfigExample('claude-code') },
    router: { kind: 'opencode', label: 'Router', secretEnv: 'OPENROUTER_API_KEY', config: m.clientConfigExample('opencode') },
    pi: { kind: 'pi', label: 'Pi', secretEnv: 'OPENROUTER_API_KEY', config: m.clientConfigExample('pi') },
    legacy: { kind: 'claude-code', label: 'Legacy' }
  }
  await m.setAgents(agents)
  const loaded = await m.getAgents()
  assert.deepEqual(loaded, agents)
  const claude = m.clientConfigFile(loaded.claude.kind, loaded.claude.config)
  assert.equal(claude.path, '.claude/settings.json')
  assert.equal(JSON.parse(claude.content).attribution.commit, '')
  const router = m.clientConfigFile(loaded.router.kind, loaded.router.config)
  assert.equal(router.path, '.config/opencode/opencode.json')
  assert.equal(JSON.parse(router.content).provider.openrouter.options.apiKey, '{env:OPENROUTER_API_KEY}')
  assert.equal(m.clientConfigFile(loaded.legacy.kind, loaded.legacy.config), undefined)
  const pi = m.clientConfigFile(loaded.pi.kind, loaded.pi.config)
  assert.equal(pi.path, '.pi/agent/settings.json')
  assert.deepEqual(JSON.parse(pi.content), { defaultProvider: 'openrouter', defaultModel: 'anthropic/claude-sonnet-4.5' })
  loaded.pi.config = m.parseClientConfig('')
  loaded.claude.config = m.parseClientConfig('')
  await m.setAgents(loaded)
  const reset = (await m.getAgents()).claude
  assert.deepEqual((await m.getAgents()).pi.config, {})
  assert.equal(reset.credentialId, 'key1')
  assert.deepEqual(JSON.parse(m.clientConfigFile(reset.kind, reset.config).content), {})
  await assert.rejects(m.setAgents({ bad: { kind: 'opencode', label: 'bad', config: [] } }))
  await assert.rejects(m.setAgents({ bad: { kind: 'codex', label: 'bad', config: {} } }))
  assert.deepEqual(await m.getAgents(), loaded, 'invalid writes leave saved profiles intact')
})
