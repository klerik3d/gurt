// The review loop's UI logic that needs no DOM (docs/requirements-review-loop.md
// §3, §5.2, fix round 6): the status line's polling order, Settings → Repos'
// save of a new local repo with its check / review defaults, and the shared
// choice group's markup. The wiring that does need the app — the prefill with
// the Config tab never opened, local creation through the modal, the keyboard
// path through the reviewer picker — is scripts/smoke-review-block.mjs.
//
//   node --test scripts/review-loop-ui.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { bundle } from './lib/bundle.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-review-ui-'))
const outfile = path.join(dir, 'ui.mjs')
const root = path.resolve(import.meta.dirname, '..')
const S = (rel) => JSON.stringify(path.join(root, rel))
await bundle({
  stdin: {
    contents: `
      export { pollLatest } from ${S('src/renderer/src/pollLatest.ts')}
      export { saveRepo } from ${S('src/renderer/src/components/settings/repoSave.ts')}
      export { ChoiceGroup } from ${S('src/renderer/src/components/ChoiceGroup.tsx')}
      export { createElement } from 'react'
      export { renderToStaticMarkup } from 'react-dom/server'
    `,
    resolveDir: root,
    loader: 'tsx'
  },
  jsx: 'automatic',
  banner: { js: "import { createRequire as __gurtRequire } from 'node:module'; const require = __gurtRequire(import.meta.url);" },
  outfile
})
const U = await import(pathToFileURL(outfile).href)
after(() => fs.rmSync(dir, { recursive: true, force: true }))

const settle = () => new Promise((resolve) => setImmediate(resolve))

// --- the status line's polling ------------------------------------------------------------

/** A `read` whose answers the test hands out by hand, in any order. */
function deferredReads() {
  const answers = []
  return { answers, read: () => new Promise((resolve, reject) => answers.push({ resolve, reject })) }
}

test('a slow earlier answer does not overwrite a newer phase', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { answers, read } = deferredReads()
  const shown = []
  const stop = U.pollLatest(read, (s) => shown.push(s), assert.ifError, 4000)
  t.mock.timers.tick(4000) // the first read is still out when the second goes
  assert.equal(answers.length, 2)
  answers[1].resolve('delivering')
  await settle()
  answers[0].resolve('checking')
  await settle()
  assert.deepEqual(shown, ['delivering'], 'the late, older answer is dropped')
  stop()
})

test('answers in order are all shown, and an older one is still shown while nothing newer has landed', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { answers, read } = deferredReads()
  const shown = []
  const stop = U.pollLatest(read, (s) => shown.push(s), assert.ifError, 4000)
  t.mock.timers.tick(4000)
  t.mock.timers.tick(4000)
  assert.equal(answers.length, 3)
  // Reads 1 and 2 answer after read 3 was asked — but before anything newer
  // than them landed — so a steady stream of ticks cannot starve the display.
  answers[0].resolve('r1')
  await settle()
  answers[1].resolve('r2')
  await settle()
  answers[2].resolve('r3')
  await settle()
  assert.deepEqual(shown, ['r1', 'r2', 'r3'])
  stop()
})

test('a failed read is reported and does not stop the next one; nothing is shown after stop', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { answers, read } = deferredReads()
  const shown = []
  const failed = []
  const stop = U.pollLatest(read, (s) => shown.push(s), (e) => failed.push(e), 4000)
  answers[0].reject(new Error('no loop'))
  await settle()
  assert.equal(failed.length, 1)
  t.mock.timers.tick(4000)
  answers[1].resolve('ok')
  await settle()
  assert.deepEqual(shown, ['ok'])
  t.mock.timers.tick(4000)
  stop()
  answers[2].resolve('late')
  await settle()
  t.mock.timers.tick(8000)
  assert.deepEqual(shown, ['ok'], 'a read that answers after stop is not shown')
  assert.equal(answers.length, 3, 'and no more are asked')
})

// --- Settings → Repos: save ------------------------------------------------------------------

