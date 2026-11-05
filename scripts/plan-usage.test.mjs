// Tests for the plan-limit reader (src/shared/planUsage.ts + src/main/planUsage.ts).
//
// The endpoint this parses is unpublished, so the parser is written to be
// indifferent to nesting and the tests pin that indifference: the exact body
// shape is the one thing that could not be read off the CLI binary, and the
// cost of guessing it wrong has to stay at "no data", never "wrong data".
//
//   node scripts/plan-usage.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-plan-usage-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await bundle({
  stdin: {
    contents: [
      `export * from ${S('src/shared/planUsage.ts')}`,
      // The window ids below are Anthropic's, timed by the claude-code plugin;
      // Codex windows carry their own duration.
      `import { windowElapsedPercent as elapsed } from ${S('src/shared/planUsage.ts')}`,
      `export const windowElapsedPercent = (window, now) => elapsed(window, now, 'claude-code')`,
      `export { createPlanUsage } from ${S('src/main/planUsage.ts')}`,
      `export { parsePlanWindows, parseClaudeRateLimit, parseClaudeRateLimitState, isOauthToken } from ${S('src/plugins/agents/claude-code/main.ts')}`,
      `export { parseCodexPlanWindows } from ${S('src/plugins/agents/codex/main.ts')}`,
      // A usage poll's overage, as each provider reports it: Anthropic's extra
      // usage (the claude-code plugin), Codex's credits (the codex plugin).
      `import { parseOverage as extraUsage } from ${S('src/plugins/agents/claude-code/main.ts')}`,
      `import { parseCreditsOverage } from ${S('src/plugins/agents/codex/main.ts')}`,
      `export const parseOverage = (body, codex) => (codex ? parseCreditsOverage(body) : extraUsage(body))`,
      // The limit detector below calls `withLimit` on a bare `this` for an agent
      // instance 'a'; it reads the session's wording through the manager's
      // kind map, so the bare manager maps 'a' to claude-code — whose replies
      // these are.
      `import { SessionManager as Sessions } from ${S('src/main/sessions.ts')}`,
      `export class SessionManager extends Sessions {`,
      `  withLimit(...args) {`,
      `    const manager = Object.assign(Object.create(Sessions.prototype), { agentKinds: new Map([['a', 'claude-code']]) })`,
      `    return Sessions.prototype.withLimit.apply(manager, args)`,
      `  }`,
      `}`,
      `export { createBus } from ${S('src/main/bus.ts')}`
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})

const { parseCodexPlanWindows, windowElapsedPercent, parsePlanWindows, parseClaudeRateLimit, parseClaudeRateLimitState, parseOverage, planHold, normalizeLimitSettings, LIMIT_DEFAULTS, SessionManager, isOauthToken, tightest, createPlanUsage, createBus } = await import(
  pathToFileURL(outfile).href
)

// Every other test file removes its esbuild bundle; this one used to leak it.
after(() => fs.rmSync(outfile, { force: true }))

// --- parsing: nesting must not matter ---------------------------------------
const FLAT = {
  five_hour: { utilization: 42, resets_at: '2026-08-19T18:00:00Z' },
  seven_day: { utilization: 13, resets_at: '2026-08-22T09:00:00Z' }
}
const NESTED = { rate_limits: FLAT }
const DEEPER = { data: { account: { rate_limits: FLAT } } }

test('parsing: nesting must not matter', () => {
  for (const [name, body] of [
    ['flat', FLAT],
    ['nested', NESTED],
    ['deeper', DEEPER]
  ]) {
    const w = parsePlanWindows(body)
    assert.equal(w.length, 2, `${name}: found both windows`)
    assert.equal(w[0].id, 'five_hour', `${name}: session window first`)
    assert.equal(w[0].utilization, 42)
    assert.equal(w[0].label, 'Current session')
    assert.equal(w[0].resetsAt, '2026-08-19T18:00:00.000Z')
    assert.equal(w[1].id, 'seven_day')
  }
})

