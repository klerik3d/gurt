// Merging the per-run coverage of `npm run coverage`, and rendering the report.
//
// WHY THE RUNS ARE SEPARATE. Every test file bundles the slice of src/** it
// needs into a temp file of its own, so the same module is compiled into a
// dozen different bundles across the suite. Node merges those inside one run by
// source path, and the merge loses coverage: measured on its own,
// src/shared/usage.ts comes out at 103 of 112 lines; measured in a run that
// also loads the bundles where usage.ts is only along for the ride, it drops to
// 82 — a module cannot become less tested because another test ran. The zero
// ranges of the passenger copies mask the real ones.
//
// So each file is measured in its own `node --test`, where a source appears in
// exactly one script and nothing can mask it, and the runs are unioned here.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = path.join(ROOT, 'src')

/**
 * Union the per-run summaries into one entry per source file.
 *
 * Lines and functions merge exactly: a line is covered if any run ran it. What
 * a run does not track at all is not executable in that bundle, so only the
 * lines somebody tracked can count against a file — that is also how Node
 * arrives at its own `coveredLineCount`, and keeping the convention keeps these
 * numbers comparable with a plain `--experimental-test-coverage` run.
 *
 * @param {Array<{ files: Array<any> }>} runs
 */
export function mergeRuns(runs) {
  const merged = new Map()

  for (const run of runs)
    for (const file of run.files) {
      let entry = merged.get(file.path)
      if (!entry) merged.set(file.path, (entry = { total: file.totalLineCount, lines: new Map(), fns: new Map(), branches: new Map() }))
      entry.total = Math.max(entry.total, file.totalLineCount)

      for (const [line, count] of file.lines) entry.lines.set(line, Math.max(entry.lines.get(line) ?? 0, count))
      for (const [line, name, count] of file.functions) {
        const key = `${line} ${name}`
        entry.fns.set(key, Math.max(entry.fns.get(key) ?? 0, count))
      }

      // Branches are the one thing that cannot be unioned exactly: the summary
      // gives a line and a hit count per branch, with no identity, and several
      // branches share a line. Per line we therefore keep the best any single
      // run managed — the widest expansion seen, and the most of it covered. If
      // two runs each cover a different branch of one line this reports one and
      // not two, so the branch column is a floor while the other two are exact.
      const perLine = new Map()
      for (const [line, count] of file.branches) {
        const seen = perLine.get(line) ?? { total: 0, covered: 0 }
        seen.total++
        if (count > 0) seen.covered++
        perLine.set(line, seen)
      }
      for (const [line, seen] of perLine) {
        const best = entry.branches.get(line)
        if (!best || seen.total > best.total || (seen.total === best.total && seen.covered > best.covered))
          entry.branches.set(line, seen)
      }
    }

  return [...merged]
    .map(([file, entry]) => {
      const branches = [...entry.branches.values()]
      return {
        rel: path.relative(ROOT, file),
        totalLineCount: entry.total,
        // Lines nobody tracked hold no code — blanks, comments, types — and are
        // not held against the file.
        coveredLineCount: entry.total - [...entry.lines.values()].filter((c) => c === 0).length,
        totalBranchCount: branches.reduce((n, b) => n + b.total, 0),
        coveredBranchCount: branches.reduce((n, b) => n + b.covered, 0),
        totalFunctionCount: entry.fns.size,
        coveredFunctionCount: [...entry.fns.values()].filter((c) => c > 0).length
      }
    })
    .sort((a, b) => a.rel.localeCompare(b.rel))
}

/** @param {ReturnType<typeof mergeRuns>} files */
export function renderReport(files) {
  const measured = new Set(files.map((f) => f.rel))
  // A module that compiles to no JavaScript at all — a file of `type` and
  // `interface` declarations — cannot appear in a coverage report and is not a
  // gap in one. Separating those keeps the "nothing measured this" list honest.
  const absent = sourceFiles().filter((rel) => !measured.has(rel))
  const typeOnly = absent.filter(isTypeOnly)
  const untouched = absent.filter((rel) => !typeOnly.includes(rel))

  return ['', ...table(files), ...worst(files), ...missing(untouched, typeOnly), ...caveats(files, untouched)].join('\n') + '\n'
}

/** Every hand-written module under src/, repo-relative, grouped by directory. */
function sourceFiles() {
  const found = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(path.relative(ROOT, full))
    }
  }
  walk(SRC)
  return found.sort((a, b) => path.dirname(a).localeCompare(path.dirname(b)) || path.basename(a).localeCompare(path.basename(b)))
}

/** True when stripping the types leaves nothing to execute. */
function isTypeOnly(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  return transformSync(code, { loader: rel.endsWith('.tsx') ? 'tsx' : 'ts' }).code.trim() === ''
}

