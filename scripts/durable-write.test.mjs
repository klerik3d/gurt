import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { bundle } from './lib/bundle.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gurt-durable-write-'))
const outfile = path.join(root, 'bundle.mjs')
await bundle({ stdin: { contents: "export * from './src/main/durableWrite.ts'", resolveDir: process.cwd(), loader: 'ts' }, outfile })
const { writeJsonDurable } = await import(pathToFileURL(outfile).href)
after(() => fs.rm(root, { recursive: true, force: true }))

test('creates parents, writes pretty JSON, and overwrites with compact owner-only JSON', async () => {
  const dir = path.join(root, 'nested', 'data')
  const file = path.join(dir, 'credentials.json')
  await writeJsonDurable(file, { value: 'first' })
  assert.equal(await fs.readFile(file, 'utf8'), '{\n  "value": "first"\n}\n')
  await writeJsonDurable(file, { value: 'second' }, { mode: 0o600, pretty: false })
  assert.equal(await fs.readFile(file, 'utf8'), '{"value":"second"}')
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
  assert.deepEqual(await fs.readdir(dir), ['credentials.json'])
})

test('failed serialization preserves the target and removes the temp file', async () => {
  const dir = path.join(root, 'failure')
  const file = path.join(dir, 'data.json')
  await writeJsonDurable(file, { original: true })
  await assert.rejects(writeJsonDurable(file, { invalid: 1n }), TypeError)
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { original: true })
  assert.deepEqual(await fs.readdir(dir), ['data.json'])
})

test('failed rename removes the temp file', async () => {
  const dir = path.join(root, 'rename-failure')
  const file = path.join(dir, 'target')
  await fs.mkdir(file, { recursive: true })
  await assert.rejects(writeJsonDurable(file, {}))
  assert.deepEqual(await fs.readdir(dir), ['target'])
})

test('overlapping writes use independent temp files and leave complete JSON', async () => {
  const dir = path.join(root, 'overlap')
  const file = path.join(dir, 'data.json')
  await Promise.all(Array.from({ length: 20 }, (_, value) => writeJsonDurable(file, { value })))
  const result = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.ok(Number.isInteger(result.value) && result.value >= 0 && result.value < 20)
  assert.deepEqual(await fs.readdir(dir), ['data.json'])
})