/** A fake `window.gurt` repo surface that records its calls. */
function repoApi({ failUpdate = false, failCreate = false } = {}) {
  const calls = []
  return {
    calls,
    addRepo: async (ws, repo) => void calls.push(['addRepo', ws, repo]),
    updateRepo: async (ws, repo) => {
      calls.push(['updateRepo', ws, repo])
      if (failUpdate) throw new Error('workspace.json is read-only')
    },
    createLocalRepo: async (ws, name) => {
      calls.push(['createLocalRepo', ws, name])
      if (failCreate) throw new Error(`repo "${name}" already exists in "${ws}"`)
      return { name, url: `/gurt/${ws}/repos/${name}.git`, local: true }
    }
  }
}
const review = { enabled: true, agent: 'a2', maxRounds: 4, whenClean: 'merge' }

test('creating a local repo persists the check and review defaults the modal collected', async () => {
  const api = repoApi()
  // `url` is whatever was typed before "new, local" was picked: it is not the repo’s.
  const draft = { name: 'fresh', url: 'https://github.com/typed/then-abandoned', check: 'npm test', review }
  assert.deepEqual(await U.saveRepo(api, 'w', draft, 'create-local'), { ok: true })
  assert.deepEqual(api.calls, [
    ['createLocalRepo', 'w', 'fresh'],
    ['updateRepo', 'w', { name: 'fresh', url: '/gurt/w/repos/fresh.git', local: true, check: 'npm test', review }]
  ])
})

test('creating a local repo with nothing to configure is the one create call', async () => {
  const api = repoApi()
  assert.deepEqual(await U.saveRepo(api, 'w', { name: 'bare', url: '' }, 'create-local'), { ok: true })
  assert.deepEqual(api.calls, [['createLocalRepo', 'w', 'bare']])
})

test('created but not configured: the error says so and names the repo that now exists', async () => {
  const api = repoApi({ failUpdate: true })
  const draft = { name: 'fresh', url: '', check: 'npm test', review }
  const result = await U.saveRepo(api, 'w', draft, 'create-local')
  assert.equal(result.ok, false)
  assert.match(result.error, /read-only/)
  assert.deepEqual(result.created, { name: 'fresh', url: '/gurt/w/repos/fresh.git', local: true })
  // The modal carries on as an edit of `created`: saving again is an update, never a second create.
  const retry = repoApi()
  assert.deepEqual(await U.saveRepo(retry, 'w', draft, 'update'), { ok: true })
  assert.deepEqual(retry.calls.map((c) => c[0]), ['updateRepo'])
})

test('a create that fails writes nothing and reports no repo', async () => {
  const api = repoApi({ failCreate: true })
  const result = await U.saveRepo(api, 'w', { name: 'dup', url: '', check: 'npm test' }, 'create-local')
  assert.equal(result.ok, false)
  assert.match(result.error, /already exists/)
  assert.equal('created' in result, false)
  assert.deepEqual(api.calls.map((c) => c[0]), ['createLocalRepo'])
})

test('add and update hand the draft over as it is', async () => {
  const api = repoApi()
  const draft = { name: 'r', url: 'https://github.com/o/r', check: 'make', review }
  assert.deepEqual(await U.saveRepo(api, 'w', draft, 'add'), { ok: true })
  assert.deepEqual(await U.saveRepo(api, 'w', draft, 'update'), { ok: true })
  assert.deepEqual(api.calls, [['addRepo', 'w', draft], ['updateRepo', 'w', draft]])
})

// --- the shared choice group --------------------------------------------------------------------

test('a choice group is a radio group with its value lit and, on request, the value as a data attribute', () => {
  const html = U.renderToStaticMarkup(
    U.createElement(U.ChoiceGroup, {
      label: 'review rounds',
      dataKey: 'rounds',
      choices: [1, 2, 3].map((n) => ({ value: n, text: n })),
      value: 2,
      onPick: () => {}
    })
  )
  assert.match(html, /role="radiogroup" aria-label="review rounds"/)
  const chips = [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0])
  assert.equal(chips.length, 3)
  assert.deepEqual(chips.map((c) => /aria-checked="true"/.test(c)), [false, true, false])
  assert.deepEqual(chips.map((c) => /data-rounds="(\d)"/.exec(c)?.[1]), ['1', '2', '3'])
  assert.match(chips[1], /class="chip-btn on"/)
  // No value lit (a rung the repos cannot deliver): nothing is checked.
  const none = U.renderToStaticMarkup(
    U.createElement(U.ChoiceGroup, { label: 'when clean', choices: [{ value: 'push', text: 'push' }], value: undefined, onPick: () => {} })
  )
  assert.doesNotMatch(none, /aria-checked="true"|data-/)
})
