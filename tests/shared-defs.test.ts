// Pure-data tests for the small shared modules (no fs, no docker, no electron):
// key derivation, the per-kind default agent configs, and the sanity invariants
// of the AGENT_DEFS / MCP_DEFS registries.
import { it } from 'vitest'
import assert from 'node:assert/strict'
import { taskKey, envKey, connKey, mcpServerKey } from '../src/shared/keys'
import { defaultAgentConfig } from '../src/shared/agentConfig'
import { AGENT_DEFS, agentDef } from '../src/shared/agents'
import { MCP_DEFS, mcpDef } from '../src/shared/mcp'
import type { EnvRef } from '../src/shared/types'

// --- keys ------------------------------------------------------------------

const ref: EnvRef = { workspace: 'ws', task: 't', env: 'e1', session: 's1' }

it('taskKey / envKey: plain "/" joins in ws/task[/session] order', () => {
  assert.equal(taskKey('ws', 't'), 'ws/t')
  // the session (not the env definition) is the instance identity
  assert.equal(envKey(ref), 'ws/t/s1')
  assert.equal(envKey({ ...ref, env: 'other-env' }), 'ws/t/s1', 'env name is not part of the key')
})

it('connKey / mcpServerKey: envKey + "::" + discriminator', () => {
  assert.equal(connKey(ref, 'claude-code'), 'ws/t/s1::claude-code')
  assert.equal(mcpServerKey(ref, 'github'), 'ws/t/s1::github')
  // both are envKey-prefixed, so per-env teardown can match on the prefix
  assert.ok(connKey(ref, 'a').startsWith(envKey(ref) + '::'))
  assert.ok(mcpServerKey(ref, 'm').startsWith(envKey(ref) + '::'))
  assert.notEqual(connKey(ref, 'a'), connKey(ref, 'b'))
})

it('keys do not encode separators — segment safety is the store\'s name validation', () => {
  // Documented contract: names never contain "/" (store.validateName rejects
  // them), so the joins stay unambiguous. The derivation itself is a plain
  // template — assert that so an encoding change shows up as a test diff.
  assert.equal(taskKey('a/b', 'c'), 'a/b/c')
})

// --- defaultAgentConfig ----------------------------------------------------

it('defaultAgentConfig("claude-code"): model/effort/fast seed', () => {
  const cfg = defaultAgentConfig('claude-code')
  const byId = new Map(cfg.configOptions.map((o) => [o.id, o]))
  assert.deepEqual([...byId.keys()], ['model', 'effort', 'fast'])
  assert.equal(cfg.commands.length, 0)

  const model = byId.get('model')!
  assert.equal(model.type, 'select')
  assert.equal(model.currentValue, 'sonnet')
  // family aliases, not pinned IDs (the seed must not go stale on a model drop)
  const modelValues = (model.options ?? []).map((o) => o.value)
  assert.deepEqual(modelValues, ['opus', 'sonnet', 'fable', 'haiku'])

  const effort = byId.get('effort')!
  assert.equal(effort.currentValue, 'default')
  const fast = byId.get('fast')!
  assert.equal(fast.type, 'boolean')
  assert.equal(fast.currentValue, false)

  // every select's currentValue must be offered among its own options
  for (const o of cfg.configOptions)
    if (o.type === 'select')
      assert.ok(
        (o.options ?? []).some((opt) => opt.value === o.currentValue),
        `currentValue of "${o.id}" is a listed option`
      )
})

it('defaultAgentConfig returns a fresh deep copy every call', () => {
  const a = defaultAgentConfig('claude-code')
  const b = defaultAgentConfig('claude-code')
  assert.notEqual(a, b)
  assert.deepEqual(a, b)
  // mutating one copy must not leak into the next caller's seed
  a.configOptions[0].currentValue = 'opus'
  a.commands.push({ name: 'x', description: '' } as any)
  const c = defaultAgentConfig('claude-code')
  assert.equal(c.configOptions[0].currentValue, 'sonnet')
  assert.equal(c.commands.length, 0)
})

