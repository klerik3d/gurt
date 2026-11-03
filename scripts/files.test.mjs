import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { bundle } from './lib/bundle.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-files-'))
process.env.GURT_ROOT = path.join(root, 'store')
const scope = path.join(process.env.GURT_ROOT, 'demo', 'scope')
const repo = path.join(scope, 'frontend')
fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
fs.mkdirSync(path.join(repo, 'src'))
fs.mkdirSync(path.join(repo, 'empty'))
fs.mkdirSync(path.join(scope, 'backend', '.git'), { recursive: true })
fs.writeFileSync(path.join(scope, 'task.json'), '{}')
fs.writeFileSync(path.join(scope, 'sessions.json'), 'private session data')
fs.writeFileSync(path.join(repo, 'README.md'), '# Hello\n')
fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n')
fs.writeFileSync(path.join(repo, 'asset.bin'), Buffer.from([0, 1, 2]))
fs.writeFileSync(path.join(repo, 'latin1.txt'), Buffer.from([0xff, 0xfe, 0xa1]))
fs.writeFileSync(path.join(repo, 'large.txt'), 'a'.repeat(2 * 1024 * 1024 + 1))
fs.writeFileSync(path.join(root, 'outside.txt'), 'outside')
fs.symlinkSync(path.join(root, 'outside.txt'), path.join(repo, 'link.txt'))
fs.symlinkSync(root, path.join(repo, 'linked-folder'), 'dir')
fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir')
const outfile = path.join(root, 'files.mjs')
await bundle({ entryPoints: [path.resolve('src/main/files.ts')], outfile })
const { renameTaskFile, deleteTaskFile, taskFilePath, listTaskFiles, readTaskFile, writeTaskFile, navigateTaskFile } = await import(pathToFileURL(outfile).href)
after(() => fs.rmSync(root, { recursive: true, force: true }))
const read = (name) => readTaskFile('demo', 'scope', `frontend/${name}`)
const write = (name, content, version) => writeTaskFile('demo', 'scope', `frontend/${name}`, content, version)

test('explorer exposes clones, dotfiles and untracked files, excluding scope metadata and .git', async () => {
  assert.deepEqual((await listTaskFiles('demo', 'scope', '')).map((e) => e.name), ['backend', 'frontend'])
  const entries = await listTaskFiles('demo', 'scope', 'frontend')
  assert.equal(entries[0].kind, 'directory')
  assert.ok(entries.some((e) => e.name === '.gitignore'))
  assert.ok(entries.some((e) => e.name === 'README.md'))
  assert.ok(!entries.some((e) => e.name === '.git'))
  assert.equal(entries.find((e) => e.name === 'link.txt').kind, 'symlink')
  assert.deepEqual(await listTaskFiles('demo', 'scope', 'frontend/empty'), [])
})

test('file operations reject traversal, metadata and symbolic links', async () => {
  for (const invalid of ['../sessions.json', 'frontend/../sessions.json', 'frontend/.git/config', '/etc/passwd', 'frontend//README.md', 'frontend\\README.md', 'sessions.json', 'frontend/link.txt', 'frontend/linked-folder/outside.txt']) {
    await assert.rejects(readTaskFile('demo', 'scope', invalid))
    await assert.rejects(writeTaskFile('demo', 'scope', invalid, 'overwrite', 'old'))
  }
  await assert.rejects(listTaskFiles('demo', '../scope', ''))
  await assert.rejects(readTaskFile('demo', 'missing', 'frontend/README.md'))
  assert.equal(fs.readFileSync(path.join(root, 'outside.txt'), 'utf8'), 'outside')
})

test('only bounded UTF-8 text can be opened', async () => {
  await assert.rejects(read('asset.bin'), /Binary/)
  await assert.rejects(read('latin1.txt'), /UTF-8/)
  await assert.rejects(read('large.txt'), /2 MiB/)
  await assert.rejects(read('src'), /regular files/)
  const original = '\ufefffirst\r\nвторая строка\r\n'
  fs.writeFileSync(path.join(repo, 'crlf.txt'), original)
  assert.equal((await read('crlf.txt')).content, original)
})

test('save replaces text from byte zero, truncates and preserves permissions and CRLF', async () => {
  const filename = path.join(repo, 'save.txt')
  fs.writeFileSync(filename, 'long original contents\n', { mode: 0o640 })
  const before = await read('save.txt')
  const next = await write('save.txt', 'hi\r\n', before.version)
  assert.equal(fs.readFileSync(filename, 'utf8'), 'hi\r\n')
  assert.notEqual(next.version, before.version)
  assert.equal(fs.statSync(filename).mode & 0o777, 0o640)
  await write('save.txt', '', next.version)
  assert.equal(fs.readFileSync(filename).length, 0)
})