test('declared order wins over reported order', () => {
  // Declared order wins over reported order, so the meters don't reshuffle
  // between polls.
  const w = parsePlanWindows({
    seven_day_sonnet: { utilization: 5 },
    five_hour: { utilization: 1 },
    seven_day_opus: { utilization: 9 },
    seven_day: { utilization: 2 }
  })
  assert.deepEqual(
    w.map((x) => x.id),
    ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']
  )
})

test('a window key with no label is kept, not dropped', () => {
  // A key we have no label for is kept, not dropped — it still carries a real
  // number, and inventing a reason to hide it would be the wrong default.
  const w = parsePlanWindows({ some_new_window: { utilization: 7 } })
  assert.equal(w.length, 1)
  assert.equal(w[0].id, 'some_new_window')
  assert.equal(w[0].label, 'some new window')
})

// --- the listed form: `limits[]` of self-describing entries (CLI 2.1.x) -----
test('the listed form: `limits[]` of self-describing entries', () => {
  // The newer bodies report windows as a list, keyed by `kind`, with the old
  // top-level keys arriving null — and model-scoped weeks exist ONLY here.
  const w = parsePlanWindows({
    five_hour: null,
    seven_day: null,
    limits: [
      { kind: 'five_hour', group: 'g', percent: 84, resets_at: '2026-08-19T17:30:00Z' },
      { kind: 'seven_day', group: 'g', percent: 40, resets_at: '2026-08-20T23:00:00Z' },
      {
        kind: 'weekly_scoped',
        group: 'g',
        percent: 12,
        resets_at: '2026-08-20T23:00:00Z',
        scope: { model: { display_name: 'Fable' } }
      }
    ]
  })
  assert.deepEqual(
    w.map((x) => x.id),
    ['five_hour', 'seven_day', 'weekly_scoped:Fable']
  )
  assert.equal(w[0].label, 'Current session')
  assert.equal(w[0].utilization, 84)
  assert.equal(w[0].resetsAt, '2026-08-19T17:30:00.000Z')
  assert.equal(w[1].label, 'Current week (all models)')
  assert.equal(w[2].label, 'Current week (Fable)', 'the scope name rides into the label')
  assert.equal(w[2].utilization, 12)
})

test('both shapes at once: the keyed window wins its id', () => {
  // Both shapes at once: the keyed window wins its id, the list fills the rest.
  const w = parsePlanWindows({
    five_hour: { utilization: 42, resets_at: '2026-08-19T18:00:00Z' },
    limits: [
      { kind: 'five_hour', percent: 99 },
      { kind: 'weekly_scoped', percent: 5, scope: { surface: { display_name: 'apps' } } }
    ]
  })
  assert.equal(w.length, 2, 'the same window never draws twice')
  assert.equal(w[0].id, 'five_hour')
  assert.equal(w[0].utilization, 42, 'keyed form wins over the list entry')
  assert.equal(w[1].id, 'weekly_scoped:apps')
  assert.equal(w[1].label, 'Current week (apps)', 'a surface scope labels like a model scope')
})

test('a null figure is skipped, never drawn as 0%', () => {
  // A window the plan has but is not metering arrives with a null figure — it
  // must be skipped, never drawn as 0%.
  const w = parsePlanWindows({
    five_hour: { utilization: null, resets_at: '2026-08-19T18:00:00Z' },
    limits: [{ kind: 'seven_day', percent: 7, resets_at: null }]
  })
  assert.deepEqual(
    w.map((x) => x.id),
    ['seven_day']
  )
  assert.equal(w[0].resetsAt, undefined, 'a null reset stays absent')
})

test('utilization is clamped for the meter, raw kept for the tooltip', () => {
  // Clamped for the meter, raw kept for the tooltip: if the field ever turns
  // out to be a 0-1 fraction, `raw` is what makes that visible.
  const w = parsePlanWindows({ five_hour: { utilization: 140 } })
  assert.equal(w[0].utilization, 100)
  assert.equal(w[0].raw, 140)
  const frac = parsePlanWindows({ five_hour: { utilization: 0.42 } })
  assert.equal(frac[0].raw, 0.42, 'a fractional report survives verbatim in raw')
})

