// PII/secret masking (docs/requirements-pii-mask.md), without a network, a
// docker daemon or an agent: what the per-source adapters pull out of each
// upstream format, and what the masker guarantees at the ACP seam — encode →
// reveal is identity, the `[type:N]` grammar is stable, the table is durable and
// private to its session, and it ends with the session.
//
// The pattern cache is seeded on disk instead of fetched: `~/.gurt/pii-patterns`
// is exactly the file `refreshSource` would have written, so the masker runs the
// real built-in-detector path and the test still never touches the network.
//
//   node scripts/pii-mask.test.mjs
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// GURT_ROOT must be set before the store module loads (read at import time).
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-pii-'))
process.env.GURT_ROOT = GURT_ROOT

const outfile = path.join(os.tmpdir(), `gurt-pii-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await build({
  stdin: {
    contents:
      `export { createPiiMask } from ${S('src/main/pii.ts')}\n` +
      `export { adaptSource, toJsRegex } from ${S('src/main/piiSources.ts')}\n` +
      `export { PII_TOKEN_RE, builtinDetector, emptyPiiTable, ibanValid, luhnValid, piiConfigError, piiType, resolveSpans, revealTokens } from ${S('src/shared/pii.ts')}`,
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

const m = await import(pathToFileURL(outfile).href)

// --- §4.1: the per-source adapters ------------------------------------------
// Fixtures are the upstream formats verbatim in shape (a Python module's
// `re.compile` calls, a recognizer class, `[[rules]]` blocks) — small enough to
// read, faithful enough that a parser that passes here parses the real file.

const COMMONREGEX_FIXTURE = `# coding: utf-8
import re

date  = re.compile('[0-3]?\\d[-\\./][0-3]?\\d[-\\./]\\d{2,4}', re.IGNORECASE)
email = re.compile("([a-z0-9._%+-]+@(?:[a-z0-9-]+\\\\.)+[a-z]{2,})", re.IGNORECASE)
ssn   = re.compile('(?!000|666)[0-9]{3}[- ][0-9]{2}[- ][0-9]{4}')
ipv6  = re.compile('\\s*(?!.*::.*::)[0-9a-f:]+\\s*', re.VERBOSE|re.IGNORECASE)
po_box = re.compile(r'P\\.? ?O\\.? Box \\d+', re.IGNORECASE)
`

{
  const { patterns, skipped } = m.adaptSource('commonregex', { 'commonregex.py': COMMONREGEX_FIXTURE })
  const byName = Object.fromEntries(patterns.map((p) => [p.name, p]))
  assert.deepEqual(
    patterns.map((p) => p.type).sort(),
    ['EMAIL', 'LOCATION', 'US_SSN'],
    'only the mapped variable names become patterns'
  )
  assert.equal(byName.email.flags, 'i', 're.IGNORECASE becomes the i flag')
  assert.ok(!byName.date, 'a date is not identifying on its own — deliberately unmapped')
  assert.equal(skipped, 1, 're.VERBOSE has no JS equivalent, so ipv6 is counted as skipped')
  // A raw literal keeps its backslashes; a plain one collapses `\\\\` to `\\`.
  assert.ok(new RegExp(byName.po_box.regex, 'i').test('P.O. Box 1234'))
  assert.ok(new RegExp(byName.email.regex, 'i').test('a.b@example.com'))
}

const PRESIDIO_FIXTURE = `from presidio_analyzer import Pattern, PatternRecognizer


class UsSsnRecognizer(PatternRecognizer):
    """Recognize US SSN using regex."""

    PATTERNS = [
        Pattern("SSN4 (very weak)", r"\\b[0-9]{9}\\b", 0.05),
        Pattern(
            "SSN5 (medium)",
            r"\\b([0-9]{3})[- .]"
            r"([0-9]{2})[- .]([0-9]{4})\\b",
            0.5,
        ),
    ]

    def __init__(
        self,
        supported_language: str = "en",
        supported_entity: str = "US_SSN",
    ):
        pass
`

{
  const { patterns } = m.adaptSource('presidio-recognizers', { 'us_ssn_recognizer.py': PRESIDIO_FIXTURE })
  assert.equal(patterns.length, 1, "presidio's very-weak tier needs a context enhancer we do not run")
  assert.equal(patterns[0].type, 'US_SSN', 'the entity comes from the supported_entity default')
  assert.ok(
    new RegExp(patterns[0].regex).test('123-45-6789'),
    'adjacent literals are one regex (Python implicit concatenation)'
  )
}

const GITLEAKS_FIXTURE = `title = "gitleaks config"

[[rules]]
id = "aws-access-token"
description = "AWS"
regex = '''(?:A3T[A-Z0-9]|AKIA)[A-Z0-9]{16}'''
keywords = ["akia"]

  [[rules.allowlists]]
  regexes = ['''EXAMPLE''']

[[rules]]
id = "generic-api-key"
regex = '''(?i)api[_-]?key["'\\s:=]{1,5}([a-z0-9]{32})'''
`

{
  const { patterns } = m.adaptSource('gitleaks', { 'gitleaks.toml': GITLEAKS_FIXTURE })
  assert.deepEqual(
    patterns.map((p) => p.type),
    ['AWS_ACCESS_TOKEN', 'GENERIC_API_KEY'],
    'the rule id is the entity type; an allowlist sub-block is not a rule'
  )
  assert.equal(patterns[1].flags, 'i', 'a leading (?i) becomes a real flag')
  assert.ok(new RegExp(patterns[0].regex).test('AKIAIOSFODNN7EXAMPLE'))
}

assert.equal(m.toJsRegex('(?x) a b c'), null, 'verbose mode cannot be translated')
assert.equal(m.toJsRegex('(?P<year>\\d{4})').regex, '(?<year>\\d{4})', "Python's named groups are rewritten")

// --- §4: checksums ----------------------------------------------------------

assert.ok(m.luhnValid('4111 1111 1111 1111'))
assert.ok(!m.luhnValid('4111 1111 1111 1112'))
assert.ok(m.ibanValid('DE89 3704 0044 0532 0130 00'))
assert.ok(!m.ibanValid('DE89 3704 0044 0532 0130 01'))

// --- the masker -------------------------------------------------------------
// One pattern per sample type, in gurt's own cache shape — i.e. what the
// adapters above would have produced from a fetched source.

const PATTERNS = [
  { type: 'EMAIL', regex: '[a-z0-9._%+-]+@(?:[a-z0-9-]+\\.)+[a-z]{2,}', flags: 'i' },
  { type: 'PHONE_NUMBER', regex: '\\b\\d{3}-\\d{3}-\\d{4}\\b' },
  { type: 'US_SSN', regex: '\\b\\d{3}-\\d{2}-\\d{4}\\b' },
  { type: 'CREDIT_CARD', regex: '\\b(?:\\d{4}[- ]?){3}\\d{4}\\b' },
  { type: 'IP_ADDRESS', regex: '\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b' },
  { type: 'AWS_ACCESS_KEY', regex: '\\bAKIA[A-Z0-9]{16}\\b' }
]

const seedCache = () => {
  fs.mkdirSync(path.join(GURT_ROOT, 'pii-patterns'), { recursive: true })
  fs.writeFileSync(
    path.join(GURT_ROOT, 'pii-patterns', 'commonregex.json'),
    JSON.stringify({
      source: 'commonregex',
      ref: 'test-fixture',
      fetchedAt: new Date(0).toISOString(),
      raw: {},
      patterns: PATTERNS,
      skipped: 0
    })
  )
}
const writeSettings = (settings) =>
  fs.writeFileSync(path.join(GURT_ROOT, 'pii.json'), JSON.stringify(settings))

const noCredentials = { credentials: async () => [] }

// §5.1: nothing is masked while no backend is selected — that *is* "off", and
// it is what the New Session chip renders as "disabled, here is why".
{
  writeSettings({})
  const mask = m.createPiiMask(noCredentials)
  await mask.load()
  assert.equal(mask.ready(), false, 'no backend selected = off')
  assert.match(mask.status().reason, /no detector backend/)
  assert.equal(await mask.encode('s1', 'mail me at a@b.com'), 'mail me at a@b.com', 'off masks nothing')
}

// A backend selected but its source never fetched is also not ready — §4.1's
// offline / first-run state, surfaced as configuration, not as a silent no-op.
{
  writeSettings({ backend: 'built-in', source: 'commonregex' })
  const mask = m.createPiiMask(noCredentials)
  await mask.load()
  assert.equal(mask.ready(), false)
  assert.match(mask.status().reason, /never been fetched/)
}

seedCache()
writeSettings({ backend: 'built-in', source: 'commonregex' })

const mask = m.createPiiMask(noCredentials)
await mask.load()
assert.equal(mask.ready(), true, 'a fetched source makes the built-in backend usable')
assert.equal(mask.status().sources.commonregex.patterns, PATTERNS.length)

// §8.2: encode → decode is identity, for a sample of every entity type.
const SAMPLES = {
  EMAIL: 'jane.doe@example.com',
  PHONE_NUMBER: '415-555-0198',
  US_SSN: '123-45-6789',
  CREDIT_CARD: '4111 1111 1111 1111',
  IP_ADDRESS: '10.1.2.3',
  AWS_ACCESS_KEY: 'AKIAIOSFODNN7EXAMPLE'
}

const tableFile = (id) => path.join(GURT_ROOT, 'pii-tables', `${id}.json`)

for (const [type, value] of Object.entries(SAMPLES)) {
  const real = `please look at ${value} and report back`
  const encoded = await mask.encode('s1', real)
  assert.ok(!encoded.includes(value), `${type}: the real value never reaches the agent`)
  assert.match(encoded, new RegExp(`\\[${type.toLowerCase()}:\\d+\\]`), `${type}: token carries its type`)
  assert.equal(mask.decode('s1', encoded), real, `${type}: round trip is identity`)
}

// Token grammar (§3): `[type:N]`, ordinals per type in order of first sight, and
// stable — the same value always encodes to the same token within a session, so
// the agent can tell that two mentions are the same person.
{
  const first = await mask.encode('g1', `${SAMPLES.EMAIL} and again ${SAMPLES.EMAIL}`)
  assert.equal(first, '[email:1] and again [email:1]', 'one value, one token')
  assert.equal(await mask.encode('g1', SAMPLES.EMAIL), '[email:1]', 'stable across calls too')
  assert.equal(await mask.encode('g1', 'bob@example.com'), '[email:2]', 'next value, next ordinal')
  assert.equal(await mask.encode('g1', 'JANE.DOE@EXAMPLE.COM'), '[email:1]', 'mail addresses ignore case')
  assert.equal(await mask.encode('g1', SAMPLES.US_SSN), '[us_ssn:1]', 'ordinals count per type')
  assert.deepEqual(
    [...first.matchAll(new RegExp(m.PII_TOKEN_RE.source, 'g'))].map((x) => [x[1], x[2]]),
    [['email', '1'], ['email', '1']],
    'the shared regex finds both'
  )
  assert.equal(m.piiType('AWS Access-Key'), 'aws_access_key')
  assert.equal(m.piiType('9lives'), 'x_9lives')
}

// The table is the whole mechanism, so it has to be right on disk: the §-3
// file shape, readable by nobody but the owner, holding the reals the text no
// longer does.
{
  const file = tableFile('g1')
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(onDisk, {
    v: 1,
    tokens: {
      email: { 1: SAMPLES.EMAIL, 2: 'bob@example.com' },
      us_ssn: { 1: SAMPLES.US_SSN }
    }
  })
  if (process.platform !== 'win32')
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'owner-only: it holds the reals')
}

// Text that already carries a token is left alone: it already means something,
// and a detector firing inside one must not invent a second row for it.
{
  const once = await mask.encode('s1', `ping ${SAMPLES.IP_ADDRESS}`)
  assert.equal(await mask.encode('s1', once), once, 'tokens are not re-encoded')
  assert.equal(mask.decode('s1', once), `ping ${SAMPLES.IP_ADDRESS}`)
}

// Reveal: unknown tokens stay verbatim, and a token the agent URL-encoded into a
// link still resolves (to the encoded real value).
{
  const table = { v: 1, tokens: { email: { 1: 'a+b@example.com' } } }
  assert.equal(m.revealTokens('mail [email:1] or [email:9]', table), 'mail a+b@example.com or [email:9]')
  assert.equal(m.revealTokens('x [note:2] y', table), 'x [note:2] y', 'prose that merely looks like a token')
  assert.equal(
    m.revealTokens('https://x.test/?to=%5Bemail%3A1%5D', table),
    `https://x.test/?to=${encodeURIComponent('a+b@example.com')}`
  )
  assert.equal(m.revealTokens('[email:1]', undefined), '[email:1]', 'no table, no change')
  assert.equal(m.revealTokens('[email:1]', m.emptyPiiTable()), '[email:1]')
}

