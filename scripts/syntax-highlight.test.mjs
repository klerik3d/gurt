// Syntax tokenizing and its merge with word-level diff spans
// (docs/requirements-manual-review.md §2.2 / "As built"). Pure functions —
// no React, no DOM, no app.
//
//   node scripts/syntax-highlight.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-synhl-${process.pid}.mjs`)

await bundle({
  entryPoints: [path.join(ROOT, 'src/renderer/src/syntaxHighlight.ts')],
  outfile
})

const { tokenize, mergeSpans } = await import(pathToFileURL(outfile).href)

after(() => fs.rmSync(outfile, { force: true }))

const reconstruct = (spans) => spans.map((s) => s.text).join('')

// --- tokenize --------------------------------------------------------------
test('tokenize', () => {
  // No lang — the whole line is one unhighlighted span, the safe fallback.
  assert.deepEqual(tokenize('const a = 1', null), [{ text: 'const a = 1', cls: null }])

  // An unregistered language id is the same fallback, not a crash.
  assert.deepEqual(tokenize('const a = 1', 'not-a-real-language'), [
    { text: 'const a = 1', cls: null }
  ])

  // A real language tokenizes into scoped runs...
  const ts = tokenize('const a = 1', 'typescript')
  assert.ok(ts.length > 1, 'more than one run for a real language')
  assert.ok(
    ts.some((s) => s.cls?.includes('keyword') && s.text === 'const'),
    'the keyword is scoped as a keyword'
  )
  // ...and always reconstructs the exact input, whatever the language.
  assert.equal(reconstruct(ts), 'const a = 1', 'tokens reconstruct the line exactly')

  // Entities in the source text round-trip through hljs's escaping.
  const withEntities = tokenize('const s = "<a & b>"', 'typescript')
  assert.equal(reconstruct(withEntities), 'const s = "<a & b>"', 'HTML-special chars survive intact')

  // Multiple languages, spot-checked for at least one scoped token each.
  for (const [lang, src, mustInclude] of [
    ['python', 'def f():\n    return 1', 'def'],
    ['go', 'func main() {}', 'func'],
    ['json', '{"a": 1}', '"a"'],
    ['bash', 'echo "hi"', 'echo']
  ]) {
    const spans = tokenize(src, lang)
    assert.equal(reconstruct(spans), src, `${lang}: reconstructs exactly`)
    assert.ok(spans.some((s) => s.cls), `${lang}: at least one token is scoped`)
    assert.ok(reconstruct(spans).includes(mustInclude))
  }
})

// --- mergeSpans --------------------------------------------------------------
test('mergeSpans', () => {
  // No diff spans at all — degenerate merge (nothing to combine with).
  assert.deepEqual(mergeSpans([{ text: 'abc', cls: null }], []), [])

  // A single syntax span split by two diff spans: the syntax class carries
  // through, the diff's changed boundary is preserved exactly.
  const merged = mergeSpans(
    [{ text: 'const a = 1', cls: 'hljs-x' }],
    [
      { text: 'const a = ', changed: false },
      { text: '1', changed: true }
    ]
  )
  assert.deepEqual(merged, [
    { text: 'const a = ', cls: 'hljs-x', changed: false },
    { text: '1', cls: 'hljs-x', changed: true }
  ])
  assert.equal(reconstruct(merged), 'const a = 1')

  // A syntax boundary that falls mid-word against a single diff span splits
  // into two merged spans, both carrying the diff's changed flag.
  const split = mergeSpans(
    [
      { text: 'const ', cls: 'hljs-keyword' },
      { text: 'a', cls: 'hljs-title' }
    ],
    [{ text: 'const a', changed: true }]
  )
  assert.deepEqual(split, [
    { text: 'const ', cls: 'hljs-keyword', changed: true },
    { text: 'a', cls: 'hljs-title', changed: true }
  ])

  // Merging never drops or duplicates characters, whichever side has more
  // (finer) boundaries.
  const uneven = mergeSpans(
    [
      { text: 'ab', cls: 'x' },
      { text: 'cde', cls: 'y' },
      { text: 'f', cls: 'z' }
    ],
    [
      { text: 'a', changed: false },
      { text: 'bcd', changed: true },
      { text: 'ef', changed: false }
    ]
  )
  assert.equal(reconstruct(uneven), 'abcdef', 'uneven boundaries still reconstruct exactly')
})