test('an unreadable body yields no windows', () => {
  for (const body of [null, undefined, {}, [], 'nope', 42, { five_hour: {} }, { five_hour: null }])
    assert.deepEqual(parsePlanWindows(body), [], `unreadable body yields no windows: ${JSON.stringify(body)}`)
})

test('reset timestamps: seconds, milliseconds and unparseable', () => {
  // Reset timestamps arrive in whatever form; seconds and milliseconds both.
  const secs = parsePlanWindows({ five_hour: { utilization: 1, resets_at: 1755624000 } })
  assert.equal(secs[0].resetsAt, new Date(1755624000_000).toISOString())
  const ms = parsePlanWindows({ five_hour: { utilization: 1, resets_at: 1755624000_000 } })
  assert.equal(ms[0].resetsAt, new Date(1755624000_000).toISOString())
  const bad = parsePlanWindows({ five_hour: { utilization: 1, resets_at: 'soon' } })
  assert.equal(bad[0].resetsAt, undefined, 'an unparseable reset is absent, not Invalid Date')
  assert.equal(bad[0].utilization, 1, 'and it does not cost us the utilization')
})

// --- token gate --------------------------------------------------------------
test('token gate', () => {
  assert.ok(isOauthToken('sk-ant-oat01-abc'))
  assert.ok(!isOauthToken('sk-ant-api03-abc'), 'an API key has no plan windows to ask about')
  assert.ok(!isOauthToken(''))

  assert.equal(tightest([]), undefined)
  assert.equal(tightest(parsePlanWindows(FLAT)).id, 'five_hour', 'the fullest window is the one to show')
})

// --- the fetcher: rate floor and cache retention -----------------------------
const AGENTS = { work: { kind: 'claude-code', label: 'work', credentialId: 'c1' } }
const CREDS = [{ id: 'c1', kind: 'agent-token', label: 't', data: { secret: 'sk-ant-oat01-x' } }]
const OAUTH_CREDS = [{ id: 'c1', kind: 'oauth', label: 't', data: {
  access: 'sk-ant-oat01-x', refresh: 'refresh', providerId: 'anthropic'
} }]

function harness({ responses }) {
  let calls = 0
  let clock = 1_000_000
  const store = createPlanUsage(createBus(), {
    agents: async () => AGENTS,
    credentials: async () => OAUTH_CREDS,
    now: () => clock,
    fetchImpl: async () => {
      const r = responses[Math.min(calls++, responses.length - 1)]
      return {
        ok: r.ok !== false,
        status: r.status ?? 200,
        json: async () => r.body
      }
    }
  })
  return { store, calls: () => calls, advance: (ms) => (clock += ms) }
}

test('the fetcher: rate floor and cache retention', async () => {
  const h = harness({ responses: [{ body: FLAT }] })
  const first = await h.store.get()
  assert.equal(h.calls(), 1)
  assert.equal(first.work.windows.length, 2)
  assert.ok(first.work.fetchedAt)

  // Inside the floor, repeated reads are served from cache — the dashboard
  // polling must not become a request per render.
  await h.store.get()
  await h.store.get()
  assert.equal(h.calls(), 1, 'no second call inside the rate floor')

  h.advance(61_000)
  await h.store.get()
  assert.equal(h.calls(), 2, 'past the floor it polls again')
})

test('a 429 keeps the previous windows and records why', async () => {
  // A 429 keeps the previous windows and records why — the same degradation
  // Claude Code's own /usage does rather than showing nothing.
  const h = harness({ responses: [{ body: FLAT }, { ok: false, status: 429 }] })
  await h.store.get()
  h.advance(61_000)
  const after = await h.store.get()
  assert.equal(after.work.windows.length, 2, 'last good read survives the failure')
  assert.match(after.work.error, /rate limited/)
  assert.ok(after.work.fetchedAt, 'and still says when that read was taken')
})

test('an unreadable 200 shape does not blank the meters', async () => {
  // A 200 whose shape we cannot read must not blank the meters to zero.
  const h = harness({ responses: [{ body: FLAT }, { body: { unexpected: true } }] })
  await h.store.get()
  h.advance(61_000)
  const after = await h.store.get()
  assert.equal(after.work.windows.length, 2, 'a shape change is not an empty plan')
  assert.match(after.work.error, /shape/)
})