it('defaultAgentConfig: every registered kind yields a well-formed config', () => {
  for (const def of AGENT_DEFS) {
    const cfg = defaultAgentConfig(def.id)
    assert.ok(Array.isArray(cfg.configOptions), `${def.id}: configOptions is an array`)
    assert.ok(Array.isArray(cfg.commands), `${def.id}: commands is an array`)
  }
  // kinds without a hardcoded surface get the empty config
  assert.deepEqual(defaultAgentConfig('codex'), { configOptions: [], commands: [] })
  assert.deepEqual(defaultAgentConfig('opencode'), { configOptions: [], commands: [] })
})

it('defaultAgentConfig: unknown kind falls back to the empty config', () => {
  assert.deepEqual(defaultAgentConfig('no-such-kind'), { configOptions: [], commands: [] })
  assert.deepEqual(defaultAgentConfig(''), { configOptions: [], commands: [] })
})

// --- registry lookups ------------------------------------------------------

it('agentDef: known ids resolve to their def, unknown ids to undefined', () => {
  for (const def of AGENT_DEFS) assert.equal(agentDef(def.id), def)
  assert.equal(agentDef('no-such-agent'), undefined)
  assert.equal(agentDef(''), undefined)
})

it('mcpDef: known ids resolve to their def, unknown ids to undefined', () => {
  for (const def of MCP_DEFS) assert.equal(mcpDef(def.id), def)
  assert.equal(mcpDef('github')?.id, 'github')
  assert.equal(mcpDef('no-such-mcp'), undefined)
})

// --- registry invariants ---------------------------------------------------

it('AGENT_DEFS: unique ids, required fields non-empty', () => {
  assert.ok(AGENT_DEFS.length > 0)
  const ids = AGENT_DEFS.map((d) => d.id)
  assert.equal(new Set(ids).size, ids.length, 'agent ids are unique')
  for (const d of AGENT_DEFS) {
    assert.ok(d.id.trim(), 'id non-empty')
    assert.ok(d.label.trim(), `${d.id}: label non-empty`)
    assert.ok(d.bin.trim(), `${d.id}: bin non-empty`)
    assert.ok(d.secretEnv.trim(), `${d.id}: secretEnv non-empty`)
    assert.ok(Array.isArray(d.binArgs), `${d.id}: binArgs is an array`)
    assert.ok(d.adapterPackages.length > 0, `${d.id}: at least one adapter package`)
    assert.ok(
      d.adapterPackages.every((p) => p.trim()),
      `${d.id}: adapter packages non-empty`
    )
  }
})

it('MCP_DEFS: unique ids, well-formed tool lists', () => {
  assert.ok(MCP_DEFS.length > 0)
  const ids = MCP_DEFS.map((d) => d.id)
  assert.equal(new Set(ids).size, ids.length, 'mcp ids are unique')
  for (const d of MCP_DEFS) {
    assert.ok(d.id.trim() && d.label.trim() && d.description.trim(), `${d.id}: fields non-empty`)
    assert.ok(d.tools.length > 0, `${d.id}: at least one tool`)
    const names = d.tools.map((t) => t.name)
    assert.equal(new Set(names).size, names.length, `${d.id}: tool names unique`)
    for (const t of d.tools) {
      assert.ok(t.name.trim() && t.summary.trim(), `${d.id}/${t.name}: fields non-empty`)
      assert.equal(typeof t.write, 'boolean', `${d.id}/${t.name}: write flag is boolean`)
    }
    // read-only sessions drop the write tools — every server must keep at least
    // one tool in that mode, or attaching it read-only would be pointless
    assert.ok(
      d.tools.some((t) => !t.write),
      `${d.id}: at least one read-only tool survives read-only mode`
    )
  }
})
