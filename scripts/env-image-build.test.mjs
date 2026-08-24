// Integration test for the env image build (real git + real docker, no
// electron, no network — `FROM scratch` needs no image pull): `buildEnvImage`
// writes the env's *own* devcontainer + Dockerfile content into the snapshot's
// `.devcontainer/` (overwriting the repo's versions — never re-reading them),
// tags by (repo url, commit, dockerfile content, build config), reuses the
// cached image on unchanged input, and rebuilds when the dockerfile content,
// the build args, or the commit change.
//
//   node scripts/env-image-build.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
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

await bundle({
  stdin: {
    contents: `export { buildEnvImage } from ${S('src/main/provision.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  external: ['electron'],
  outfile
})

const m = await import(pathToFileURL(outfile).href)

const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-image-build-repo-'))
const git = (...args) => pexecFile('git', ['-C', repoDir, ...args])
const commit = async () => (await git('rev-parse', 'HEAD')).stdout.trim()
const REPO = { name: 'r', url: 'https://example.com/gurt-image-build-test.git' }
const DOCKERFILE_V1 = 'FROM scratch\nCOPY hello.txt /hello.txt\n'
const DOCKERFILE_V2 = 'FROM scratch\nCOPY hello.txt /hello.txt\nLABEL edited=true\n'
const envCfg = (dockerfile, buildExtra = {}) => ({
  name: 'e',
  devcontainer: JSON.stringify({ build: { dockerfile: 'Dockerfile', ...buildExtra } }),
  dockerfile
})
const builtTags = new Set()

async function ensure(cfg) {
  const lines = []
  const tag = await m.buildEnvImage(REPO, cfg, repoDir, await commit(), (l) => lines.push(l))
  builtTags.add(tag)
  return { tag, built: lines.some((l) => l.includes('building')) }
}

after(async () => {
  for (const tag of builtTags) await pexecFile('docker', ['rmi', '-f', tag]).catch(() => {})
  fs.rmSync(repoDir, { recursive: true, force: true })
  fs.rmSync(outfile, { force: true })
})

await git('init', '-q')
fs.writeFileSync(path.join(repoDir, 'hello.txt'), 'v1\n')
// The repo's own .devcontainer/Dockerfile is a decoy: the env's content must
// overwrite it in the snapshot, or the build fails on the bogus instruction.
fs.mkdirSync(path.join(repoDir, '.devcontainer'))
fs.writeFileSync(path.join(repoDir, '.devcontainer', 'Dockerfile'), 'NOT A DOCKERFILE\n')
await git('add', '-A')
await git('-c', 'user.email=t@t.test', '-c', 'user.name=t', 'commit', '-q', '-m', 'init')

// The baseline build every later test compares its tag against.
let r1

// --- first call: builds and tags; env content overwrites the repo's file ---
test('first call builds and tags; env content overwrites the repo file', async () => {
  r1 = await ensure(envCfg(DOCKERFILE_V1))
  assert.match(r1.tag, /^gurt-env:[0-9a-f]{16}$/, 'tag has the expected shape')
  assert.ok(r1.built, 'first call actually builds')
  assert.equal(
    fs.readFileSync(path.join(repoDir, '.devcontainer', 'Dockerfile'), 'utf8'),
    DOCKERFILE_V1,
    'the env Dockerfile content overwrites the repo copy in the snapshot'
  )
})

// --- second call, same content: cache hit, no rebuild ---
test('cache hit on unchanged content', async () => {
  const r2 = await ensure(envCfg(DOCKERFILE_V1))
  assert.equal(r2.tag, r1.tag, 'same repo/content/commit → same tag')
  assert.ok(!r2.built, 'second call is a cache hit')
})

// --- editing the Dockerfile content (same commit): new tag, rebuilds ---
test('editing content changes tag + rebuilds', async () => {
  const r3 = await ensure(envCfg(DOCKERFILE_V2))
  assert.notEqual(r3.tag, r1.tag, 'editing the content changes the tag')
  assert.ok(r3.built, 'edited content rebuilds')
})

// --- changing the build args (same content, same commit): new tag ---
test('build args change changes tag + rebuilds', async () => {
  const r4 = await ensure(envCfg(DOCKERFILE_V1, { args: { EXTRA: '1' } }))
  assert.notEqual(r4.tag, r1.tag, 'changed build args change the tag')
  assert.ok(r4.built, 'changed build args rebuild')
})

// --- new commit changes the repo content (same Dockerfile text): new tag ---
test('repo content change changes tag + rebuilds', async () => {
  fs.writeFileSync(path.join(repoDir, 'hello.txt'), 'v2\n')
  await git('add', '-A')
  await git('-c', 'user.email=t@t.test', '-c', 'user.name=t', 'commit', '-q', '-m', 'change content')
  const r5 = await ensure(envCfg(DOCKERFILE_V1))
  assert.notEqual(r5.tag, r1.tag, 'a new commit changes the tag even with unchanged Dockerfile text')
  assert.ok(r5.built, 'changed repo content rebuilds')
})

// --- ${localWorkspaceFolder} in dockerfile/context: substituted with the
// snapshot root, so COPY sees the repo files (regression: it used to become
// a literal directory name holding only the written Dockerfile) ---
test('${localWorkspaceFolder} substitution', async () => {
  const r6 = await ensure(
    envCfg(DOCKERFILE_V1, {
      dockerfile: '${localWorkspaceFolder}/Dockerfile',
      context: '${localWorkspaceFolder}'
    })
  )
  assert.ok(r6.built, '${localWorkspaceFolder} form builds')
  assert.equal(
    fs.readFileSync(path.join(repoDir, 'Dockerfile'), 'utf8'),
    DOCKERFILE_V1,
    'dockerfile written at the substituted path (snapshot root)'
  )
})