test('an API-key agent is skipped outright', async () => {
  // An API-key agent is skipped outright rather than collecting 401s.
  const store = createPlanUsage(createBus(), {
    agents: async () => ({ api: { kind: 'claude-code', label: 'api', credentialId: 'k' } }),
    credentials: async () => [
      { id: 'k', kind: 'agent-token', label: 'k', data: { secret: 'sk-ant-api03-x' } }
    ],
    fetchImpl: async () => assert.fail('must not call the endpoint with an API key')
  })
  const out = await store.get()
  assert.match(out.api.error, /no subscription token/)
})

test('other kinds never touch this endpoint at all', async () => {
  // Other kinds never touch this endpoint at all.
  const store = createPlanUsage(createBus(), {
    agents: async () => ({ cx: { kind: 'codex', label: 'cx', credentialId: 'c1' } }),
    credentials: async () => CREDS,
    fetchImpl: async () => assert.fail('codex has no claude plan window')
  })
  assert.deepEqual((await store.get()).cx.windows, [])
})

// Captured from a successful setup-token probe on 2026-10-22.
const LIVE_LIMIT = {
  status: 'allowed', resetsAt: 1792673400, rateLimitType: 'five_hour',
  overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled',
  isUsingOverage: false,
  unifiedWindows: {
    five_hour: { utilization: 0.7, resetsAt: 1792673400 },
    seven_day: { utilization: 0.41, resetsAt: 1793044800 }
  }
}

test('SDK fractions have explicit units, including zero, one and small values', () => {
  const windows = parseClaudeRateLimit(LIVE_LIMIT)
  assert.equal(windows[0].utilization, 70)
  assert.equal(windows[0].raw, 0.7)
  assert.equal(windows[0].resetsAt, new Date(1792673400 * 1000).toISOString())
  assert.equal(windows[1].utilization, 41)
  for (const raw of [0, 0.001, 1, 1.2]) {
    const [w] = parseClaudeRateLimit({ rateLimitType: 'five_hour', utilization: raw })
    assert.equal(w.utilization, Math.min(100, raw * 100))
  }
  for (const body of [null, {}, { status: 'allowed' }, {
    unifiedWindows: { five_hour: { utilization: '0.7' }, seven_day: { utilization: -1 } }
  }]) assert.deepEqual(parseClaudeRateLimit(body), [])
  assert.equal(parsePlanWindows({ five_hour: { utilization: 0.7 } })[0].utilization, 0.7,
    'endpoint percentages are never treated as SDK fractions')
})

test('ACP usage metadata reaches dashboard cache with a token and no profile poll', async () => {
  const bus = createBus()
  let changed = 0
  bus.on('usage.changed', () => changed++)
  let clock = 1792660000000
  const store = createPlanUsage(bus, {
    agents: async () => AGENTS,
    credentials: async () => CREDS,
    now: () => clock,
    fetchImpl: async () => assert.fail('setup-token must not call the profile endpoint')
  })
  assert.deepEqual((await store.get()).work.windows, [])
  const session = { info: { agent: 'work' } }
  const manager = {
    bySessionId: () => session,
    agentKinds: new Map([['work', 'claude-code']]),
    bus
  }
  const update = (metadata) => SessionManager.prototype.onSessionUpdate.call(manager, {
    sessionId: 's1', update: {
      sessionUpdate: 'usage_update', used: 100, size: 200000, _meta: metadata
    }
  })
  update({ '_claude/rateLimit': LIVE_LIMIT })
  const first = (await store.get()).work
  assert.deepEqual(first.windows.map((w) => w.utilization), [70, 41])
  assert.equal(first.error, undefined)
  assert.equal(first.fetchedAt, new Date(clock).toISOString())
  assert.equal(changed, 1)
  assert.deepEqual(session.usage, { used: 100, size: 200000 })
  clock += 180000
  update({ '_claude/rateLimit': { status: 'allowed' } })
  update(null)
  assert.deepEqual((await store.get()).work, first, 'missing data preserves last known limits')
  manager.agentKinds.set('work', 'codex')
  update({ '_claude/rateLimit': LIVE_LIMIT })
  assert.equal(changed, 1, 'metadata on other agent kinds cannot update Claude limits')
})

