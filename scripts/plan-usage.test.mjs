// Tests for the plan-limit reader (src/shared/planUsage.ts + src/main/planUsage.ts).
//
// The endpoint this parses is unpublished, so the parser is written to be
// indifferent to nesting and the tests pin that indifference: the exact body
// shape is the one thing that could not be read off the CLI binary, and the
// cost of guessing it wrong has to stay at "no data", never "wrong data".
//
//   node scripts/plan-usage.test.mjs
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-plan-usage-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await build({
  stdin: {
    contents: [
      `export * from ${S('src/shared/planUsage.ts')}`,
      `export { createPlanUsage } from ${S('src/main/planUsage.ts')}`,
      `export { createBus } from ${S('src/main/bus.ts')}`
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  mainFields: ['module', 'main'],
  outfile,
  logLevel: 'silent'
})

const { parsePlanWindows, isOauthToken, tightest, createPlanUsage, createBus } = await import(
  pathToFileURL(outfile).href
)

// --- parsing: nesting must not matter ---------------------------------------
const FLAT = {
  five_hour: { utilization: 42, resets_at: '2026-08-19T18:00:00Z' },
  seven_day: { utilization: 13, resets_at: '2026-08-22T09:00:00Z' }
}
const NESTED = { rate_limits: FLAT }
const DEEPER = { data: { account: { rate_limits: FLAT } } }

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

{
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
}

{
  // A key we have no label for is kept, not dropped — it still carries a real
  // number, and inventing a reason to hide it would be the wrong default.
  const w = parsePlanWindows({ some_new_window: { utilization: 7 } })
  assert.equal(w.length, 1)
  assert.equal(w[0].id, 'some_new_window')
  assert.equal(w[0].label, 'some new window')
}

// --- the listed form: `limits[]` of self-describing entries (CLI 2.1.x) -----
{
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
}

{
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
}

{
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
}

{
  // Clamped for the meter, raw kept for the tooltip: if the field ever turns
  // out to be a 0-1 fraction, `raw` is what makes that visible.
  const w = parsePlanWindows({ five_hour: { utilization: 140 } })
  assert.equal(w[0].utilization, 100)
  assert.equal(w[0].raw, 140)
  const frac = parsePlanWindows({ five_hour: { utilization: 0.42 } })
  assert.equal(frac[0].raw, 0.42, 'a fractional report survives verbatim in raw')
}

for (const body of [null, undefined, {}, [], 'nope', 42, { five_hour: {} }, { five_hour: null }])
  assert.deepEqual(parsePlanWindows(body), [], `unreadable body yields no windows: ${JSON.stringify(body)}`)

{
  // Reset timestamps arrive in whatever form; seconds and milliseconds both.
  const secs = parsePlanWindows({ five_hour: { utilization: 1, resets_at: 1755624000 } })
  assert.equal(secs[0].resetsAt, new Date(1755624000_000).toISOString())
  const ms = parsePlanWindows({ five_hour: { utilization: 1, resets_at: 1755624000_000 } })
  assert.equal(ms[0].resetsAt, new Date(1755624000_000).toISOString())
  const bad = parsePlanWindows({ five_hour: { utilization: 1, resets_at: 'soon' } })
  assert.equal(bad[0].resetsAt, undefined, 'an unparseable reset is absent, not Invalid Date')
  assert.equal(bad[0].utilization, 1, 'and it does not cost us the utilization')
}

// --- token gate --------------------------------------------------------------
assert.ok(isOauthToken('sk-ant-oat01-abc'))
assert.ok(!isOauthToken('sk-ant-api03-abc'), 'an API key has no plan windows to ask about')
assert.ok(!isOauthToken(''))

assert.equal(tightest([]), undefined)
assert.equal(tightest(parsePlanWindows(FLAT)).id, 'five_hour', 'the fullest window is the one to show')

// --- the fetcher: rate floor and cache retention -----------------------------
const AGENTS = { work: { kind: 'claude-code', label: 'work', credentialId: 'c1' } }
const CREDS = [{ id: 'c1', kind: 'agent-token', label: 't', data: { secret: 'sk-ant-oat01-x' } }]

function harness({ responses }) {
  let calls = 0
  let clock = 1_000_000
  const store = createPlanUsage(createBus(), {
    agents: async () => AGENTS,
    credentials: async () => CREDS,
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

{
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
}

{
  // A 429 keeps the previous windows and records why — the same degradation
  // Claude Code's own /usage does rather than showing nothing.
  const h = harness({ responses: [{ body: FLAT }, { ok: false, status: 429 }] })
  await h.store.get()
  h.advance(61_000)
  const after = await h.store.get()
  assert.equal(after.work.windows.length, 2, 'last good read survives the failure')
  assert.match(after.work.error, /rate limited/)
  assert.ok(after.work.fetchedAt, 'and still says when that read was taken')
}

{
  // A 200 whose shape we cannot read must not blank the meters to zero.
  const h = harness({ responses: [{ body: FLAT }, { body: { unexpected: true } }] })
  await h.store.get()
  h.advance(61_000)
  const after = await h.store.get()
  assert.equal(after.work.windows.length, 2, 'a shape change is not an empty plan')
  assert.match(after.work.error, /shape/)
}

{
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
}

{
  // Other kinds never touch this endpoint at all.
  const store = createPlanUsage(createBus(), {
    agents: async () => ({ cx: { kind: 'codex', label: 'cx', credentialId: 'c1' } }),
    credentials: async () => CREDS,
    fetchImpl: async () => assert.fail('codex has no claude plan window')
  })
  assert.deepEqual(await store.get(), {})
}

console.log('plan-usage: ok')
