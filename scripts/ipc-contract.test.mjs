// The renderer-facing API has three independent listings that must agree:
//
//   src/shared/api.ts     API_METHODS  — the one source of truth
//   src/main/ipc.ts       `impl`       — what main actually answers with
//   src/preload/index.ts  window.gurt  — what the renderer can call
//
// TypeScript already checks `const impl: GurtApi` covers `GurtApi` exactly, but
// only while `GurtApi`, `METHODS` and `impl` are all in sync at compile time —
// nothing checks the *runtime* list `API_METHODS`, which is what preload loops
// over and what `ipcMain.handle` registers. A method typed into `GurtApi` but
// missing from `METHODS` is a compile error; a method left out of the runtime
// listing while still typed is exactly the "the type says it exists, the call
// hangs" bug this test exists to catch.
//
// How each side is read:
//   API_METHODS — bundled and imported for real (shared/api.ts is dependency-free).
//   preload     — bundled with a stub `electron`, then run; the object handed to
//                 `contextBridge.exposeInMainWorld` is the real thing.
//   impl        — extracted *statically* from the source text. Running it would
//                 mean calling `registerIpc()`, which builds the whole kernel,
//                 arms a `setInterval` and kicks off a plan-usage network poll —
//                 none of which belongs in a unit test. `impl` is also a local
//                 inside `registerIpc()`, so no amount of module stubbing
//                 exposes it. The extractor below is a small brace/string/
//                 comment scanner over the object literal, which is exact for
//                 the shape this file has (a flat object literal of
//                 `identifier:` properties) and fails loudly if that shape ever
//                 changes.
//
//   node scripts/ipc-contract.test.mjs
import { test, after } from 'node:test'
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-ipc-contract-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

/** Minimal `electron` stand-in: preload only touches contextBridge/ipcRenderer. */
const electronStub = {
  name: 'stub-electron',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub-electron' }))
    b.onLoad({ filter: /.*/, namespace: 'stub-electron' }, () => ({
      loader: 'js',
      contents: `
        export const contextBridge = {
          exposeInMainWorld(key, value) { globalThis.__exposed = { key, value } }
        }
        export const ipcRenderer = {
          on() {}, removeListener() {},
          send() {}, sendSync() { return 'info' },
          invoke(channel, ...args) { return Promise.resolve({ channel, args }) }
        }
        export default { contextBridge, ipcRenderer }
      `
    }))
  }
}

/**
 * Top-level keys of the object literal that starts at `header` in `src`.
 *
 * Walks the literal character by character, tracking line/block comments and
 * single/double/template strings, so a brace inside a comment or a `${}` inside
 * a template cannot be mistaken for structure. Property names are collected at
 * nesting depth 1 only.
 */
function objectLiteralKeys(src, header) {
  const at = src.indexOf(header)
  assert.ok(at >= 0, `ipc.ts no longer contains \`${header}\` — update this test`)
  let i = src.indexOf('{', at)
  // Mask comments and string bodies with spaces, preserving offsets, so the
  // depth walk and the key regex below only ever see code.
  const masked = src.split('')
  let depth = 0
  let mode = 'code'
  let quote = ''
  for (; i < src.length; i++) {
    const c = src[i]
    const next = src[i + 1]
    if (mode === 'line') {
      if (c === '\n') mode = 'code'
      else masked[i] = ' '
      continue
    }
    if (mode === 'block') {
      if (c === '*' && next === '/') {
        masked[i] = masked[i + 1] = ' '
        i++
        mode = 'code'
      } else if (c !== '\n') masked[i] = ' '
      continue
    }
    if (mode === 'string') {
      masked[i] = ' '
      if (c === '\\') {
        masked[i + 1] = ' '
        i++
      } else if (c === quote) mode = 'code'
      continue
    }
    if (c === '/' && next === '/') {
      masked[i] = masked[i + 1] = ' '
      i++
      mode = 'line'
      continue
    }
    if (c === '/' && next === '*') {
      masked[i] = masked[i + 1] = ' '
      i++
      mode = 'block'
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      mode = 'string'
      quote = c
      masked[i] = ' '
      continue
    }
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') {
      depth--
      if (depth === 0) break
    }
  }
  assert.equal(mode, 'code', `unterminated string/comment while scanning \`${header}\``)
  assert.equal(depth, 0, `unbalanced braces while scanning \`${header}\``)
  const body = masked.slice(src.indexOf('{', at), i + 1).join('')

  // Second pass over the masked body: record keys seen at depth 1.
  const keys = []
  let d = 0
  for (let j = 0; j < body.length; j++) {
    const c = body[j]
    if (c === '{' || c === '(' || c === '[') {
      d++
      // The literal's own opening brace: the first property starts right here.
      if (d === 1 && c === '{') pushKey(keys, body, j)
      continue
    }
    if (c === '}' || c === ')' || c === ']') {
      d--
      continue
    }
    // A comma at depth 1 separates two of the literal's own properties.
    if (d === 1 && c === ',') pushKey(keys, body, j)
  }
  assert.ok(keys.length > 0, `no properties found in \`${header}\` — the extractor needs updating`)
  return keys
}