test('an in-flight profile poll cannot overwrite a newer session snapshot', async () => {
  const bus = createBus()
  let release
  const response = new Promise((resolve) => { release = resolve })
  const store = createPlanUsage(bus, {
    agents: async () => AGENTS, credentials: async () => OAUTH_CREDS,
    fetchImpl: async () => response
  })
  const pending = store.get()
  // Let agent/credential resolution reach the pending network request.
  await new Promise((resolve) => setImmediate(resolve))
  bus.emit('agent.planUsage', { agent: 'work', windows: parseClaudeRateLimit(LIVE_LIMIT) })
  release({ ok: false, status: 403 })
  const result = (await pending).work
  assert.equal(result.windows[0].utilization, 70)
  assert.equal(result.error, undefined)
})


test('window time progress uses duration and clamps at window boundaries', () => {
  const reset = Date.parse('2026-10-22T12:00:00Z')
  const window = { id: 'five_hour', resetsAt: new Date(reset).toISOString() }
  assert.equal(windowElapsedPercent(window, reset - 2.5 * 60 * 60_000), 50)
  assert.equal(windowElapsedPercent(window, reset - 6 * 60 * 60_000), 0)
  assert.equal(windowElapsedPercent(window, reset + 60_000), 100)
  for (const id of ['seven_day', 'seven_day_sonnet', 'weekly_scoped']) {
    assert.equal(windowElapsedPercent({ ...window, id }, reset - 3.5 * 24 * 60 * 60_000), 50)
  }
  assert.equal(windowElapsedPercent({ ...window, id: 'extra_usage' }, reset), undefined)
  assert.equal(windowElapsedPercent({ id: 'five_hour' }, reset), undefined)
  assert.equal(windowElapsedPercent({ ...window, resetsAt: 'invalid' }, reset), undefined)
})


const CODEX_USAGE = { rate_limit: {
  primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_at: 1792760000 },
  secondary_window: { used_percent: 0.7, limit_window_seconds: 604800, reset_at: 1793000000 }
}, code_review_rate_limit: { primary_window: { used_percent: 99, limit_window_seconds: 604800, reset_at: 1793000000 } } }
const CODEX_CREDS = [{ id: 'cx-login', kind: 'oauth', label: 'ChatGPT', data: {
  providerId: 'openai', access: 'old-access', refresh: 'refresh', accountId: 'old-account'
} }]
const CODEX_AGENTS = { cx: { kind: 'codex', label: 'Codex', credentialId: 'cx-login' } }

test('Codex quota percentages, durations and resets remain provider-reported', () => {
  const windows = parseCodexPlanWindows(CODEX_USAGE)
  assert.deepEqual(windows.map((w) => [w.id, w.label, w.utilization]), [
    ['codex_primary', '5h', 42], ['codex_secondary', 'week', 0.7]
  ])
  assert.equal(windows[0].resetsAt, new Date(1792760000000).toISOString())
  assert.equal(windowElapsedPercent(windows[0], 1792760000000 - 9000000), 50)
  const [short] = parseCodexPlanWindows({ rate_limit: { primary_window: {
    used_percent: 25, limit_window_seconds: 900, reset_at: 1792760000
  } } })
  assert.equal(short.label, '15m')
  assert.equal(windowElapsedPercent(short, 1792760000000 - 450000), 50)
})

test('Codex missing or malformed data never becomes zero usage or a guessed duration', () => {
  for (const body of [null, {}, { rate_limit: null }, { rate_limit: { primary_window: { used_percent: '42' } } },
    { rate_limit: { primary_window: { used_percent: -1 } } }]) assert.deepEqual(parseCodexPlanWindows(body), [])
  const [partial] = parseCodexPlanWindows({ rate_limit: { primary_window: { used_percent: 0 } } })
  assert.equal(partial.utilization, 0)
  assert.equal(partial.durationSeconds, undefined)
  assert.equal(windowElapsedPercent(partial, Date.now()), undefined)
  const [invalid] = parseCodexPlanWindows({ rate_limit: { primary_window: {
    used_percent: 120, limit_window_seconds: -1, reset_at: 1e100
  } } })
  assert.equal(invalid.utilization, 100)
  assert.equal(invalid.resetsAt, undefined)
  assert.equal(invalid.durationSeconds, undefined)
})

