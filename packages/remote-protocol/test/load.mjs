// Bundles the package's TypeScript for a test and imports it. The bundle is
// built for esbuild's `neutral` platform, so a Node built-in reached from
// src/ fails the build here — the same guarantee tsconfig.json gives for
// types, applied to what actually ships to Hermes.
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Read a file of testdata/ as JSON. */
export const testdata = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'testdata', name), 'utf8'))

export const TESTDATA_DIR = path.join(ROOT, 'testdata')

/** The package, bundled and imported. */
export async function loadProtocol() {
  const outfile = path.join(os.tmpdir(), `gurt-remote-protocol-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`)
  await build({
    entryPoints: [path.join(ROOT, 'src/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    logLevel: 'silent',
    outfile
  })
  try {
    return await import(pathToFileURL(outfile).href)
  } finally {
    fs.rmSync(outfile, { force: true })
  }
}
