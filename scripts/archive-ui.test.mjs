import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { bundle } from './lib/bundle.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-archive-ui-'))
const outfile = path.join(dir, 'ui.mjs')
const root = path.resolve(import.meta.dirname, '..')
await bundle({
  stdin: { contents: `
    export { ArchiveChat } from ${JSON.stringify(path.join(root, 'src/renderer/src/components/Chat.tsx'))}
    export { createElement } from 'react'
    export { renderToStaticMarkup } from 'react-dom/server'
  `, resolveDir: root, loader: 'tsx' },
  jsx: 'automatic',
  banner: { js: "import { createRequire as __gurtRequire } from 'node:module'; const require = __gurtRequire(import.meta.url);" },
  outfile
})
// The normal chat module installs one passive MCP-failure subscription at
// import. No active API is provided: archived rendering must not need one.
Object.defineProperty(globalThis, 'window', { configurable: true, value: { gurt: { onMcpFail: () => () => {} } } })
const { ArchiveChat, createElement, renderToStaticMarkup } = await import(pathToFileURL(outfile).href)
after(() => fs.rmSync(dir, { recursive: true, force: true }))

test('archived chat renders conversation and tool history with no composer or permission actions', () => {
  const entries = [
    { id: 1, kind: 'user', text: 'Important question' },
    { id: 2, kind: 'agent', text: '**Saved answer**' },
    { id: 3, kind: 'tool', toolCallId: 'tool', title: 'run tests', status: 'completed', detail: 'passed' },
    { id: 4, kind: 'permission', title: 'Permission needed', options: [{ optionId: 'allow', name: 'Grant access', kind: 'allow_once' }] }
  ]
  const html = renderToStaticMarkup(createElement(ArchiveChat, { entries, sessionId: 'archived' }))
  assert.match(html, /Important question/)
  assert.match(html, /<strong>Saved answer<\/strong>/)
  assert.match(html, /run tests/)
  assert.match(html, /Permission needed/)
  assert.doesNotMatch(html, /Grant access|textarea|Session actions|Container terminal/)
})
