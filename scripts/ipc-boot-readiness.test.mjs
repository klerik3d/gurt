import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { bundle } from './lib/bundle.mjs'

// Execute the actual renderer-facing handlers with a controlled boot promise.
// No Electron or Docker: the race is whether reads run before restore finishes.
const text = fs.readFileSync('src/main/ipc.ts', 'utf8')
const source = ts.createSourceFile('ipc.ts', text, ts.ScriptTarget.Latest, true)
const handlers = new Map()
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'impl' &&
      node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
    for (const property of node.initializer.properties) {
      if (ts.isPropertyAssignment(property)) handlers.set(property.name.getText(source), property.initializer.getText(source))
    }
  }
  ts.forEachChild(node, visit)
}
visit(source)
assert.ok(handlers.has('getTree') && handlers.has('sessionSnapshot'))
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-boot-reads-'))
const outfile = path.join(directory, 'handlers.mjs')
after(() => fs.rmSync(directory, { recursive: true, force: true }))
await bundle({ stdin: { contents: `
  export const tree = (kernel) => (${handlers.get('getTree')})();
  export const snapshot = (kernel, id) => (${handlers.get('sessionSnapshot')})(id);
`, loader: 'ts', resolveDir: process.cwd() }, outfile })
const reads = await import(pathToFileURL(outfile).href)

test('startup tree cannot clear a persisted selection before sessions are restored', async () => {
  const calls = []
  let restore
  const ready = new Promise((resolve) => { restore = resolve })
  const expected = { workspaces: [{ name: 'personal', tasks: [{ name: 'demo-task', sessions: [{ id: 'selected-session' }] }] }] }
  const request = reads.tree({ ready, tree: async () => { calls.push('tree'); return expected } })
  await Promise.resolve()
  assert.deepEqual(calls, [], 'a partial tree must not reach selection pruning')
  restore()
  assert.deepEqual(await request, expected)
  assert.deepEqual(calls, ['tree'])
})

test('initial selected-session snapshot waits for restore and preserves its configured state', async () => {
  const calls = []
  let restore
  const ready = new Promise((resolve) => { restore = resolve })
  const expected = { info: { id: 'selected-session', state: 'draft', env: 'dev', repos: ['demo'] } }
  const kernel = {
    ready,
    notifications: { markSessionRead: (id) => calls.push(`read:${id}`) },
    sessions: { snapshot: (id) => { calls.push(`snapshot:${id}`); return expected } }
  }
  const request = reads.snapshot(kernel, 'selected-session')
  await Promise.resolve()
  assert.deepEqual(calls, [], 'a premature missing snapshot would never be retried')
  restore()
  assert.deepEqual(await request, expected)
  assert.deepEqual(calls, ['read:selected-session', 'snapshot:selected-session'])
})