test('Codex OAuth providerId reaches polling, refreshes auth and retains last good limits', async () => {
  let clock = 1792700000000
  let calls = 0
  let refreshes = 0
  let response = Response.json(CODEX_USAGE)
  const store = createPlanUsage(createBus(), {
    agents: async () => CODEX_AGENTS, credentials: async () => CODEX_CREDS, now: () => clock,
    freshCredential: async (id) => {
      assert.equal(id, 'cx-login'); refreshes++
      return { ...CODEX_CREDS[0], data: { ...CODEX_CREDS[0].data, access: 'fresh-access', accountId: 'fresh-account' } }
    },
    fetchImpl: async (url, init) => {
      calls++
      assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage')
      assert.equal(init.headers.Authorization, 'Bearer fresh-access')
      assert.equal(init.headers['ChatGPT-Account-Id'], 'fresh-account')
      assert.equal(init.headers['anthropic-beta'], undefined)
      return response
    }
  })
  const [first] = await Promise.all([store.get(), store.get()])
  assert.equal(calls, 1)
  assert.equal(first.cx.windows.length, 2)
  await store.get()
  assert.equal(refreshes, 1)
  clock += 61000
  response = Response.json({ rate_limit: null })
  assert.deepEqual((await store.get()).cx.windows, first.cx.windows)
  clock += 61000
  response = new Response(null, { status: 429, headers: { 'Retry-After': '120' } })
  const failed = (await store.get()).cx
  assert.deepEqual(failed.windows, first.cx.windows)
  assert.equal(failed.fetchedAt, first.cx.fetchedAt)
  assert.match(failed.error, /rate limited/)
  clock += 61000
  await store.get()
  assert.equal(calls, 3, 'Retry-After stops another poll')
})

test('Codex refresh failures stop requests and API keys / other OAuth providers are never polled', async () => {
  const store = createPlanUsage(createBus(), {
    agents: async () => CODEX_AGENTS, credentials: async () => CODEX_CREDS,
    freshCredential: async () => { throw new Error('sign in again') },
    fetchImpl: async () => assert.fail('failed refresh must not send an expired token')
  })
  assert.match((await store.get()).cx.error, /sign in again/)
  for (const entry of [
    { ...CODEX_CREDS[0], kind: 'agent-token', data: { secret: 'api-key' } },
    { ...CODEX_CREDS[0], data: { ...CODEX_CREDS[0].data, providerId: 'anthropic', provider: 'openai' } },
    { ...CODEX_CREDS[0], data: { ...CODEX_CREDS[0].data, signedOut: 'true' } }
  ]) {
    const skip = createPlanUsage(createBus(), {
      agents: async () => CODEX_AGENTS, credentials: async () => [entry],
      fetchImpl: async () => assert.fail('ineligible credential must not be sent to Codex')
    })
    assert.deepEqual((await skip.get()).cx.windows, [])
  }
})


test('Codex signed-out credential preserves the actionable sign-in error', async () => {
  const store = createPlanUsage(createBus(), {
    agents: async () => CODEX_AGENTS,
    credentials: async () => [{ ...CODEX_CREDS[0], data: { ...CODEX_CREDS[0].data, signedOut: 'true' } }],
    fetchImpl: async () => assert.fail('signed-out credential must not be sent')
  })
  assert.match((await store.get()).cx.error, /sign in again in Credentials/)
})

// --- the launch gate (planHold) ---------------------------------------------

const NOW = Date.parse('2026-11-03T12:00:00Z')
const iso = (ms) => new Date(ms).toISOString()
const usage = (windows, extra = {}) => ({
  agent: 'a', windows, fetchedAt: iso(NOW - 60_000), ...extra
})
const win = (id, utilization, resetIn) => ({
  id, label: id, utilization, raw: utilization,
  ...(resetIn === undefined ? {} : { resetsAt: iso(NOW + resetIn) })
})