// §8.2: isolation — two sessions never share a table. Each starts counting at 1,
// and one session's ordinal means nothing in the other.
{
  const a = await mask.encode('i1', `${SAMPLES.US_SSN} and 999-88-7777`)
  const b = await mask.encode('i2', '111-22-3333')
  assert.equal(a, '[us_ssn:1] and [us_ssn:2]')
  assert.equal(b, '[us_ssn:1]', 'same ordinal, different session, different value')
  assert.equal(mask.decode('i1', '[us_ssn:1]'), SAMPLES.US_SSN)
  assert.equal(mask.decode('i2', '[us_ssn:1]'), '111-22-3333')
  assert.equal(mask.decode('i2', '[us_ssn:2]'), '[us_ssn:2]', "i2 has no row 2 — it is left verbatim")
  assert.equal(mask.table('i1').tokens.us_ssn['2'], '999-88-7777')
}

// Durability — the point of a file over a key in memory: a fresh process (a
// second manager over the same disk) still reveals what the first one wrote.
{
  const again = m.createPiiMask(noCredentials)
  await again.load()
  assert.equal(again.decode('g1', '[email:2] / [us_ssn:1]'), `bob@example.com / ${SAMPLES.US_SSN}`)
  // And it keeps counting where the first left off, never reusing an ordinal.
  assert.equal(await again.encode('g1', 'carol@example.com'), '[email:3]')
}

