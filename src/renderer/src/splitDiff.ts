/**
 * Before/after content → the rows a split diff renders. Pure and React-free so
 * the alignment rules are testable on their own (scripts/split-diff.test.mjs).
 * See docs/requirements-manual-review.md §2.2.
 *
 * The host hands over whole file content and nothing diff-shaped; everything
 * about hunks, alignment and folding is decided here.
 */
import { diffLines, diffWordsWithSpace } from 'diff'
import { mergeSpans, tokenize } from './syntaxHighlight'

/** Unchanged lines kept either side of a change before folding starts. */
export const CONTEXT = 3

/** Below this a fold row would hide less than it costs to show. */
const MIN_FOLD = 2

/** One rendered run of a line: syntax color (`cls`, `null` = unhighlighted)
 *  and whether a rewrite's word-diff marked it changed. */
export interface Span {
  text: string
  changed: boolean
  cls: string | null
}

/** One line of one side of the split. */
export interface Cell {
  /** 1-based line number within that side's content. */
  line: number
  text: string
  /** Always covers `text` exactly — syntax-only outside a rewritten pair. */
  spans: Span[]
}

/**
 * A rendered row. `equal` carries both sides; `change` carries at least one —
 * a row with only `before` is a deletion, only `after` an insertion, and both
 * a rewrite (the two are on the same row, which is what makes the panes line
 * up). `fold` stands in for `count` hidden unchanged lines.
 */
export type Row =
  | { kind: 'equal' | 'change'; before?: Cell; after?: Cell }
  | { kind: 'fold'; count: number; /** Index into the unfolded row list. */ at: number }

/** Split into lines without inventing a trailing empty one for a final '\n'. */
function lines(text: string): string[] {
  if (!text) return []
  const out = text.split('\n')
  if (out.length && out[out.length - 1] === '') out.pop()
  return out
}

/** Word-level diff of a rewritten line pair, one array per side — not yet
 *  syntax-colored, {@link cellSpans} merges the two. */
function wordDiff(before: string, after: string): [{ text: string; changed: boolean }[], { text: string; changed: boolean }[]] {
  const parts = diffWordsWithSpace(before, after)
  const b: { text: string; changed: boolean }[] = []
  const a: { text: string; changed: boolean }[] = []
  for (const p of parts) {
    if (p.added) a.push({ text: p.value, changed: true })
    else if (p.removed) b.push({ text: p.value, changed: true })
    else {
      b.push({ text: p.value, changed: false })
      a.push({ text: p.value, changed: false })
    }
  }
  return [b, a]
}

/** A cell's rendered spans: syntax-tokenized, and — for a rewritten pair —
 *  merged with the word-diff boundaries. */
function cellSpans(text: string, lang: string | null, wordSpans?: { text: string; changed: boolean }[]): Span[] {
  const syntax = tokenize(text, lang)
  if (wordSpans) return mergeSpans(syntax, wordSpans)
  return syntax.map((s) => ({ text: s.text, cls: s.cls, changed: false }))
}

/**
 * Align the two sides into rows. A block present on one side only pads the
 * other with a missing cell, so matching content always shares a row; a
 * removal block immediately followed by an addition block is a rewrite, and
 * its lines are paired off (and word-diffed) as far as the shorter of the two
 * reaches — the surplus stays as one-sided rows.
 *
 * `lang` is an `hljs` language id (or `null` to skip highlighting) — every
 * cell is syntax-tokenized, not just rewritten ones.
 */
export function alignRows(before: string, after: string, lang: string | null = null): Row[] {
  const parts = diffLines(before, after)
  const rows: Row[] = []
  let bn = 0
  let an = 0

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!part) continue
    if (!part.added && !part.removed) {
      for (const text of lines(part.value)) {
        const spans = cellSpans(text, lang)
        rows.push({ kind: 'equal', before: { line: ++bn, text, spans }, after: { line: ++an, text, spans } })
      }
      continue
    }
    if (part.added) {
      for (const text of lines(part.value))
        rows.push({ kind: 'change', after: { line: ++an, text, spans: cellSpans(text, lang) } })
      continue
    }
    // Removed. Peek at the next part: an addition right behind it rewrites
    // these lines rather than deleting them.
    const removed = lines(part.value)
    const next = parts[i + 1]
    const added = next?.added ? lines(next.value) : []
    if (added.length) i++
    const paired = Math.min(removed.length, added.length)
    for (let k = 0; k < paired; k++) {
      // k < min(removed.length, added.length), so both cells are there.
      const bText = removed[k] ?? ''
      const aText = added[k] ?? ''
      const [bs, as] = wordDiff(bText, aText)
      rows.push({
        kind: 'change',
        before: { line: ++bn, text: bText, spans: cellSpans(bText, lang, bs) },
        after: { line: ++an, text: aText, spans: cellSpans(aText, lang, as) }
      })
    }
    for (const text of removed.slice(paired))
      rows.push({ kind: 'change', before: { line: ++bn, text, spans: cellSpans(text, lang) } })
    for (const text of added.slice(paired))
      rows.push({ kind: 'change', after: { line: ++an, text, spans: cellSpans(text, lang) } })
  }
  return rows
}

/**
 * Replace long runs of unchanged rows with fold rows. An interior run keeps
 * {@link CONTEXT} rows against each neighbouring change; a run at the very
 * start or end of the file has only one neighbour, so the side facing nothing
 * is folded away entirely — there is no change there to give context to.
 *
 * `expanded` holds the `at` of every fold the user has opened; those runs come
 * back verbatim.
 */
export function foldRows(rows: Row[], expanded: ReadonlySet<number> = new Set()): Row[] {
  const out: Row[] = []
  for (let i = 0; i < rows.length; ) {
    const row = rows[i]
    if (!row) break
    if (row.kind !== 'equal') {
      out.push(row)
      i++
      continue
    }
    let end = i
    while (rows[end]?.kind === 'equal') end++
    const run = rows.slice(i, end)
    const head = i === 0 ? 0 : CONTEXT // nothing above the first run to anchor to
    const tail = end === rows.length ? 0 : CONTEXT
    const hidden = run.length - head - tail
    if (hidden < MIN_FOLD || expanded.has(i)) {
      out.push(...run)
    } else {
      out.push(...run.slice(0, head))
      out.push({ kind: 'fold', count: hidden, at: i })
      out.push(...run.slice(run.length - tail))
    }
    i = end
  }
  return out
}

/**
 * Maximal runs of consecutive `change` rows in a (shown, post-fold) row
 * list — what "comment on this block" anchors to. Indices into that same
 * list, so callers can look the block's rows straight back up in it.
 */
export interface Block {
  startIndex: number
  endIndex: number
}

export function groupBlocks(rows: Row[]): Block[] {
  const blocks: Block[] = []
  let start = -1
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]?.kind === 'change') {
      if (start === -1) start = i
    } else if (start !== -1) {
      blocks.push({ startIndex: start, endIndex: i - 1 })
      start = -1
    }
  }
  if (start !== -1) blocks.push({ startIndex: start, endIndex: rows.length - 1 })
  return blocks
}
