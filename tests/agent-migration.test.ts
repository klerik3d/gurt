// Pure-fs tests for the agents.json → credential-store migration (no docker,
// no electron): legacy shapes lift into agent-token links, re-runs are no-ops,
// and a crash between the two writes heals without duplicating credentials.
import { afterAll, it } from 'vitest'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

// gurtRoot is read from GURT_ROOT at module load — set it before the import.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-migration-'))
process.env.GURT_ROOT = GURT_ROOT
const { migrateAgentSecrets } = await import('../src/main/credentials')

const agentsPath = path.join(GURT_ROOT, 'agents.json')
const credsPath = path.join(GURT_ROOT, 'credentials.json')
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'))
const bySecret = (s: string) => readJson(credsPath).credentials.find((c: any) => c.data.secret === s)

afterAll(() => {
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

it('legacy shapes lift into agent-token links', async () => {
  // pre-registry per-kind entry (oauthToken, no kind) + an instance with an
  // inline secret + an enabled-only entry with no secret.
  fs.writeFileSync(
    agentsPath,
    JSON.stringify({
      'claude-code': { enabled: true, oauthToken: 'TOK-A' },
      work: { kind: 'codex', label: 'codex work', enabled: false, secret: 'TOK-B' },
      bare: { kind: 'opencode', label: 'no secret', enabled: true }
    })
  )
  await migrateAgentSecrets()

  const agents = readJson(agentsPath)
  const creds = readJson(credsPath).credentials
  assert.equal(creds.length, 2)
  assert.ok(creds.every((c: any) => c.kind === 'agent-token'))
  for (const a of Object.values(agents) as any[]) {
    assert.ok(!('secret' in a) && !('oauthToken' in a) && !('enabled' in a))
  }
  assert.equal(agents['claude-code'].kind, 'claude-code') // kind lifted from the key
  assert.equal(agents['claude-code'].credentialId, bySecret('TOK-A').id)
  assert.equal(agents.work.credentialId, bySecret('TOK-B').id)
  assert.equal(agents.bare.credentialId, undefined)
})

it('idempotent: a second run writes nothing', async () => {
  const before = { agents: fs.readFileSync(agentsPath, 'utf8'), creds: fs.readFileSync(credsPath, 'utf8') }
  await migrateAgentSecrets()
  assert.equal(fs.readFileSync(agentsPath, 'utf8'), before.agents)
  assert.equal(fs.readFileSync(credsPath, 'utf8'), before.creds)
})

it('crash-heal: credentials written but agents.json still legacy', async () => {
  // (the failure window between the two writes). The re-run must link to the
  // already-stored entry, not push a duplicate.
  fs.writeFileSync(
    agentsPath,
    JSON.stringify({ 'claude-code': { kind: 'claude-code', label: 'claude code', enabled: true, secret: 'TOK-A' } })
  )
  await migrateAgentSecrets()
  assert.equal(readJson(credsPath).credentials.length, 2) // still two — TOK-A reused
  assert.equal(readJson(agentsPath)['claude-code'].credentialId, bySecret('TOK-A').id)
})

it('an existing credentialId wins over a stray inline secret', async () => {
  fs.writeFileSync(
    agentsPath,
    JSON.stringify({ x: { kind: 'codex', label: 'x', credentialId: 'keep-me', secret: 'TOK-NEW' } })
  )
  await migrateAgentSecrets()
  assert.equal(readJson(agentsPath).x.credentialId, 'keep-me')
  assert.equal(readJson(credsPath).credentials.length, 2) // nothing new stored
})

it('no agents.json at all: nothing to do, nothing created', async () => {
  fs.rmSync(agentsPath)
  await migrateAgentSecrets()
  assert.ok(!fs.existsSync(agentsPath))
})