test('a window at the threshold holds the account until it resets', () => {
  const hold = planHold([usage([win('five_hour', 96, 3_600_000), win('seven_day', 40, 86_400_000)])], 95, NOW)
  assert.deepEqual(hold, { until: iso(NOW + 3_600_000), reason: 'five_hour 96%' })
  assert.equal(planHold([usage([win('five_hour', 94, 3_600_000)])], 95, NOW), undefined, 'below it, nothing')
})

test('every full window has to clear: the hold lasts until the latest reset', () => {
  const hold = planHold([usage([win('five_hour', 100, 3_600_000), win('seven_day', 99, 86_400_000)])], 95, NOW)
  assert.equal(hold.until, iso(NOW + 86_400_000))
  assert.equal(hold.reason, 'five_hour 100%', 'named after the fullest one')
})

test('a reset that has passed lifts the hold before any fresh read', () => {
  assert.equal(planHold([usage([win('five_hour', 100, -1)])], 95, NOW), undefined)
})

test('a window with no reset holds only while its read is fresh, and has no known end', () => {
  assert.deepEqual(planHold([usage([win('codex_primary', 97)])], 95, NOW), { reason: 'codex_primary 97%' })
  const stale = usage([win('codex_primary', 97)], { fetchedAt: iso(NOW - 2 * 60 * 60_000) })
  assert.equal(planHold([stale], 95, NOW), undefined)
})

test('extra usage / credits lift the hold; the extra-usage meter itself never holds', () => {
  assert.equal(planHold([usage([win('five_hour', 100, 3_600_000)], { overage: true })], 95, NOW), undefined)
  assert.equal(planHold([usage([win('extra_usage', 100, 3_600_000)])], 95, NOW), undefined)
})

test('a stated refusal holds whatever the windows say, overage included', () => {
  const refused = usage([win('five_hour', 10, 3_600_000)], { overage: true, rejectedUntil: iso(NOW + 600_000) })
  assert.deepEqual(planHold([refused], 95, NOW), { until: iso(NOW + 600_000), reason: 'limit reached' })
  assert.equal(planHold([{ ...refused, rejectedUntil: iso(NOW - 1) }], 95, NOW), undefined, 'and ends on time')
})

test('pooled over an account: the freshest read speaks for every instance on it', () => {
  const old = usage([win('five_hour', 100, 3_600_000)], { agent: 'a1', fetchedAt: iso(NOW - 10 * 60_000) })
  // OpenAI resets early: the newer poll says the window is empty again.
  const fresh = usage([win('five_hour', 3, 3_600_000)], { agent: 'a2', fetchedAt: iso(NOW - 60_000) })
  assert.equal(planHold([old, fresh], 95, NOW), undefined)
  assert.ok(planHold([old], 95, NOW), 'the old read alone would hold')
  // A refusal recorded through any instance holds them all.
  assert.ok(planHold([fresh, { agent: 'a1', windows: [], rejectedUntil: iso(NOW + 1000) }], 95, NOW))
})

test('limit settings are coerced and clamped', () => {
  assert.deepEqual(normalizeLimitSettings(null), LIMIT_DEFAULTS)
  assert.equal(normalizeLimitSettings({ thresholdPercent: 12 }).thresholdPercent, 50)
  assert.equal(normalizeLimitSettings({ thresholdPercent: 250 }).thresholdPercent, 100)
  assert.equal(normalizeLimitSettings({ thresholdPercent: '90' }, { thresholdPercent: 80 }).thresholdPercent, 80)
})

test('a live event says whether it was refused and whether overage absorbs a full window', () => {
  const allowed = parseClaudeRateLimitState(LIVE_LIMIT)
  assert.equal(allowed.windows.length, 2)
  assert.equal(allowed.rejected, false)
  assert.equal(allowed.overage, false, "overageStatus 'rejected' is no overage")
  assert.equal(allowed.rejectedUntil, undefined)
  const refused = parseClaudeRateLimitState({ ...LIVE_LIMIT, status: 'rejected', overageStatus: 'allowed' })
  assert.equal(refused.rejected, true)
  assert.equal(refused.overage, true)
  assert.equal(refused.rejectedUntil, new Date(1792673400 * 1000).toISOString())
  assert.deepEqual(parseClaudeRateLimitState(null), { windows: [] })
})

