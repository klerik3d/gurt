// Whether a session's owned container can be resurrected against its
// *existing* materialized env config, skipping `materializeEnvConfig`
// (containers.ts, `canReuseMaterializedConfig`) — for a `build` env that is a
// `git archive` of the whole repo plus a full tar extraction on every restart
// of a container that already has an image.
//
// The invariant this protects: `devcontainer up` finds an existing container
// by its `gurt.session` id-label and never recreates it, so a config change
// never reaches a container this call merely resumes — skipping the
// materialization on that path loses nothing a rewrite would have delivered.
// Every other path (no owned container, a repo-set change, a materialized
// file that went missing) must still fall through to the real thing, because
// each of those is exactly the case where the file `up` is about to read
// either does not exist yet or does not describe this container.
//
//   node scripts/env-config-reuse.test.mjs
import { test } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

const outfile = path.join(os.tmpdir(), `gurt-env-config-reuse-${process.pid}.mjs`)
await bundle({
  stdin: {
    contents: `export { canReuseMaterializedConfig } from ${S('src/main/containers.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  external: ['electron'],
  outfile
})
const m = await import(pathToFileURL(outfile).href)

const OVERRIDE = '/gurt/w/.devcontainers/dev.json'
const exists = (present) => () => present

test('no owned container at all — always re-materializes', () => {
  assert.equal(m.canReuseMaterializedConfig(undefined, ['alpha'], OVERRIDE, exists(true)), false)
})

test('an owned container with no id yet (never finished an `up`) — re-materializes', () => {
  assert.equal(
    m.canReuseMaterializedConfig({ repos: ['alpha'] }, ['alpha'], OVERRIDE, exists(true)),
    false
  )
})

test('the repo set changed — re-materializes even though the file is right there', () => {
  const owned = { id: 'c1', repos: ['alpha'] }
  assert.equal(m.canReuseMaterializedConfig(owned, ['beta'], OVERRIDE, exists(true)), false)
  assert.equal(m.canReuseMaterializedConfig(owned, ['alpha', 'beta'], OVERRIDE, exists(true)), false)
})

test('repo order counts as a change too — the anchor moved', () => {
  const owned = { id: 'c1', repos: ['alpha', 'beta'] }
  assert.equal(
    m.canReuseMaterializedConfig(owned, ['beta', 'alpha'], OVERRIDE, exists(true)),
    false
  )
})

test('same owned container, same repos, but the materialized file is gone — re-materializes', () => {
  const owned = { id: 'c1', repos: ['alpha'] }
  assert.equal(m.canReuseMaterializedConfig(owned, ['alpha'], OVERRIDE, exists(false)), false)
})

test('owned container, matching repos, file on disk — skips materialization', () => {
  const owned = { id: 'c1', repos: ['alpha'] }
  assert.equal(m.canReuseMaterializedConfig(owned, ['alpha'], OVERRIDE, exists(true)), true)
})

test('a multi-repo session reuses too, as long as the whole ordered set matches', () => {
  const owned = { id: 'c1', repos: ['alpha', 'beta'] }
  assert.equal(
    m.canReuseMaterializedConfig(owned, ['alpha', 'beta'], OVERRIDE, exists(true)),
    true
  )
})

test('the default `exists` really is the filesystem, not a stub that always answers', () => {
  const owned = { id: 'c1', repos: ['alpha'] }
  const missing = path.join(os.tmpdir(), `gurt-env-config-reuse-missing-${process.pid}.json`)
  fs.rmSync(missing, { force: true })
  assert.equal(m.canReuseMaterializedConfig(owned, ['alpha'], missing), false)
  fs.writeFileSync(missing, '{}')
  try {
    assert.equal(m.canReuseMaterializedConfig(owned, ['alpha'], missing), true)
  } finally {
    fs.rmSync(missing, { force: true })
    fs.rmSync(outfile, { force: true })
  }
})
