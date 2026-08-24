// The `--test-reporter` half of `npm run coverage`.
//
// `npm run coverage` runs each test file in its own `node --test`, because
// Node's own merge is lossy when several bundles map to the same source (see
// the header of coverage-merge.mjs). This reporter is what each of those runs
// hands back: the src/** slice of its coverage summary, written as JSON to
// GURT_COVERAGE_OUT, plus its pass/fail counts.
//
// Nothing is printed on the way through. The full `spec` output is buffered and
// emitted only if something failed — under coverage there are 32 runs, and 32
// green summaries would bury the report they exist to produce.
import { spec } from 'node:test/reporters'
import { Readable } from 'node:stream'
import fs from 'node:fs'

export default async function* coverageReporter(source) {
  const run = { files: [], counts: null, failed: false }
  const chunks = []

  const tee = async function* () {
    for await (const event of source) {
      if (event.type === 'test:coverage') run.files = srcOnly(event.data.summary.files)
      else if (event.type === 'test:summary' && event.data.file === undefined) run.counts = event.data.counts
      else if (event.type === 'test:fail') run.failed = true
      yield event
    }
  }

  for await (const chunk of Readable.from(tee(), { objectMode: true }).pipe(new spec())) chunks.push(chunk)

  if (process.env.GURT_COVERAGE_OUT) fs.writeFileSync(process.env.GURT_COVERAGE_OUT, JSON.stringify(run))
  // A run that produced no coverage event still has to report its tests.
  if (run.failed || !run.counts) {
    // The runner leaves its progress line unterminated so it can finish it with
    // a result; this output has to start on one of its own.
    yield '\n'
    yield* chunks
  }
}

/**
 * The summary's `files`, narrowed to this repo's own TypeScript and trimmed to
 * what the merge needs. Everything else in there is a test file, a fixture the
 * test wrote, or something Node resolved out of node_modules.
 */
function srcOnly(files) {
  const src = process.cwd() + '/src/'
  return files
    .filter((f) => typeof f.path === 'string' && f.path.startsWith(src))
    .map((f) => ({
      path: f.path,
      totalLineCount: f.totalLineCount,
      lines: f.lines.map((l) => [l.line, l.count]),
      branches: f.branches.map((b) => [b.line, b.count]),
      functions: f.functions.map((fn) => [fn.line, fn.name, fn.count])
    }))
}