const COLS = ['line %', 'branch %', 'funcs %']
const cell = (v) => (typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(2) : '--') : v).padStart(9)
const percent = (covered, total) => (total === 0 ? NaN : (covered / total) * 100)

function table(files) {
  const width = Math.max(28, ...files.map((f) => f.rel.length))
  const rule = '─'.repeat(width + COLS.length * 9)
  const row = (label, f) =>
    label.padEnd(width) +
    [
      percent(f.coveredLineCount, f.totalLineCount),
      percent(f.coveredBranchCount, f.totalBranchCount),
      percent(f.coveredFunctionCount, f.totalFunctionCount)
    ]
      .map(cell)
      .join('')

  const lines = ['Coverage of src/ — measured on the real TypeScript, through source maps', '', rule]
  lines.push('file'.padEnd(width) + COLS.map(cell).join(''), rule)
  for (const f of files) lines.push(row(f.rel, f))
  lines.push(rule)

  const sum = (key) => files.reduce((n, f) => n + f[key], 0)
  lines.push(
    row('all measured files', {
      coveredLineCount: sum('coveredLineCount'),
      totalLineCount: sum('totalLineCount'),
      coveredBranchCount: sum('coveredBranchCount'),
      totalBranchCount: sum('totalBranchCount'),
      coveredFunctionCount: sum('coveredFunctionCount'),
      totalFunctionCount: sum('totalFunctionCount')
    })
  )
  lines.push(rule, '')
  return lines
}

function worst(files) {
  // Ranked by uncovered lines rather than by percentage. A 36%-covered
  // 2000-line module is where the risk is; sorting on the percentage buries it
  // under every 20-line helper that nobody happened to import.
  const ranked = files
    .map((f) => ({ ...f, missing: f.totalLineCount - f.coveredLineCount }))
    .filter((f) => f.missing > 0)
    .sort((a, b) => b.missing - a.missing)
    .slice(0, 12)
  if (ranked.length === 0) return []

  const width = Math.max(...ranked.map((f) => f.rel.length))
  const lines = ['Least-covered measured modules, by uncovered lines', '']
  for (const [i, f] of ranked.entries())
    lines.push(
      `${String(i + 1).padStart(3)}. ${f.rel.padEnd(width)} ${cell(percent(f.coveredLineCount, f.totalLineCount))}% of lines` +
        `, ${String(f.missing).padStart(4)} uncovered of ${f.totalLineCount}`
    )
  lines.push('')
  return lines
}

function missing(untouched, typeOnly) {
  const lines = []
  if (untouched.length > 0) {
    lines.push(
      `Absent from the table — ${untouched.length} module${untouched.length === 1 ? '' : 's'} the report says nothing about`,
      '',
      'Absent is not zero. No line of these ever reached V8, so they are missing',
      'from the total above rather than dragging it down. Read them as unknown.',
      ''
    )
    let dir = null
    for (const rel of untouched) {
      if (path.dirname(rel) !== dir) lines.push(`  ${(dir = path.dirname(rel))}/`)
      lines.push(`      ${path.basename(rel)}`)
    }
    lines.push('')
  }
  if (typeOnly.length > 0)
    lines.push(
      `(${typeOnly.length} further file${typeOnly.length === 1 ? '' : 's'} under src/ compile${typeOnly.length === 1 ? 's' : ''} to no JavaScript`,
      ` at all — ${typeOnly.join(', ')} — and ${typeOnly.length === 1 ? 'is' : 'are'} neither measured nor measurable.)`,
      ''
    )
  return lines
}

function caveats(files, untouched) {
  const total = files.length + untouched.length
  const share = total === 0 ? 0 : Math.round((files.length / total) * 100)
  return [
    'How to read the total',
    '',
    `  - It covers ${files.length} of the ${total} executable modules under src/ (${share}%). The others`,
    '    are the block above, and are not averaged in either direction.',
    '  - Child processes ARE counted. Node passes NODE_V8_COVERAGE down to every',
    '    descendant, so log.test.mjs, which runs each of its ~20 scenarios in a',
    '    process of its own, contributes exactly like the rest.',
    '  - The smoke tier (npm run smoke) is NOT counted. It drives the packaged',
    '    app, a different build with no source map back into src/. Anything only',
    '    smoke exercises reads here as uncovered.',
    '  - The branch column is a floor, not an exact figure: the merge across test',
    '    files cannot tell two branches on one line apart. Line coverage is exact.',
    '  - A "--" is not 0%. Node ties each branch and function to one source file,',
    '    and a module whose code all sits inside a neighbour\'s range gets its lines',
    '    counted and nothing else. There is no denominator to divide by.',
    '  - Being in the table is not the same as being tested. A module pulled in as',
    '    a dependency of the module under test is executed, counted, and asserted',
    '    against by nobody.',
    ''
  ]
}
