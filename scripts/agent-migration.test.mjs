// Pure-fs tests for the agents.json → credential-store migration (no docker,
// no electron): legacy shapes lift into agent-token links, re-runs are no-ops,
// and a crash between the two writes heals without duplicating credentials.
//
//   node scripts/agent-migration.test.mjs
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-agent-migration-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

// gurtRoot is read from GURT_ROOT at module load — set it before the import.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-migration-'))
process.env.GURT_ROOT = GURT_ROOT

const entry = `
export { migrateAgentSecrets, getCredentials } from ${S('src/main/credentials.ts')}
export { getAgents } from ${S('src/main/store.ts')}
`

await build({
  stdin: { contents: entry, resolveDir: ROOT, loader: 'ts', sourcefile: 'entry.ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['electron'],
  outfile,
  logLevel: 'silent'
})

const m = await import(pathToFileURL(outfile).href)
const agentsPath = path.join(GURT_ROOT, 'agents.json')
const credsPath = path.join(GURT_ROOT, 'credentials.json')
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))

try {
  // --- legacy shapes lift into agent-token links ---
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
  await m.migrateAgentSecrets()

  const agents = readJson(agentsPath)
  const creds = readJson(credsPath).credentials
  assert.equal(creds.length, 2)
  assert.ok(creds.every((c) => c.kind === 'agent-token'))
  for (const a of Object.values(agents)) {
    assert.ok(!('secret' in a) && !('oauthToken' in a) && !('enabled' in a))
  }
  const bySecret = (s) => creds.find((c) => c.data.secret === s)
  assert.equal(agents['claude-code'].kind, 'claude-code') // kind lifted from the key
  assert.equal(agents['claude-code'].credentialId, bySecret('TOK-A').id)
  assert.equal(agents.work.credentialId, bySecret('TOK-B').id)
  assert.equal(agents.bare.credentialId, undefined)

  // --- idempotent: a second run writes nothing ---
  const before = { agents: fs.readFileSync(agentsPath, 'utf8'), creds: fs.readFileSync(credsPath, 'utf8') }
  await m.migrateAgentSecrets()
  assert.equal(fs.readFileSync(agentsPath, 'utf8'), before.agents)
  assert.equal(fs.readFileSync(credsPath, 'utf8'), before.creds)

  // --- crash-heal: credentials written but agents.json still legacy ---
  // (the failure window between the two writes). The re-run must link to the
  // already-stored entry, not push a duplicate.
  fs.writeFileSync(
    agentsPath,
    JSON.stringify({ 'claude-code': { kind: 'claude-code', label: 'claude code', enabled: true, secret: 'TOK-A' } })
  )
  await m.migrateAgentSecrets()
  const healedCreds = readJson(credsPath).credentials
  assert.equal(healedCreds.length, 2) // still two — TOK-A reused
  assert.equal(readJson(agentsPath)['claude-code'].credentialId, bySecret('TOK-A').id)

  // --- an existing credentialId wins over a stray inline secret ---
  fs.writeFileSync(
    agentsPath,
    JSON.stringify({ x: { kind: 'codex', label: 'x', credentialId: 'keep-me', secret: 'TOK-NEW' } })
  )
  await m.migrateAgentSecrets()
  assert.equal(readJson(agentsPath).x.credentialId, 'keep-me')
  assert.equal(readJson(credsPath).credentials.length, 2) // nothing new stored

  // --- no agents.json at all: nothing to do, nothing created ---
  fs.rmSync(agentsPath)
  await m.migrateAgentSecrets()
  assert.ok(!fs.existsSync(agentsPath))

  console.log('agent-migration.test: PASS')
} catch (e) {
  console.error('agent-migration.test: FAIL')
  console.error(e)
  process.exitCode = 1
} finally {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
}