test('overage from a usage poll: Anthropic extra usage, Codex credits', () => {
  assert.equal(parseOverage({ extra_usage: { is_enabled: true, utilization: 20 } }, false), true)
  assert.equal(parseOverage({ extra_usage: { is_enabled: true, utilization: null } }, false), true)
  assert.equal(parseOverage({ extra_usage: { is_enabled: true, utilization: 100 } }, false), false, 'spent')
  assert.equal(parseOverage({ extra_usage: { is_enabled: false } }, false), false)
  assert.equal(parseOverage({ five_hour: {} }, false), false)
  assert.equal(parseOverage({ credits: { has_credits: true } }, true), true)
  assert.equal(parseOverage({ credits: { has_credits: false, unlimited: false } }, true), false)
  assert.equal(parseOverage({}, true), false)
})

test('a live refusal reaches the cache; the next allowed response clears it, and silence changes nothing', async () => {
  const bus = createBus()
  let changed = 0
  bus.on('usage.changed', () => changed++)
  const store = createPlanUsage(bus, { agents: async () => ({}), credentials: async () => [] })
  bus.emit('agent.planUsage', { agent: 'w', windows: [], rejected: true, rejectedUntil: iso(NOW) })
  assert.equal(store.peek(['w'])[0].rejectedUntil, iso(NOW))
  bus.emit('agent.planUsage', { agent: 'w', windows: [], rejected: false })
  assert.equal(store.peek(['w'])[0].rejectedUntil, undefined)
  bus.emit('agent.planUsage', { agent: 'w', windows: [], rejected: false })
  assert.equal(changed, 2, 'a response that changes nothing is not news')
  bus.emit('agent.limited', { agent: 'w', until: iso(NOW + 5) })
  assert.equal(store.peek(['w', 'missing']).length, 1)
  assert.equal(store.peek(['w'])[0].rejectedUntil, iso(NOW + 5))
})

// --- the limit detector (SessionManager.withLimit) ---------------------------

/** @param {{ stopReason?: string, threw: boolean }} [outcome] @param {string} [detail] */
const detect = (s, outcome = { stopReason: 'end_turn', threw: false }, detail = undefined) =>
  SessionManager.prototype.withLimit.call({}, { info: { id: 's', agent: 'a' }, turnRejected: false, ...s }, outcome, detail, 10)

test('a short limit notice as the whole reply is a limit hit, however the turn ended', () => {
  const hit = detect({ entries: [{ id: 10, kind: 'agent', text: "You've hit your session limit · resets 3pm" }] })
  assert.ok(hit.limit, 'Claude Code answers a refused turn with plain text and end_turn')
  const stamped = detect({ entries: [{ id: 11, kind: 'agent', text: 'Claude AI usage limit reached|1792673400' }] })
  assert.equal(stamped.limit.resetAt, new Date(1792673400 * 1000).toISOString(), 'the stamp after the pipe is the reset')
})

test('the agent talking about rate limits is not a limit hit', () => {
  assert.equal(detect({ entries: [{ id: 10, kind: 'agent', text: 'Added rate limiting (429 on burst) to the API.' }] }).limit, undefined)
  assert.equal(
    detect({ entries: [{ id: 3, kind: 'agent', text: "You've hit your session limit" }] }).limit,
    undefined,
    'an earlier turn’s reply is not this turn’s'
  )
})

test('a refused live event or a limit-worded error is a limit hit', () => {
  assert.ok(detect({ entries: [], turnRejected: true }).limit)
  assert.ok(detect({ entries: [] }, { threw: true }, 'Error: rate_limit_error: usage limit reached').limit)
  assert.equal(detect({ entries: [] }, { threw: true }, 'ECONNRESET').limit, undefined)
})
