// Agent token probes (src/main/agentProviders.ts,
// docs/requirements-first-run.md §7.3).
//
// The probe exists because `verifyTokens` in credentials.ts verifies a
// `git-token` against its forge and `continue`s past every other kind — so an
// `agent-token` has always been stored unverified, and a mistyped one surfaces
// minutes later as a provider auth error in a chat the user has not learned to
// read. This checks the one thing the probe must never get wrong and the one
// thing it must never do:
//
//   - **429 is `unreachable`, not `ok`.** `main/planUsage.ts` records that the
//     `/api/oauth/usage` edge answers even an *unauthenticated* request with
//     429. Reading that as acceptance would report a bad token as good, which
//     is the single wrong answer this file exists to prevent.
//   - **`unreachable` never blocks.** The probe runs on the host; a session
//     container's route out is its own proxy's. A corporate filter that blocks
//     this machine can sit next to a container that reaches the provider fine,
//     so a probe that cannot ask must not veto a setup that would have worked.
//
// No network: `fetch` is a parameter, exactly as `planUsage.ts` takes one.
//
//   node scripts/agent-providers.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-providers-'))
process.env.GURT_ROOT = GURT_ROOT

const outfile = path.join(os.tmpdir(), `gurt-providers-${process.pid}.mjs`)
await bundle({
  stdin: {
    contents: `
      export { probeAgentToken, canProbeAgentToken } from ${S('src/main/agentProviders.ts')}
      export { AGENT_DEFS } from ${S('src/shared/agents.ts')}
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

/** A fetch that answers every request with one status, recording what it saw. */
const answering = (status) => {
  const seen = []
  const fn = async (url, init) => {
    seen.push({ url, headers: init?.headers ?? {} })
    return { status, ok: status >= 200 && status < 300 }
  }
  fn.seen = seen
  return fn
}

// --- every supported kind ---------------------------------------------------

test('every agent kind gurt ships can be probed', () => {
  for (const def of m.AGENT_DEFS)
    assert.equal(m.canProbeAgentToken(def.id), true, `${def.id} has no provider`)
})

test('an accepted token is ok, for every kind', async () => {
  for (const def of m.AGENT_DEFS) {
    const res = await m.probeAgentToken(def.id, 'sk-test-token', answering(200))
    assert.equal(res.verdict, 'ok', def.id)
    assert.equal(res.detail, '', 'nothing to say about a token that works')
  }
})

test('each kind asks its own provider, authenticated the way that provider wants', async () => {
  const asked = {}
  for (const def of m.AGENT_DEFS) {
    const f = answering(200)
    await m.probeAgentToken(def.id, 'sk-test-token', f)
    asked[def.id] = f.seen[0]
  }
  assert.match(asked['claude-code'].url, /api\.anthropic\.com/)
  assert.match(asked['codex'].url, /api\.openai\.com/)
  assert.match(asked['gemini'].url, /generativelanguage\.googleapis\.com/)
  assert.match(asked['opencode'].url, /api\.anthropic\.com/)
  // The token never rides the query string, where a URL logged by anything
  // downstream would carry it.
  for (const [kind, req] of Object.entries(asked))
    assert.doesNotMatch(req.url, /sk-test-token/, `${kind} put the token in the URL`)
})

test('an OAuth token goes to the oauth surface, an API key to the public API', async () => {
  // An `sk-ant-oat…` token is not accepted by the published API, so asking the
  // wrong endpoint would report a perfectly good token as rejected.
  const oauth = answering(200)
  await m.probeAgentToken('claude-code', 'sk-ant-oat01-abc', oauth)
  assert.match(oauth.seen[0].url, /oauth\/usage/)
  assert.equal(oauth.seen[0].headers['Authorization'], 'Bearer sk-ant-oat01-abc')

  const apiKey = answering(200)
  await m.probeAgentToken('claude-code', 'sk-ant-api03-abc', apiKey)
  assert.match(apiKey.seen[0].url, /\/v1\/models/)
  assert.equal(apiKey.seen[0].headers['x-api-key'], 'sk-ant-api03-abc')
  assert.equal(apiKey.seen[0].headers['Authorization'], undefined)
})

// --- the three verdicts -----------------------------------------------------

test('401 and 403 are a refusal, and say which provider refused', async () => {
  for (const status of [401, 403]) {
    const res = await m.probeAgentToken('codex', 'bad', answering(status))
    assert.equal(res.verdict, 'rejected')
    assert.match(res.detail, /OpenAI/)
    assert.match(res.detail, new RegExp(String(status)))
    assert.match(res.detail, /paste it again/, 'says what to do about it')
  }
})

test('429 is unreachable — never ok, never rejected', async () => {
  // The documented behaviour of the /api/oauth/usage edge: it answers an
  // unauthenticated request with 429 rather than 401 (planUsage.ts). Calling
  // that "ok" is the one wrong answer; calling it "rejected" would refuse a
  // good token because the provider was busy.
  const res = await m.probeAgentToken('claude-code', 'sk-ant-oat01-abc', answering(429))
  assert.equal(res.verdict, 'unreachable')
  assert.match(res.detail, /rate limiting/)
})

test('a 5xx, an unknown status and a dead network are all unreachable', async () => {
  assert.equal((await m.probeAgentToken('gemini', 'k', answering(503))).verdict, 'unreachable')
  assert.equal((await m.probeAgentToken('gemini', 'k', answering(302))).verdict, 'unreachable')
  const dead = async () => {
    throw new Error('getaddrinfo ENOTFOUND api.example')
  }
  const res = await m.probeAgentToken('gemini', 'k', dead)
  assert.equal(res.verdict, 'unreachable')
  assert.match(res.detail, /continuing without checking/, 'a probe that cannot ask does not veto')
  assert.doesNotMatch(res.detail, /ENOTFOUND/, 'the sentence is for a user, not a stack')
})

test('a kind with no provider is unreachable, not a silent pass', async () => {
  const res = await m.probeAgentToken('some-future-agent', 'tok', answering(200))
  assert.equal(res.verdict, 'unreachable')
  assert.match(res.detail, /not verified/)
})

test('an empty token never reaches the network', async () => {
  const f = answering(200)
  const res = await m.probeAgentToken('codex', '   ', f)
  assert.equal(res.verdict, 'unreachable')
  assert.equal(f.seen.length, 0)
})
