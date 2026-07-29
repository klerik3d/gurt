// Integration test for the Dockerfile-env image cache (real git + real docker,
// no electron, no network — `FROM scratch` needs no image pull):
// `ensureBuiltImage` builds once, tags by (repoUrl, dockerfilePath, HEAD), and
// reuses the cached image until the repo's committed content changes.
//
//   node scripts/env-image-build.test.mjs
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const pexecFile = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-env-image-build-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await build({
  stdin: {
    contents: `export { ensureBuiltImage } from ${S('src/main/provision.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  logLevel: 'silent'
})

const m = await import(pathToFileURL(outfile).href)

const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-image-build-repo-'))
const git = (...args) => pexecFile('git', ['-C', repoDir, ...args])
const REPO_URL = 'https://example.com/gurt-image-build-test.git'
const builtTags = []

function collector() {
  const lines = []
  return { log: (line) => lines.push(line), lines }
}

try {
  await git('init', '-q')
  await git('-c', 'user.email=t@t.test', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init')
  fs.writeFileSync(path.join(repoDir, 'hello.txt'), 'v1\n')
  fs.writeFileSync(
    path.join(repoDir, 'Dockerfile'),
    'FROM scratch\nCOPY hello.txt /hello.txt\n'
  )
  await git('add', '-A')
  await git('-c', 'user.email=t@t.test', '-c', 'user.name=t', 'commit', '-q', '-m', 'add dockerfile')

  // --- first call: builds and tags ---
  const c1 = collector()
  const tag1 = await m.ensureBuiltImage(REPO_URL, 'Dockerfile', repoDir, c1.log)
  builtTags.push(tag1)
  assert.match(tag1, /^gurt-env:[0-9a-f]{16}$/, 'tag has the expected shape')
  assert.ok(c1.lines.some((l) => l.includes('building')), 'first call actually builds')

  // --- second call, same content: cache hit, no rebuild ---
  const c2 = collector()
  const tag2 = await m.ensureBuiltImage(REPO_URL, 'Dockerfile', repoDir, c2.log)
  assert.equal(tag2, tag1, 'same repo/path/HEAD → same tag')
  assert.ok(!c2.lines.some((l) => l.includes('building')), 'second call is a cache hit')
  console.log('cache hit on unchanged content OK')

  // --- new commit changes the repo content: new tag, rebuilds ---
  fs.writeFileSync(path.join(repoDir, 'hello.txt'), 'v2\n')
  await git('add', '-A')
  await git('-c', 'user.email=t@t.test', '-c', 'user.name=t', 'commit', '-q', '-m', 'change content')
  const c3 = collector()
  const tag3 = await m.ensureBuiltImage(REPO_URL, 'Dockerfile', repoDir, c3.log)
  builtTags.push(tag3)
  assert.notEqual(tag3, tag1, 'a new commit changes the tag')
  assert.ok(c3.lines.some((l) => l.includes('building')), 'changed content rebuilds')
  console.log('tag changes with commit + rebuild OK')

  console.log('env-image-build.test: PASS')
} finally {
  for (const tag of builtTags) await pexecFile('docker', ['rmi', '-f', tag]).catch(() => {})
  fs.rmSync(repoDir, { recursive: true, force: true })
  fs.rmSync(outfile, { force: true })
}
