/**
 * Before/after content → the rows a split diff renders. Pure and React-free so
 * the alignment rules are testable on their own (scripts/split-diff.test.mjs).
 * See docs/requirements-manual-review.md §2.2.
 *
 * The host hands over whole file content and nothing diff-shaped; everything
 * about hunks, alignment and folding is decided here.
 */
import { diffLines, diffWordsWithSpace } from 'diff'

/** Unchanged lines kept either side of a change before folding starts. */
export const CONTEXT = 3

/** Below this a fold row would hide less than it costs to show. */
const MIN_FOLD = 2

/** One intraline span; `changed` spans are the highlighted ones. */
export interface Span {
  text: string
  changed: boolean
}

/** One line of one side of the split. */
export interface Cell {
  /** 1-based line number within that side's content. */
  line: number
  text: string
  /** Word-level split, present only where a line was paired with its rewrite. */
  spans?: Span[]
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

/** Word-level spans of a rewritten line pair, one array per side. */
function intraline(before: string, after: string): [Span[], Span[]] {
  const parts = diffWordsWithSpace(before, after)
  const b: Span[] = []
  const a: Span[] = []
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

/**
 * Align the two sides into rows. A block present on one side only pads the
 * other with a missing cell, so matching content always shares a row; a
 * removal block immediately followed by an addition block is a rewrite, and
 * its lines are paired off (and word-diffed) as far as the shorter of the two
 * reaches — the surplus stays as one-sided rows.
 */
export function alignRows(before: string, after: string): Row[] {
  const parts = diffLines(before, after)
  const rows: Row[] = []
  let bn = 0
  let an = 0

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!part.added && !part.removed) {
      for (const text of lines(part.value))
        rows.push({ kind: 'equal', before: { line: ++bn, text }, after: { line: ++an, text } })
      continue
    }
    if (part.added) {
      for (const text of lines(part.value)) rows.push({ kind: 'change', after: { line: ++an, text } })
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
      const [bs, as] = intraline(removed[k], added[k])
      rows.push({
        kind: 'change',
        before: { line: ++bn, text: removed[k], spans: bs },
        after: { line: ++an, text: added[k], spans: as }
      })
    }
    for (let k = paired; k < removed.length; k++)
      rows.push({ kind: 'change', before: { line: ++bn, text: removed[k] } })
    for (let k = paired; k < added.length; k++)
      rows.push({ kind: 'change', after: { line: ++an, text: added[k] } })
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
    if (rows[i].kind !== 'equal') {
      out.push(rows[i++])
      continue
    }
    let end = i
    while (end < rows.length && rows[end].kind === 'equal') end++
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
