#!/usr/bin/env node
// `npm run coverage` — the same 220 tests as `npm test`, this time measured.
//
// Kept out of `npm test` on purpose. GURT_COVERAGE=1 makes every test emit an
// inline source map from its esbuild bundle (see scripts/lib/bundle.mjs), which
// is what puts V8's line counts on src/**/*.ts instead of on the temp file the
// test actually imports; and each file is measured in a `node --test` of its
// own, because Node's own cross-bundle merge silently loses coverage (see
// scripts/lib/coverage-merge.mjs). Both cost time the everyday run should not
// pay, and neither changes what `npm test` builds.
//
// That per-file `node --test` is also why this loop is serial where `npm test`
// runs its files in parallel: the point here is one coverage report per file,
// not wall-clock.
//
// Deliberately no threshold. `--test-coverage-lines=N` would gate a number this
// suite cannot compute honestly — the report ends with the list of what it does
// not measure — so the gate would fail on true statements, pass on false ones,
// and be satisfiable by importing a module rather than testing it.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mergeRuns, renderReport } from './lib/coverage-merge.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const reporter = pathToFileURL(path.join(ROOT, 'scripts/lib/coverage-report.mjs')).href
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-coverage-'))

const tests = fs
  .readdirSync(path.join(ROOT, 'scripts'))
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()

const runs = []
const counts = { tests: 0, passed: 0, failed: 0 }
let broken = 0

for (const [i, file] of tests.entries()) {
  const out = path.join(tmp, `${file}.json`)
  process.stdout.write(`[${String(i + 1).padStart(2)}/${tests.length}] ${file.padEnd(36)}`)

  const res = spawnSync(
    process.execPath,
    [
      // Without this the whole report lands on /tmp/gurt-*.mjs, one line per
      // bundle, which is the state this command exists to fix.
      '--enable-source-maps',
      '--experimental-test-coverage',
      '--test',
      `--test-reporter=${reporter}`,
      '--test-reporter-destination=stdout',
      path.join('scripts', file)
    ],
    { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, GURT_COVERAGE: '1', GURT_COVERAGE_OUT: out } }
  )
  if (res.error) throw res.error

  // The reporter prints nothing when the file is green, so the progress line
  // above is still the last thing on stdout and can be finished in place.
  const run = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null
  if (!run?.counts) {
    broken++
    process.stdout.write(`no report (exit ${res.status})\n`)
    continue
  }
  counts.tests += run.counts.tests
  counts.passed += run.counts.passed
  counts.failed += run.counts.failed
  runs.push(run)
  process.stdout.write(`${String(run.counts.tests).padStart(3)} tests  ${run.counts.failed ? 'FAIL' : 'ok'}\n`)
}

fs.rmSync(tmp, { recursive: true, force: true })

process.stdout.write(`\n${counts.tests} tests, ${counts.passed} passing, ${counts.failed} failing\n`)
// A file that failed still measured whatever it reached, so the report is worth
// printing either way — but it is not the whole suite's coverage, and saying so
// matters more than the numbers do.
if (counts.failed > 0 || broken > 0)
  process.stdout.write('\nWARNING: the suite is not green. Coverage below is missing whatever those tests never reached.\n')

process.stdout.write(renderReport(mergeRuns(runs)))
process.exit(counts.failed > 0 || broken > 0 ? 1 : 0)
