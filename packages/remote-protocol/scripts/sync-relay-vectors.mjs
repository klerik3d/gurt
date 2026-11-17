// The relay's conformance vectors are the source of truth for the host-socket
// codec (protocol §10); this package keeps a pinned copy in testdata/relay/.
//
//   node scripts/sync-relay-vectors.mjs --check  [relay-dir]   compare the copy with the relay checkout
//   node scripts/sync-relay-vectors.mjs --update [relay-dir]   copy from the relay checkout, rewrite SHA256SUMS
//
// `relay-dir` is a gurt-relay checkout; it defaults to $GURT_RELAY_DIR, then to
// `gurt-relay` next to the `gurt` repository. `--check` exits 1 when a file
// differs or is missing; run it after a change in gurt-relay/testdata/.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PINNED = path.join(ROOT, 'testdata', 'relay')
/** The files taken from gurt-relay/testdata/. */
export const FILES = ['README.md', 'frames.json', 'register.json']
const SUMS = 'SHA256SUMS'

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/** The SHA256SUMS text for the files in `dir`, `sha256sum` format. */
export const sumsOf = (dir) => FILES.map((f) => `${sha256(path.join(dir, f))}  ${f}\n`).join('')

/** Problems with the pinned copy on its own: a file edited by hand or without SHA256SUMS. */
export function checkPinned() {
  const want = fs.existsSync(path.join(PINNED, SUMS)) ? fs.readFileSync(path.join(PINNED, SUMS), 'utf8') : null
  return want === sumsOf(PINNED) ? [] : [`testdata/relay/${SUMS} does not match the files in testdata/relay/`]
}

/** The default relay checkout, or null when there is none. */
export function defaultRelayDir() {
  const dir = process.env.GURT_RELAY_DIR ?? path.resolve(ROOT, '../../../gurt-relay')
  return fs.existsSync(path.join(dir, 'testdata', 'frames.json')) ? dir : null
}

/** Differences between the pinned copy and the relay checkout's testdata/. */
export function compareWithRelay(relayDir) {
  const problems = []
  for (const f of FILES) {
    const src = path.join(relayDir, 'testdata', f)
    if (!fs.existsSync(src)) problems.push(`${src} is missing`)
    else if (!fs.readFileSync(src).equals(fs.readFileSync(path.join(PINNED, f))))
      problems.push(`testdata/relay/${f} differs from ${src}`)
  }
  return problems
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, arg] = process.argv.slice(2)
  const relayDir = arg ? path.resolve(arg) : defaultRelayDir()
  if ((mode !== '--check' && mode !== '--update') || !relayDir) {
    console.error('usage: sync-relay-vectors.mjs --check|--update [path to a gurt-relay checkout]')
    console.error('       (default: $GURT_RELAY_DIR, or gurt-relay next to the gurt repository)')
    process.exit(2)
  }
  if (mode === '--update') {
    fs.mkdirSync(PINNED, { recursive: true })
    for (const f of FILES) fs.copyFileSync(path.join(relayDir, 'testdata', f), path.join(PINNED, f))
    fs.writeFileSync(path.join(PINNED, SUMS), sumsOf(PINNED))
    console.log(`testdata/relay/ updated from ${relayDir}; run the tests and review the diff`)
  } else {
    const problems = [...checkPinned(), ...compareWithRelay(relayDir)]
    for (const p of problems) console.error(p)
    if (problems.length) {
      console.error('\nThe pinned copy is out of date. Update it with:\n  node packages/remote-protocol/scripts/sync-relay-vectors.mjs --update <path to gurt-relay>\nthen run the tests and commit the diff together with the code that needed it.')
      process.exit(1)
    }
    console.log(`testdata/relay/ matches ${relayDir}`)
  }
}
