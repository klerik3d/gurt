// Integration test for the Dockerfile-env image cache (real git + real docker,
// no electron, no network — `FROM scratch` needs no image pull):
// `ensureBuiltImage` builds the *given* Dockerfile content (never re-reading
// the repo's own file), tags by (repoUrl, content, HEAD), reuses the cached
// image on unchanged input, and rebuilds when either the edited content or
// the repo's committed content changes.
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
const writeTo = path.join(os.tmpdir(), `gurt-image-build-dockerfile-${process.pid}`)
const git = (...args) => pexecFile('git', ['-C', repoDir, ...args])
const REPO_URL = 'https://example.com/gurt-image-build-test.git'
const DOCKERFILE_V1 = 'FROM scratch\nCOPY hello.txt /hello.txt\n'
const DOCKERFILE_V2 = 'FROM scratch\nCOPY hello.txt /hello.txt\nLABEL edited=true\n'
const builtTags = new Set()

function collector() {
  const lines = []
  return { log: (line) => lines.push(line), lines }
}

async function ensure(content) {
  const c = collector()
  const tag = await m.ensureBuiltImage(REPO_URL, content, repoDir, writeTo, c.log)
  builtTags.add(tag)
  return { tag, built: c.lines.some((l) => l.includes('building')) }
}

try {
  await git('init', '-q')
  fs.writeFileSync(path.join(repoDir, 'hello.txt'), 'v1\n')
  await git('add', '-A')
  await git('-c', 'user.email=t@t.test', '-c', 'user.name=t', 'commit', '-q', '-m', 'init')

  // --- first call: builds and tags ---
  const r1 = await ensure(DOCKERFILE_V1)
  assert.match(r1.tag, /^gurt-env:[0-9a-f]{16}$/, 'tag has the expected shape')
  assert.ok(r1.built, 'first call actually builds')
  assert.equal(fs.readFileSync(writeTo, 'utf8'), DOCKERFILE_V1, 'writes exactly the given content')

  // --- second call, same content: cache hit, no rebuild ---
  const r2 = await ensure(DOCKERFILE_V1)
  assert.equal(r2.tag, r1.tag, 'same repo/content/HEAD → same tag')
  assert.ok(!r2.built, 'second call is a cache hit')
  console.log('cache hit on unchanged content OK')

  // --- editing the Dockerfile content (same repo HEAD): new tag, rebuilds ---
  const r3 = await ensure(DOCKERFILE_V2)
  assert.notEqual(r3.tag, r1.tag, 'editing the content changes the tag')
  assert.ok(r3.built, 'edited content rebuilds')
  console.log('editing content changes tag + rebuilds OK')

  // --- new commit changes the repo content (same Dockerfile text): new tag ---
  fs.writeFileSync(path.join(repoDir, 'hello.txt'), 'v2\n')
  await git('add', '-A')
  await git('-c', 'user.email=t@t.test', '-c', 'user.name=t', 'commit', '-q', '-m', 'change content')
  const r4 = await ensure(DOCKERFILE_V1)
  assert.notEqual(r4.tag, r1.tag, 'a new commit changes the tag even with unchanged Dockerfile text')
  assert.ok(r4.built, 'changed repo content rebuilds')
  console.log('repo content change changes tag + rebuilds OK')

  console.log('env-image-build.test: PASS')
} finally {
  for (const tag of builtTags) await pexecFile('docker', ['rmi', '-f', tag]).catch(() => {})
  fs.rmSync(repoDir, { recursive: true, force: true })
  fs.rmSync(writeTo, { force: true })
  fs.rmSync(outfile, { force: true })
}
