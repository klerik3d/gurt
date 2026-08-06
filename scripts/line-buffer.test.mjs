// Regression test for docs/logging.md's "Streams … are line-buffered before
// redaction — a secret split across two chunks is never forwarded in halves."
// `lineBuffer()` (src/main/provision.ts) must join a secret split across two
// `data` chunks into one line before it ever reaches sanitize()/redact().
//
//   node scripts/line-buffer.test.mjs
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-line-buffer-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await build({
  stdin: {
    contents:
      `export { lineBuffer } from ${S('src/main/provision.ts')}\n` +
      `export { addSecrets, sanitize } from ${S('src/main/log.ts')}`,
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-line-buffer-'))
process.env.GURT_ROOT = root // log.ts reads this at import time

try {
  const m = await import(pathToFileURL(outfile).href)
  const SECRET = 'xk-split-across-two-chunks-9f8e7d6c5b4a'
  m.addSecrets([SECRET])

  const lines = []
  const buf = m.lineBuffer((line) => lines.push(line))

  // The secret straddles the boundary between two `data` chunks, exactly the
  // shape a redaction-evading process (or an unlucky TCP/pipe split) produces.
  const half = Math.floor(SECRET.length / 2)
  const chunk1 = `some prefix ${SECRET.slice(0, half)}`
  const chunk2 = `${SECRET.slice(half)} some suffix\n`
  buf.push(Buffer.from(chunk1, 'utf8'))
  // Nothing is forwarded yet — the line has no terminating '\n'.
  assert.equal(lines.length, 0, 'a chunk with no newline is buffered, not forwarded early')
  buf.push(Buffer.from(chunk2, 'utf8'))

  assert.equal(lines.length, 1, 'the two chunks join into exactly one line')
  assert.ok(lines[0].includes(SECRET), 'lineBuffer itself does not redact — sanitize() does, downstream')

  // What actually reaches a log line: sanitize() applied to the *joined* line.
  const sanitized = m.sanitize(lines[0])
  assert.ok(!sanitized.includes(SECRET), 'the secret is redacted once the split halves are joined')
  assert.ok(sanitized.includes('[redacted]'))

  // Same check with the split landing mid-secret at a different offset.
  const lines2 = []
  const buf2 = m.lineBuffer((line) => lines2.push(line))
  buf2.push(Buffer.from(`x ${SECRET.slice(0, 3)}`, 'utf8'))
  buf2.push(Buffer.from(`${SECRET.slice(3)} y\n`, 'utf8'))
  assert.equal(lines2.length, 1)
  assert.ok(!m.sanitize(lines2[0]).includes(SECRET), 'redaction holds at a different split offset too')

  // A chunk boundary landing mid multi-byte UTF-8 sequence must not turn the
  // halves into U+FFFD — the decoder carries the partial sequence across
  // chunks the same way `rest` carries the partial line.
  const lines3 = []
  const buf3 = m.lineBuffer((line) => lines3.push(line))
  const utf8 = Buffer.from('процесс упал: ошибка №42\n', 'utf8')
  buf3.push(utf8.subarray(0, 5)) // splits the 2-byte 'о' down the middle
  buf3.push(utf8.subarray(5))
  assert.equal(lines3.length, 1)
  assert.equal(lines3[0], 'процесс упал: ошибка №42', 'a chunk split mid-character decodes intact')
  assert.ok(!lines3[0].includes('�'), 'no replacement characters from the split')

  console.log('line-buffer.test: PASS')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outfile, { force: true })
}