test('external edits and concurrent stale saves conflict without overwriting disk', async () => {
  const filename = path.join(repo, 'conflict.txt')
  fs.writeFileSync(filename, 'initial')
  const before = await read('conflict.txt')
  fs.writeFileSync(filename, 'agent changed it')
  await assert.rejects(write('conflict.txt', 'my edits', before.version), /changed on disk/)
  assert.equal(fs.readFileSync(filename, 'utf8'), 'agent changed it')
  const current = await read('conflict.txt')
  const saves = await Promise.allSettled([write('conflict.txt', 'first', current.version), write('conflict.txt', 'second', current.version)])
  assert.equal(saves.filter((s) => s.status === 'fulfilled').length, 1)
  assert.equal(saves.filter((s) => s.status === 'rejected').length, 1)
})

const lib = 'export function greet(name: string) { return name }\nexport function shadow() { const greet = 42; return greet }\n'
const app = 'import { greet } from "./lib"\nexport const message = greet("hello")\n'
fs.writeFileSync(path.join(repo, 'src', 'lib.ts'), lib)
fs.writeFileSync(path.join(repo, 'src', 'app.ts'), app)
const navigate = (kind, documents = [], position = app.lastIndexOf('greet') + 2) => navigateTaskFile('demo', 'scope', 'frontend/src/app.ts', { kind, position, documents })

test('TypeScript definitions resolve imports; references distinguish shadowed symbols', async () => {
  const result = await navigate('definition')
  assert.equal(result.semantic, true)
  assert.ok(result.locations.some((loc) => loc.path === 'frontend/src/lib.ts' && loc.from === lib.indexOf('greet') && loc.line === 1))
  const refs = await navigate('references')
  assert.ok(refs.locations.some((loc) => loc.path === 'frontend/src/app.ts' && loc.line === 2))
  assert.ok(refs.locations.some((loc) => loc.path === 'frontend/src/lib.ts' && loc.line === 1))
  assert.ok(!refs.locations.some((loc) => loc.path === 'frontend/src/lib.ts' && loc.line === 2))
})

test('semantic navigation includes unsaved buffers and tsconfig path aliases', async () => {
  const unsaved = `${app}greet("unsaved")\n`
  const result = await navigate('references', [{ path: 'frontend/src/app.ts', content: unsaved }])
  assert.ok(result.locations.some((loc) => loc.path === 'frontend/src/app.ts' && loc.line === 3))
  const aliased = app.replace('./lib', '@src/lib')
  fs.writeFileSync(path.join(repo, 'tsconfig.json'), '{"compilerOptions":{"baseUrl":".","paths":{"@src/*":["src/*"]}}}')
  const definition = await navigate('definition', [{ path: 'frontend/src/app.ts', content: aliased }], aliased.lastIndexOf('greet') + 2)
  assert.ok(definition.locations.some((loc) => loc.path === 'frontend/src/lib.ts'))
})

test('other languages get labelled word matches, with ignored directories and symlinks excluded', async () => {
  const python = 'value = 1\nprint(value)\nnot_value = 2\n'
  fs.writeFileSync(path.join(repo, 'src', 'demo.py'), python)
  fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'node_modules', 'ignored.py'), 'value = 42\n')
  const result = await navigateTaskFile('demo', 'scope', 'frontend/src/demo.py', { kind: 'references', position: 2, documents: [] })
  assert.equal(result.semantic, false)
  assert.deepEqual(result.locations.map((loc) => [loc.path, loc.line]), [['frontend/src/demo.py', 1], ['frontend/src/demo.py', 2]])
  assert.deepEqual(await navigateTaskFile('demo', 'scope', 'frontend/src/demo.py', { kind: 'definition', position: 2, documents: [] }), { semantic: false, limited: false, locations: [] })
})

 test('explorer mutations stay inside clones and refuse overwriting existing paths', async () => {
  fs.mkdirSync(path.join(repo, 'mutations'))
  fs.writeFileSync(path.join(repo, 'mutations', 'old.txt'), 'keep')
  fs.writeFileSync(path.join(repo, 'mutations', 'existing.txt'), 'existing')
  assert.equal(await taskFilePath('demo', 'scope', 'frontend/mutations/old.txt'), path.join(repo, 'mutations', 'old.txt'))
  await assert.rejects(renameTaskFile('demo', 'scope', 'frontend/mutations/old.txt', 'existing.txt'))
  for (const name of ['../escape', '.git', '..', 'a/b', 'a\\b']) await assert.rejects(renameTaskFile('demo', 'scope', 'frontend/mutations/old.txt', name))
  await assert.rejects(renameTaskFile('demo', 'scope', 'frontend', 'other'))
  await assert.rejects(deleteTaskFile('demo', 'scope', 'frontend'))
  await assert.rejects(deleteTaskFile('demo', 'scope', 'frontend/linked-folder'))
  assert.equal(await renameTaskFile('demo', 'scope', 'frontend/mutations/old.txt', 'new.txt'), 'frontend/mutations/new.txt')
  assert.equal(fs.readFileSync(path.join(repo, 'mutations', 'new.txt'), 'utf8'), 'keep')
  await deleteTaskFile('demo', 'scope', 'frontend/mutations')
  assert.equal(fs.existsSync(path.join(repo, 'mutations')), false)
})
