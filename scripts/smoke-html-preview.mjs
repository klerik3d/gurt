// Real Electron: an HTML file in the file view opens as an inert preview, like
// a Markdown file — and a hostile one runs no script and reaches no network.
// npm run build && DISPLAY=:99 node scripts/smoke-html-preview.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Anything the preview fetches lands here: it must stay empty.
const hits = []
const server = createServer((req, res) => { hits.push(req.url); res.end('') })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const remote = `http://127.0.0.1:${server.address().port}`

const appDir = fileURLToPath(new URL('..', import.meta.url))
const scratch = fs.mkdtempSync(path.join(process.env.SCRATCH ?? os.tmpdir(), 'gurt-html-preview-'))
const root = path.join(scratch, 'store')
const scope = path.join(root, 'demo', 'first')
const repo = path.join(scope, 'frontend')
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.test', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
fs.mkdirSync(path.join(repo, 'docs'), { recursive: true })
// A 1×1 PNG, referenced relatively: read from the scope like a Markdown image.
fs.writeFileSync(path.join(repo, 'docs', 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'))
fs.writeFileSync(path.join(repo, 'docs', 'other.md'), '# Other\n')
fs.writeFileSync(path.join(repo, 'docs', 'page.html'), `<!doctype html>
<html><head>
<meta http-equiv="refresh" content="0;url=${remote}/refresh">
<base href="${remote}/base/">
<link rel="stylesheet" href="${remote}/link.css">
<style>@import url("${remote}/import.css"); body { background: url("${remote}/bg.png") } h1 { color: rgb(1, 2, 3) }</style>
<script>parent.__pwned = 'script'</script>
</head><body>
<h1 id="top">Report</h1>
<img id="local" src="dot.png" alt="dot">
<img id="remote" src="${remote}/pixel.png" alt="pixel">
<img src="x" onerror="parent.__pwned = 'onerror'">
<svg><image href="${remote}/svg.png" width="1" height="1"/><script>parent.__pwned = 'svg'</script></svg>
<template shadowrootmode="open"><img src="${remote}/shadow.png"><slot></slot></template>
<iframe src="${remote}/frame"></iframe><object data="${remote}/object"></object>
<form action="${remote}/form"><button id="submit">Send</button></form>
<a id="js" href="javascript:parent.__pwned = 'href'">js</a>
<a id="file" href="other.md">other</a>
<a id="web" href="${remote}/web">web</a>
<a id="jump" href="#end">jump</a>
<p style="height: 3000px">tall</p><h2 id="end">End</h2>
</body></html>
`)
git(repo, 'init', '-b', 'first')
git(repo, 'add', '-A')
git(repo, 'commit', '-m', 'initial')
fs.writeFileSync(path.join(scope, 'task.json'), JSON.stringify({ createdAt: '2026-02-01T00:00:00Z' }))
fs.writeFileSync(path.join(scope, 'sessions.json'), JSON.stringify([{ info: {
  id: 'draft-session', workspace: 'demo', task: 'first', env: 'dev', repos: ['frontend'], title: 'Build files', state: 'draft'
} }]))
fs.writeFileSync(path.join(root, 'demo', 'workspace.json'), JSON.stringify({
  repos: [{ name: 'frontend', url: repo }], envs: [{ name: 'dev', image: 'unused' }]
}))

const require = createRequire(path.join(appDir, 'package.json'))
const { _electron } = require('playwright-core')
const env = { ...process.env, GURT_ROOT: root, GURT_WELCOME: 'never' }
delete env.ELECTRON_RUN_AS_NODE
const app = await _electron.launch({ executablePath: require('electron'), args: [appDir, '--no-sandbox', `--user-data-dir=${path.join(scratch, 'profile')}`], env })
const errors = []
try {
  // Web links go to the OS browser: record them instead. The buffer is left
  // unsaved: quitting discards it instead of asking.
  await app.evaluate(({ shell, dialog }) => {
    globalThis.__opened = []
    shell.openExternal = async (url) => { globalThis.__opened.push(url) }
    dialog.showMessageBoxSync = () => 1
  })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.waitForSelector('.sb-session')
  await page.locator('.sb-session').click()
  await page.keyboard.press('Control+5')
  const row = (title) => page.getByRole('tree', { name: 'Scope files' }).locator(`[role="treeitem"][title="${title}"]`)
  await row('frontend').click()
  await row('frontend/docs').click()
  await row('frontend/docs/page.html').click()

  const frame = page.frameLocator('iframe.file-html')
  await frame.locator('h1').waitFor()
  assert.equal(await page.locator('iframe.file-html').getAttribute('sandbox'), 'allow-same-origin', 'no allow-scripts')
  assert.equal(await page.getByRole('radio', { name: 'Preview' }).getAttribute('aria-checked'), 'true', 'HTML opens rendered')
  assert.equal(await frame.locator('h1').evaluate((el) => getComputedStyle(el).color), 'rgb(1, 2, 3)', 'the file\'s own styles apply')
  await frame.locator('#local[src^="data:image/png"]').waitFor()
  assert.equal(await frame.locator('#remote').getAttribute('src'), null, 'remote image dropped')
  for (const selector of ['script', 'iframe', 'object', 'base', 'link', 'meta:not([http-equiv="Content-Security-Policy"])', '[onerror]', 'template[shadowrootmode]']) {
    assert.equal(await frame.locator(selector).count(), 0, `${selector} removed`)
  }
  assert.equal(await frame.locator('#js').getAttribute('href'), null, 'javascript: link removed')
  assert.equal(await frame.locator('body').evaluate((el) => el.shadowRoot), null, 'no declarative shadow root, which the sanitizer would not have seen')

  // Links: in-document scrolls, a scope file opens in the file view, a web
  // link goes to the browser; the frame itself never navigates.
  await frame.locator('#submit').click()
  await frame.locator('#js').click()
  await frame.locator('#jump').click()
  await page.waitForFunction(() => document.querySelector('iframe.file-html').contentWindow.scrollY > 1000)
  await frame.locator('#web').click()
  for (let i = 0; i < 50 && !(await app.evaluate(() => globalThis.__opened.length)); i++) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(await app.evaluate(() => globalThis.__opened), [`${remote}/web`])
  assert.equal(await frame.locator('h1').innerText(), 'Report', 'frame still shows the file')
  await new Promise((resolve) => setTimeout(resolve, 1500))
  assert.equal(await page.evaluate(() => window.__pwned), undefined, 'no script of the file ran')
  assert.deepEqual(hits, [], 'the preview made no network request')
  await frame.locator('#file').click()
  await page.waitForFunction(() => document.querySelector('.file-tab.active')?.textContent?.includes('other.md'))

  // Edit shows the source; the preview follows the unsaved buffer.
  await page.getByRole('tab', { name: 'page.html' }).click()
  await page.getByRole('radio', { name: 'Edit' }).click()
  await page.locator('.files-pane .cm-content').waitFor()
  await page.locator('.files-pane .cm-content').click()
  await page.keyboard.press('Control+Home')
  await page.keyboard.type('<p id="draft">unsaved</p>')
  await page.getByRole('radio', { name: 'Preview' }).click()
  await page.frameLocator('iframe.file-html').locator('#draft').waitFor()
  assert.equal(await page.evaluate(() => window.__pwned), undefined)
  assert.deepEqual(hits, [])
  assert.deepEqual(errors, [], 'no renderer errors')

  // The sanitizer parses the raw file with DOMParser in the app's own page.
  // That parse must fetch nothing by itself — not merely be stopped by the
  // app's CSP — so check it in a page without any CSP, with a control load
  // proving the server is reachable from there.
  const html = fs.readFileSync(path.join(repo, 'docs', 'page.html'), 'utf8')
  const inBlankPage = (script) => app.evaluate(async ({ BrowserWindow }, script) => {
    globalThis.__blank ??= new BrowserWindow({ show: false })
    if (!globalThis.__blank.webContents.getURL()) await globalThis.__blank.loadURL('data:text/html,<!doctype html><title>no csp</title>')
    return globalThis.__blank.webContents.executeJavaScript(script)
  }, script)
  await inBlankPage(`(() => {
    const doc = new DOMParser().parseFromString(${JSON.stringify(html)}, 'text/html')
    for (const el of doc.querySelectorAll('*')) for (const a of el.attributes) a.value
    return doc.documentElement.outerHTML.length
  })()`)
  await new Promise((resolve) => setTimeout(resolve, 1500))
  assert.deepEqual(hits, [], 'parsing the file fetched nothing, even without a CSP')
  await inBlankPage(`new Promise((resolve) => { const img = new Image(); img.onload = img.onerror = resolve; img.src = ${JSON.stringify(`${remote}/control`)} })`)
  assert.deepEqual(hits, ['/control'], 'the server is reachable from that page')
  await app.evaluate(() => globalThis.__blank.destroy())
  await page.screenshot({ path: path.join(scratch, 'html-preview.png') })
  console.log(`PASS html preview: rendered inert, no script or network, links, images, edit/preview. Screenshot: ${scratch}/html-preview.png`)
} finally { await app.close(); server.close() }
