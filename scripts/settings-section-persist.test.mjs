import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { bundle } from './lib/bundle.mjs'

const outfile = path.join(os.tmpdir(), `gurt-settings-section-${process.pid}.mjs`)
await bundle({ entryPoints: ['src/renderer/src/components/SettingsPage.tsx'], outfile, jsx: 'automatic', loader: { '.css': 'empty' } })
const { SETTINGS_SECTIONS } = await import(pathToFileURL(outfile).href)
const persistedOut = path.join(os.tmpdir(), `gurt-settings-section-persisted-${process.pid}.mjs`)
await bundle({ entryPoints: ['src/renderer/src/persisted.ts'], outfile: persistedOut })
const { z } = await import(pathToFileURL(persistedOut).href)

test('every settings section id survives the persisted-preference schema', () => {
  assert.ok(SETTINGS_SECTIONS.includes('masking'))
  const schema = z.enum(SETTINGS_SECTIONS)
  for (const id of SETTINGS_SECTIONS) assert.equal(schema.safeParse(id).success, true, id)
})

test('App.tsx derives its preference schemas from the exported id lists', () => {
  const app = fs.readFileSync('src/renderer/src/App.tsx', 'utf8')
  for (const list of ['SETTINGS_SECTIONS', 'VIEWS', 'WORK_MODES']) assert.match(app, new RegExp(`z\\.enum\\(${list}\\)`))
  assert.doesNotMatch(app, /z\.enum\(\[/)
})
