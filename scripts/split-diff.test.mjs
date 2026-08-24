// Split-diff alignment and folding (docs/requirements-manual-review.md §2.2):
// what makes the two panes line up, what gets word-highlighted, and which
// unchanged runs collapse. Pure functions — no React, no app, no git.
//
//   node scripts/split-diff.test.mjs
import { test, after } from 'node:test'
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-splitdiff-${process.pid}.mjs`)

await build({
  entryPoints: [path.join(ROOT, 'src/renderer/src/splitDiff.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  mainFields: ['module', 'main'],
  outfile,
  logLevel: 'silent',
  sourcemap: 'inline'
})

const { alignRows, foldRows, groupBlocks, CONTEXT } = await import(pathToFileURL(outfile).href)

after(() => fs.rmSync(outfile, { force: true }))

/** Compact row rendering: `<before>|<after>`, '~' for a missing side. */
const show = (rows) =>
  rows.map((r) =>
    r.kind === 'fold' ? `fold(${r.count})` : `${r.before?.text ?? '~'}|${r.after?.text ?? '~'}`
  )

const lines = (...ls) => ls.join('\n') + '\n'
const pad = (n, p) => Array.from({ length: n }, (_, i) => `${p}${i}`)

// --- alignment ----------------------------------------------------------
test('alignment', () => {
  // An insertion pads the before-side, so everything after it stays paired.
  let rows = alignRows(lines('a', 'b'), lines('a', 'x', 'b'))
  assert.deepEqual(show(rows), ['a|a', '~|x', 'b|b'], 'an insertion pads the other side')
  const inserted = rows[1]
  assert.equal(inserted.before, undefined, 'the padded side has no cell at all')
  assert.equal(inserted.after.line, 2, 'the after-side keeps its own numbering')

  // A deletion is the mirror image.
  rows = alignRows(lines('a', 'x', 'b'), lines('a', 'b'))
  assert.deepEqual(show(rows), ['a|a', 'x|~', 'b|b'], 'a deletion pads the after side')
  assert.equal(rows[2].before.line, 3, 'line numbers count their own side, not the row')
  assert.equal(rows[2].after.line, 2)

  // A rewrite pairs the two lines onto ONE row — this is the whole point of a
  // split view over a unified diff.
  rows = alignRows(lines('a', 'old', 'b'), lines('a', 'new', 'b'))
  assert.deepEqual(show(rows), ['a|a', 'old|new', 'b|b'], 'a rewrite shares a row')
  assert.equal(rows[1].kind, 'change')

  // Unequal rewrite blocks: pair as far as the shorter reaches, the rest is
  // one-sided.
  rows = alignRows(lines('p', 'q'), lines('P', 'Q', 'R'))
  assert.deepEqual(show(rows), ['p|P', 'q|Q', '~|R'], 'the surplus of a rewrite stays one-sided')

  // Empty before = a whole file added; every row is one-sided.
  rows = alignRows('', lines('a', 'b'))
  assert.deepEqual(show(rows), ['~|a', '~|b'], 'an added file has no before-side')

  // No trailing phantom line from the final newline.
  assert.equal(alignRows(lines('only'), lines('only')).length, 1, 'no phantom trailing line')
})

// --- intraline ----------------------------------------------------------
test('intraline', () => {
  const rows = alignRows(lines('return ok'), lines('return err'))
  const { before, after } = rows[0]
  assert.ok(before.spans && after.spans, 'a paired rewrite carries word spans')
  assert.equal(
    before.spans.map((s) => s.text).join(''),
    'return ok',
    'spans reconstruct the line exactly'
  )
  assert.equal(after.spans.map((s) => s.text).join(''), 'return err')
  assert.deepEqual(
    before.spans.filter((s) => s.changed).map((s) => s.text),
    ['ok'],
    'only the changed word is highlighted'
  )
  assert.deepEqual(
    after.spans.filter((s) => s.changed).map((s) => s.text),
    ['err']
  )
  // A one-sided line was never paired, so it carries no word-diff highlight —
  // but still gets (unhighlighted, with no lang) syntax spans, always present.
  assert.deepEqual(
    alignRows('', lines('a'))[0].after.spans,
    [{ text: 'a', cls: null, changed: false }],
    'no word-diff spans without a pair, but spans itself is never absent'
  )
})

// --- folding ------------------------------------------------------------
test('folding', () => {
  // 40 unchanged lines around one change: context survives either side of it,
  // the middle of each run folds.
  let rows = alignRows(lines(...pad(20, 'a'), 'x', ...pad(20, 'b')), lines(...pad(20, 'a'), 'y', ...pad(20, 'b')))
  let folded = foldRows(rows)
  const folds = folded.filter((r) => r.kind === 'fold')
  assert.equal(folds.length, 2, 'one fold per long run')
  // The leading run has nothing above it to give context to, so only its tail
  // survives; the trailing run only its head.
  assert.equal(folds[0].count, 20 - CONTEXT, 'the first run folds everything but its tail')
  assert.equal(folds[1].count, 20 - CONTEXT, 'the last run folds everything but its head')
  assert.equal(
    folded.filter((r) => r.kind !== 'fold').length,
    CONTEXT * 2 + 1,
    'context either side of the change, and the change'
  )
  assert.deepEqual(
    show(folded).slice(0, 2),
    [`fold(${20 - CONTEXT})`, 'a17|a17'],
    'the fold comes first, then the context'
  )

  // Expanding one fold brings back exactly that run.
  const expanded = foldRows(rows, new Set([folds[0].at]))
  assert.equal(expanded.filter((r) => r.kind === 'fold').length, 1, 'the other fold stays folded')
  assert.equal(
    expanded.filter((r) => r.kind !== 'fold').length,
    20 + 1 + CONTEXT,
    'the expanded run is back in full'
  )

  // A short run between two changes is left alone — folding it would hide less
  // than the fold row costs.
  rows = alignRows(lines('x', 'a', 'b', 'y'), lines('X', 'a', 'b', 'Y'))
  assert.equal(foldRows(rows).filter((r) => r.kind === 'fold').length, 0, 'short runs never fold')

  // A file with no changes at all is one run with no neighbours: it folds whole.
  rows = alignRows(lines(...pad(10, 'a')), lines(...pad(10, 'a')))
  folded = foldRows(rows)
  assert.deepEqual(show(folded), ['fold(10)'], 'an unchanged file collapses entirely')
})

// --- blocks ---------------------------------------------------------------
test('blocks', () => {
  // Two separate change runs, split by an unchanged line, are two blocks.
  let rows = alignRows(lines('a', 'x', 'b', 'y', 'c'), lines('a', 'X', 'b', 'Y', 'c'))
  let blocks = groupBlocks(rows)
  assert.equal(blocks.length, 2, 'a non-change row splits the run into two blocks')
  assert.deepEqual(blocks[0], { startIndex: 1, endIndex: 1 })
  assert.deepEqual(blocks[1], { startIndex: 3, endIndex: 3 })

  // A rewrite followed immediately by a pure addition is one contiguous block.
  rows = alignRows(lines('a', 'old', 'b'), lines('a', 'new', 'extra', 'b'))
  blocks = groupBlocks(rows)
  assert.equal(blocks.length, 1, 'adjacent change rows are one block')
  assert.deepEqual(blocks[0], { startIndex: 1, endIndex: 2 })

  // A file with no changes has no blocks.
  rows = alignRows(lines('a', 'b'), lines('a', 'b'))
  assert.deepEqual(groupBlocks(rows), [], 'nothing changed, nothing to block')

  // Folding doesn't merge blocks across a collapsed run — groupBlocks just
  // reads whatever row list (folded or not) it's handed.
  rows = alignRows(lines(...pad(20, 'a'), 'x', ...pad(20, 'b')), lines(...pad(20, 'a'), 'y', ...pad(20, 'b')))
  blocks = groupBlocks(foldRows(rows))
  assert.equal(blocks.length, 1, 'one block survives folding around it')
})

// --- syntax highlighting wiring -------------------------------------------
test('syntax highlighting', () => {
  // A lang is optional and defaults to none: same output as before.
  let rows = alignRows(lines('const a = 1'), lines('const a = 1'), null)
  assert.deepEqual(
    rows[0].before.spans,
    [{ text: 'const a = 1', cls: null, changed: false }],
    'no lang — one unhighlighted span, exactly as the no-arg default'
  )

  // A real lang tokenizes every cell, not just rewritten ones.
  rows = alignRows(lines('const a = 1'), lines('const a = 1'), 'typescript')
  const kw = rows[0].before.spans.find((s) => s.text === 'const')
  assert.ok(kw?.cls?.includes('keyword'), 'an equal line still gets syntax spans')
  assert.equal(
    rows[0].before.spans.map((s) => s.text).join(''),
    'const a = 1',
    'syntax spans still reconstruct the line exactly'
  )

  // A rewritten pair keeps its word-diff boundaries — merging in syntax
  // classes must not blur which words actually changed.
  rows = alignRows(lines('const a = 1'), lines('const a = 2'), 'typescript')
  const rewriteBefore = rows[0].before
  const rewriteAfter = rows[0].after
  assert.deepEqual(
    rewriteBefore.spans.filter((s) => s.changed).map((s) => s.text),
    ['1'],
    'only the changed token is marked changed, syntax color or not'
  )
  assert.deepEqual(rewriteAfter.spans.filter((s) => s.changed).map((s) => s.text), ['2'])
  assert.equal(
    rewriteBefore.spans.map((s) => s.text).join(''),
    'const a = 1',
    'merged spans still reconstruct the line exactly'
  )

  // An unregistered/unknown lang id falls back to unhighlighted, not a crash.
  rows = alignRows(lines('const a = 1'), lines('const a = 1'), 'not-a-real-language')
  assert.deepEqual(rows[0].before.spans, [{ text: 'const a = 1', cls: null, changed: false }])
})