// The change hook fires once per encode that added rows, with the whole table —
// and not at all for text that only repeats what the table already holds.
{
  const seen = []
  const watched = m.createPiiMask(noCredentials)
  await watched.load()
  watched.onTable((id, table) => seen.push([id, structuredClone(table)]))
  await watched.encode('w1', 'no pii here')
  assert.equal(seen.length, 0, 'nothing found, nothing to announce')
  await watched.encode('w1', SAMPLES.EMAIL)
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0], ['w1', { v: 1, tokens: { email: { 1: SAMPLES.EMAIL } } }])
  await watched.encode('w1', `again ${SAMPLES.EMAIL}`)
  assert.equal(seen.length, 1, 'a repeat adds no row')
}

// §3: the table lives and dies with the session.
{
  assert.ok(fs.existsSync(tableFile('i1')))
  mask.drop('i1')
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(!fs.existsSync(tableFile('i1')), 'dropping the session removes its table')
  assert.equal(mask.decode('i1', '[us_ssn:1]'), '[us_ssn:1]', 'and its tokens stop meaning anything')
}

// Decoding does not depend on the current settings — a session that was masked
// keeps its table, so turning masking off never leaves raw tokens behind.
{
  const token = await mask.encode('s3', SAMPLES.EMAIL)
  await mask.setSettings({})
  assert.equal(mask.ready(), false)
  assert.equal(mask.decode('s3', token), SAMPLES.EMAIL, 'old tokens still decode')
  assert.equal(await mask.encode('s3', SAMPLES.EMAIL), SAMPLES.EMAIL, 'but nothing new is encoded')
}

// Nothing false-positives on ordinary code: the detector only fires on the
// patterns the chosen source actually carries.
{
  writeSettings({ backend: 'built-in', source: 'commonregex' })
  const m2 = m.createPiiMask(noCredentials)
  await m2.load()
  const code = 'const timeout = 12345; retry(3, () => fetch(url))'
  assert.equal(await m2.encode('s4', code), code)
}

// The shared verdict the renderer gates its chip on agrees with the manager's.
assert.equal(m.piiConfigError({ backend: 'built-in', source: 'commonregex' }, {}, undefined) !== undefined, true)
assert.equal(
  m.piiConfigError({ backend: 'presidio', presidioMode: 'remote' }, {}, 'https://analyzer.example'),
  undefined,
  'a remote analyzer resolves through the linked credential url'
)

fs.rmSync(GURT_ROOT, { recursive: true, force: true })
fs.rmSync(outfile, { force: true })
console.log('pii-mask.test.mjs: ok')
