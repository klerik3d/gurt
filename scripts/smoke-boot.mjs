// Minimal boot smoke: launches the built app (run `npm run build` first, or use
// `npm run smoke`), waits for the UI to render, fails on any renderer console
// error, and drops a screenshot. Selector-free on purpose — it must survive
// redesigns. Scenario smokes live in archive/smokes/ (pre-redesign, kept as
// reference for the acceptance flows they encode).
//
//   node scripts/smoke-boot.mjs
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-smoke-boot-'))

const require = createRequire(path.join(APP_DIR, 'package.json'))
const { _electron } = require('playwright-core')
// require('electron') from plain node resolves to the binary path
const electronPath = require('electron')

const env = { ...process.env, GURT_ROOT }
delete env.ELECTRON_RUN_AS_NODE // inherited from the VSCode extension host shell

const app = await _electron.launch({
  executablePath: electronPath,
  args: [APP_DIR],
  env,
  timeout: 30000
})

try {
  const page = await app.firstWindow()
  const errors = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.waitForSelector('#root > *', { timeout: 15000 })
  await page.waitForTimeout(1000) // let async init (store reads, IPC) surface errors

  const shot = path.join(os.tmpdir(), 'gurt-smoke-boot.png')
  await page.screenshot({ path: shot })

  if (errors.length) {
    console.error('smoke-boot: FAIL — renderer console errors:')
    for (const e of errors) console.error('  ' + e)
    process.exitCode = 1
  } else {
    console.log('smoke-boot: PASS —', shot)
  }
} finally {
  await app.close()
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
}
