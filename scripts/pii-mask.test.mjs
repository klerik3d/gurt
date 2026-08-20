// PII/secret masking (docs/requirements-pii-mask.md), without a network, a
// docker daemon or an agent: what the per-source adapters pull out of each
// upstream format, and what the masker guarantees at the ACP seam — encode →
// decode is identity, the token grammar is stable, and one session's tokens are
// undecodable by another.
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
      `export { PII_TOKEN_RE, builtinDetector, ibanValid, luhnValid, piiConfigError, resolveSpans, splitPendingToken } from ${S('src/shared/pii.ts')}`,
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

for (const [type, value] of Object.entries(SAMPLES)) {
  const real = `please look at ${value} and report back`
  const encoded = await mask.encode('s1', real)
  assert.ok(!encoded.includes(value), `${type}: the real value never reaches the agent`)
  assert.match(encoded, new RegExp(`<${type}:[A-Za-z0-9_-]+>`), `${type}: token carries its type`)
  assert.equal(mask.decode('s1', encoded), real, `${type}: round trip is identity`)
}

// Token grammar (§3): `<TYPE:base64url>`, and stable — the same value always
// encodes to the same token within a session, so the agent can tell that two
// mentions are the same person.
{
  const encoded = await mask.encode('s1', `${SAMPLES.EMAIL} and again ${SAMPLES.EMAIL}`)
  const tokens = [...encoded.matchAll(new RegExp(m.PII_TOKEN_RE.source, 'g'))].map((x) => x[0])
  assert.equal(tokens.length, 2)
  assert.equal(tokens[0], tokens[1], 'one value, one token')
  assert.equal(await mask.encode('s1', SAMPLES.EMAIL), tokens[0], 'stable across calls too')
  assert.match(tokens[0], /^<EMAIL:[A-Za-z0-9_-]+>$/, 'base64url only — never < > or :')
}

// Text that already carries a token is left alone: re-encoding would bury the
// real value one layer deeper on every round trip.
{
  const once = await mask.encode('s1', `ping ${SAMPLES.IP_ADDRESS}`)
  assert.equal(await mask.encode('s1', once), once, 'tokens are not re-encoded')
  assert.equal(mask.decode('s1', once), `ping ${SAMPLES.IP_ADDRESS}`)
}

// §8.2: session-key isolation — two sessions never decode each other's tokens.
{
  const a = await mask.encode('s1', SAMPLES.US_SSN)
  const b = await mask.encode('s2', SAMPLES.US_SSN)
  assert.notEqual(a, b, 'same value, different session keys, different tokens')
  assert.equal(mask.decode('s2', a), a, "s2 cannot read s1's token — it is left verbatim")
  assert.equal(mask.decode('s1', b), b, 'and the other way round')
  assert.equal(mask.decode('s1', a), SAMPLES.US_SSN)
  assert.equal(mask.decode('s2', b), SAMPLES.US_SSN)

  // A token cannot be re-labelled and still decode: the type is bound into the
  // ciphertext as additional data.
  const relabelled = a.replace('<US_SSN:', '<EMAIL:')
  assert.equal(mask.decode('s1', relabelled), relabelled)

  // §3's consequence, made explicit: the key is in-memory only, so dropping the
  // session makes its tokens permanently opaque.
  mask.drop('s1')
  assert.equal(mask.decode('s1', a), a)
}

// §2.1 across a streamed answer: ACP chops the agent's reply into chunks with
// no regard for our grammar, so a token can straddle two. The tail of a chunk
// that might still become a token is held back until it can be decoded whole —
// the halves must never show up in the chat.
{
  const token = await mask.encode('s5', SAMPLES.EMAIL)
  const answer = `mail ${token} today`
  for (let cut = 1; cut < answer.length; cut++) {
    const [readyA, pendingA] = m.splitPendingToken(answer.slice(0, cut))
    const [readyB, pendingB] = m.splitPendingToken(pendingA + answer.slice(cut))
    assert.equal(pendingB, '', 'a completed stream holds nothing back')
    assert.equal(
      mask.decode('s5', readyA) + mask.decode('s5', readyB),
      `mail ${SAMPLES.EMAIL} today`,
      `split at ${cut}: the two chunks decode to the whole answer`
    )
  }
  // Ordinary prose that merely starts with `<` is not held hostage.
  assert.deepEqual(m.splitPendingToken('see <div> below'), ['see <div> below', ''])
  assert.deepEqual(m.splitPendingToken('a < b'), ['a < b', ''])
  assert.deepEqual(m.splitPendingToken('done <EMAIL'), ['done ', '<EMAIL'])
  assert.deepEqual(m.splitPendingToken(`<X:${'a'.repeat(600)}`)[1], '', 'the hold-back is bounded')
}

// Decoding does not depend on the current settings — a session that was masked
// keeps its key, so turning masking off never leaves raw tokens in the chat.
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