/** Record the `identifier:` property starting just after `body[j]`, if any. */
function pushKey(keys, body, j) {
  const m = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(body.slice(j + 1))
  if (m) keys.push(m[1])
}

/** `a` minus `b`, as a sorted list. */
const missing = (a, b) => [...a].filter((x) => !b.has(x)).sort()

await build({
  stdin: {
    contents: `
      export { API_METHODS } from ${S('src/shared/api.ts')}
      import ${S('src/preload/index.ts')}
    `,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  // jsonc-parser's `main` is a UMD build esbuild can't wrap into ESM output —
  // prefer each package's ESM entry, like vite does.
  mainFields: ['module', 'main'],
  outfile,
  logLevel: 'silent',
  plugins: [electronStub]
})

const { API_METHODS } = await import(pathToFileURL(outfile).href)
const apiSet = new Set(API_METHODS)
const bridged = globalThis.__exposed
const api = bridged.value
const ipcSrc = fs.readFileSync(path.join(ROOT, 'src/main/ipc.ts'), 'utf8')

// --- API_METHODS itself is a clean listing ---
test('API_METHODS itself is a clean listing', () => {
  assert.ok(Array.isArray(API_METHODS) && API_METHODS.length > 0, 'API_METHODS is a non-empty list')
  assert.equal(apiSet.size, API_METHODS.length, 'API_METHODS has no duplicate entries')
  console.log(`API_METHODS: ${API_METHODS.length} methods`)
})

// --- preload: `window.gurt` carries exactly these methods ---
test('preload bridges every API_METHODS entry onto its own channel', async () => {
  assert.ok(bridged, 'preload called contextBridge.exposeInMainWorld')
  assert.equal(bridged.key, 'gurt', 'the bridge is exposed as `window.gurt`')

  for (const m of API_METHODS)
    assert.equal(typeof api[m], 'function', `window.gurt.${m} is bridged as a function`)

  // Each bridged method must invoke *its own* `api:<method>` channel — a loop
  // that captured the wrong variable would wire every method to the last one.
  for (const m of API_METHODS) {
    const sent = await api[m]('x', 'y')
    assert.equal(sent.channel, `api:${m}`, `window.gurt.${m} invokes api:${m}`)
    assert.deepEqual(sent.args, ['x', 'y'], `window.gurt.${m} forwards its arguments verbatim`)
  }
})

// Everything else on the bridge is deliberate (logging + event subscriptions);
// a stray extra key here is a method that skipped API_METHODS.
test('preload exposes nothing beyond API_METHODS + the known event hooks', () => {
  const NON_METHOD_KEYS = new Set([
    'log',
    'logLevel',
    'onTreeChanged',
    'onSessionChanged',
    'onSessionLog',
    'onSessionTurn',
    'onProvisionLog',
    'onNotification',
    'onNotificationRead',
    'onUsageChanged',
    'onBootProgress'
  ])
  const extra = Object.keys(api).filter((k) => !apiSet.has(k) && !NON_METHOD_KEYS.has(k))
  assert.deepEqual(extra, [], `window.gurt exposes keys that are neither API methods nor known event hooks: ${extra}`)
  // …and nothing an API method would shadow.
  for (const k of NON_METHOD_KEYS)
    assert.ok(!apiSet.has(k), `API method "${k}" collides with a preload helper of the same name`)
})

// --- main: `impl` covers exactly API_METHODS ---
test('ipc.ts impl covers all API methods, and nothing else', () => {
  const implKeys = objectLiteralKeys(ipcSrc, 'const impl: GurtApi = {')
  const implSet = new Set(implKeys)
  assert.equal(implSet.size, implKeys.length, `ipc.ts \`impl\` has a duplicate key: ${implKeys}`)

  const notImplemented = missing(apiSet, implSet)
  assert.deepEqual(
    notImplemented,
    [],
    `API_METHODS lists methods ipc.ts \`impl\` does not implement (the renderer would hang on them): ${notImplemented}`
  )
  const notListed = missing(implSet, apiSet)
  assert.deepEqual(
    notListed,
    [],
    `ipc.ts \`impl\` implements methods missing from API_METHODS (never registered, never bridged): ${notListed}`
  )
})

// The registration loop is what turns the listing into live channels — if it
// ever stops walking API_METHODS, the two lists above stop meaning anything.
test('both sides still derive their surface from API_METHODS', () => {
  assert.ok(
    /for \(const m of API_METHODS\)\s*\n?\s*ipcMain\.handle\(`api:\$\{m\}`/.test(ipcSrc),
    'ipc.ts still registers one `api:<method>` handler per API_METHODS entry'
  )
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'src/preload/index.ts'), 'utf8')
  assert.ok(
    /for \(const m of API_METHODS\) api\[m\] =/.test(preloadSrc),
    'preload/index.ts still derives the bridge from API_METHODS'
  )
})

after(() => {
  fs.rmSync(outfile, { force: true })
})
