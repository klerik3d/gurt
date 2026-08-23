// Runs every scripts/*.test.mjs as a separate `node <file>` process.
// Used by `npm test` locally and by CI. Smoke scripts (scripts/smoke*.mjs)
// are not included — they need Electron/Docker and run separately.
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Test files to skip (by filename), with a reason for each entry.
const EXCLUDE = []

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const tests = readdirSync(scriptsDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()

const failed = []
for (const name of tests) {
  const rel = join('scripts', name)
  if (EXCLUDE.includes(name)) {
    console.log(`SKIP ${rel}`)
    continue
  }
  console.log(`RUN ${rel}`)
  const result = spawnSync(process.execPath, [join(scriptsDir, name)], {
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    console.log(`FAIL ${rel}`)
    failed.push(rel)
  }
}

if (failed.length > 0) {
  console.log(`\n${failed.length} test file(s) failed: ${failed.join(', ')}`)
  process.exit(1)
}
console.log(`\nAll ${tests.length - EXCLUDE.length} test file(s) passed.`)
