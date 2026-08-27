// docs/logging.md: "`ipc.call`/`ipc.fail` log the call's arguments, redacted, at
// DBG. Methods whose arguments carry prose — `sessionPrompt`, `createSession`,
// `changesCommit`, `setCredentials`, … — log an argument *count* instead, never
// the values." That promise is one `Set` in src/main/ipc.ts (`OPAQUE_ARGS`) plus
// one function (`argCtx`), and until now nothing but reviewer discipline kept a
// newly added method with a prompt in it out of the log.
//
// This test holds three things:
//
//   1. Classification is total. Every `GurtApi` method is either in
//      `OPAQUE_ARGS` or named in SAFE_ARGS below — a method that is in neither
//      fails, so adding one to the API forces a decision about its arguments.
//   2. Classification is right. Independently of the two lists, the `GurtApi`
//      signatures are parsed and every method that takes an argument shaped
//      like prose (a `prompt`/`text`/`message`/… parameter, or one of the
//      config/credential payload types) must be opaque. This is the half that
//      catches a method sorted into SAFE_ARGS by mistake.
//   3. `argCtx()` really redacts: for an opaque method it returns a count and
//      nothing else, whatever the arguments were.
//
// How the module is read: `OPAQUE_ARGS`/`argCtx` are private to ipc.ts, and
// running `registerIpc()` to reach them would build the whole kernel (see the
// note in ipc-contract.test.mjs). So ipc.ts is bundled for real — with the same
// stub-`electron` trick — through an esbuild loader that appends one export
// line to its source. What runs below is the shipped function, not a copy.
//
// The sibling scripts/commit-message-not-logged.test.mjs covers one method
// end-to-end, down to the bytes in gurt.log; this one covers the whole surface.
//
//   node scripts/ipc-opaque-args.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import ts from 'typescript'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-opaque-args-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))
const IPC_TS = path.join(ROOT, 'src/main/ipc.ts')
const API_TS = path.join(ROOT, 'src/shared/api.ts')

// log.ts / store.ts read these at import time; keep the run out of the real
// ~/.gurt, and keep the level at the one the redaction has to survive.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-opaque-args-'))
process.env.GURT_ROOT = path.join(sandbox, 'gurt')
process.env.GURT_LOG = 'debug'

/**
 * Methods whose arguments are ids, names, flags and paths — nothing a user or
 * an agent wrote in prose, nothing from the credential store. These are logged
 * with their values at DBG, on purpose: the argument of `sessionRun` is what
 * makes the trace worth having.
 *
 * Kept by hand, and that is the point: a new `GurtApi` method appears in
 * neither list and fails the first check below until someone classifies it.
 */
const SAFE_ARGS = new Set([
  // Reads. No arguments at all, or a workspace/task/repo/session key.
  'getTree',
  'getBootProgress',
  'getMcpDefs',
  'getAgents',
  'getAgentConfig',
  'getCredentials',
  'credentialUsedBy',
  'getTaskChanges',
  'getFileDiff',
  'getCommitDiff',
  'getDiffFiles',
  'getDiffPair',
  'getReviewState',
  'getReviewLocks',
  'latestProposal',
  'sessionSnapshot',
  // A session id in, host/port/count records out — the proxy log this reads
  // never held a path, a header or a body to begin with.
  'sessionTraffic',
  'getNotifications',
  'getNotificationPrefs',
  'getUsage',
  'getPlanUsage',
  'taskDirtyRepos',
  'envImageStatus',
  'discoverDevcontainer',
  'discoverDockerfiles',
  // Tree edits. Names are identifiers (they become directories and branches)
  // and already ride in `session.*`/`container.*` records all over the log.
  'createWorkspace',
  'removeWorkspace',
  'addRepo',
  'updateRepo',
  'removeRepo',
  'removeEnv',
  'getMcpServers',
  'removeMcpServer',
  // A workspace and an entry id — the package it reinstalls is read from the
  // registry, not passed in.
  'reinstallMcpServer',
  'createTask',
  'removeTask',
  'renameTask',
  'envBuildImage',
  // Session and container lifecycle: a session id, sometimes an option id.
  'stopContainer',
  'releaseContainer',
  'sessionOpenVscode',
  'sessionRun',
  'sessionEnqueue',
  'sessionCancelQueue',
  'sessionDuplicate',
  'sessionDelete',
  'sessionCancel',
  'sessionSetMode',
  'sessionSetConfigOption',
  'sessionPermission',
  'sessionActivity',
  // Review bookkeeping — ids and booleans; the comment *text* enters through
  // `addReviewComment`, which is opaque.
  'setReviewLock',
  'resolveReviewComment',
  'deleteReviewComment',
  // Changes panel, minus `changesCommit`: repo keys only.
  'changesPush',
  'changesUpdateFromMain',
  'changesOpenPr',
  'changesOpenVscode',
  // Notifications and shell. Ids, and a prefs object of booleans/enums.
  'markNotificationRead',
  'markAllRead',
  'dismissNotification',
  'setNotificationPrefs',
  'openLogsFolder',
  'checkForUpdates',
  // A map of action id -> key code/booleans; no prose ever passes through it.
  'getHotkeys',
  'setHotkeys'
])

/**
 * Parameter names that mean "a human or an agent wrote this". A method taking
 * one of these has to be opaque, whatever list it was put on.
 */
const PROSE_PARAM_NAMES = new Set([
  'prompt',
  'text',
  'message',
  'title',
  'comment',
  'note',
  'body',
  'content',
  'description',
  'summary',
  'instructions'
])

/**
 * Payload types that carry prose or secrets inside them, so the parameter name
 * says nothing on its own: a whole devcontainer definition, an MCP registry
 * entry (user-filled static headers), the credential file, the agent registry
 * (agent env and credential links), a draft patch (`startPrompt`), attached
 * prompt context and images.
 */
const PROSE_PARAM_TYPES = [
  'EnvConfig',
  'McpRegistryEntry',
  'CredentialsFile',
  'AgentsFile',
  'SessionDraftPatch',
  'PromptContext',
  'PromptImage'
]

/** `GurtApi` methods, each with its parameter names and rendered types. */
function gurtApiSignatures() {
  const src = fs.readFileSync(API_TS, 'utf8')
  const sf = ts.createSourceFile('api.ts', src, ts.ScriptTarget.ES2022, true)
  let iface
  for (const st of sf.statements)
    if (ts.isInterfaceDeclaration(st) && st.name.text === 'GurtApi') iface = st
  assert.ok(iface, 'src/shared/api.ts still declares `interface GurtApi` — update this test')
  const sigs = new Map()
  for (const member of iface.members) {
    assert.ok(
      ts.isMethodSignature(member),
      `GurtApi member \`${member.name?.getText() ?? '?'}\` is not a method signature — this test only ` +
        'understands methods; teach it the new shape before landing it'
    )
    sigs.set(
      member.name.getText(),
      member.parameters.map((p) => ({
        name: p.name.getText(),
        type: (p.type?.getText() ?? 'unknown').replace(/\s+/g, ' ')
      }))
    )
  }
  return sigs
}

/** Why this method's arguments count as prose, or '' if they do not. */
function proseReason(params) {
  for (const p of params) {
    if (PROSE_PARAM_NAMES.has(p.name)) return `parameter \`${p.name}\``
    const t = PROSE_PARAM_TYPES.find((name) => new RegExp(`\\b${name}\\b`).test(p.type))
    if (t) return `parameter \`${p.name}: ${p.type}\` (carries ${t})`
  }
  return ''
}

/**
 * Every `args:` occurrence in ipc.ts, as a one-line snippet. The caller checks
 * each against the shapes this file is allowed to have — a log context reading
 * `args: <something other than argCtx(...)>` is the whole bug being guarded.
 */
function argsSites(src) {
  const sites = []
  for (const m of src.matchAll(/args\s*:/g)) {
    const before = src.slice(Math.max(0, m.index - 3), m.index)
    if (before.endsWith('...')) continue // `...args: unknown[]`, the handler's own rest param
    sites.push(src.slice(m.index, m.index + 40).split('\n')[0])
  }
  return sites
}

/** Minimal `electron` stand-in — ipc.ts's module scope only needs it to exist. */
const electronStub = {
  name: 'stub-electron',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub-electron' }))
    b.onLoad({ filter: /.*/, namespace: 'stub-electron' }, () => ({
      loader: 'js',
      contents: `
        export const BrowserWindow = { getAllWindows: () => [], getFocusedWindow: () => null }
        export const ipcMain = { handle() {}, on() {} }
        export const shell = { openExternal() {} }
        export const dialog = { showMessageBox: () => Promise.resolve({ response: 0 }) }
        export const app = {
          getPath: () => ${JSON.stringify(sandbox)},
          getVersion: () => '0.0.0-test',
          getAppPath: () => ${JSON.stringify(ROOT)},
          isPackaged: false,
          on() {}, whenReady: () => Promise.resolve(),
          setName() {}
        }
        export const Notification = class { show() {} static isSupported() { return false } }
        // menu.ts (pulled in transitively through ipc.ts's setHotkeys handler)
        // needs these to exist; nothing here calls into either.
        export const clipboard = { writeText() {} }
        export const Menu = { buildFromTemplate: () => ({}), setApplicationMenu() {} }
        export default { BrowserWindow, ipcMain, shell, dialog, app, Notification, clipboard, Menu }
      `
    }))
  }
}

/** Minimal `electron-updater` stand-in — same reasoning as `electronStub`:
 *  nothing here calls into it, its module scope just has to resolve. The real
 *  package also trips esbuild's bundler (fs-extra/graceful-fs use a dynamic
 *  `require()`), so stubbing doubles as the fix for that. */
const electronUpdaterStub = {
  name: 'stub-electron-updater',
  setup(b) {
    b.onResolve({ filter: /^electron-updater$/ }, () => ({
      path: 'electron-updater',
      namespace: 'stub-electron-updater'
    }))
    b.onLoad({ filter: /.*/, namespace: 'stub-electron-updater' }, () => ({
      loader: 'js',
      contents: `
        export const autoUpdater = {
          logger: null, autoDownload: false, autoInstallOnAppQuit: false,
          setFeedURL() {}, on() { return this }, checkForUpdates: async () => {}, quitAndInstall() {}
        }
      `
    }))
  }
}

/**
 * Re-export ipc.ts's two module-private names by appending one line to its
 * source at load time. Nothing else about the module changes — the code under
 * test is the file as shipped.
 */
const exposeIpcInternals = {
  name: 'expose-ipc-internals',
  setup(b) {
    b.onLoad({ filter: /ipc\.ts$/ }, (args) => {
      if (args.path !== IPC_TS) return null
      const src = fs.readFileSync(args.path, 'utf8')
      assert.match(src, /const OPAQUE_ARGS = new Set<keyof GurtApi>\(\[/, 'ipc.ts still declares `OPAQUE_ARGS`')
      assert.match(src, /function argCtx\(method: keyof GurtApi, args: unknown\[\]\)/, 'ipc.ts still declares `argCtx`')
      return {
        loader: 'ts',
        resolveDir: path.dirname(args.path),
        contents: `${src}\nexport { OPAQUE_ARGS as __OPAQUE_ARGS, argCtx as __argCtx }\n`
      }
    })
  }
}

await bundle({
  stdin: {
    contents:
      `export { __OPAQUE_ARGS, __argCtx } from ${S('src/main/ipc.ts')}\n` +
      `export { API_METHODS } from ${S('src/shared/api.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile,
  plugins: [electronStub, electronUpdaterStub, exposeIpcInternals]
})

const { __OPAQUE_ARGS: OPAQUE_ARGS, __argCtx: argCtx, API_METHODS } = await import(
  pathToFileURL(outfile).href
)
assert.ok(OPAQUE_ARGS instanceof Set && OPAQUE_ARGS.size > 0, 'OPAQUE_ARGS is a non-empty Set')
assert.equal(typeof argCtx, 'function', 'argCtx is a function')
const opaque = [...OPAQUE_ARGS].sort()
console.log(`OPAQUE_ARGS: ${opaque.length} of ${API_METHODS.length} API methods`)

// --- 1. every method is classified, and both lists name real methods ---
test('every API method is classified', () => {
  const api = new Set(API_METHODS)
  const unknownOpaque = opaque.filter((m) => !api.has(m))
  assert.deepEqual(
    unknownOpaque,
    [],
    `OPAQUE_ARGS names methods that are not in GurtApi (renamed or removed?): ${unknownOpaque}`
  )
  const unknownSafe = [...SAFE_ARGS].filter((m) => !api.has(m)).sort()
  assert.deepEqual(unknownSafe, [], `SAFE_ARGS here names methods that are not in GurtApi: ${unknownSafe}`)
  const bothLists = opaque.filter((m) => SAFE_ARGS.has(m))
  assert.deepEqual(bothLists, [], `listed as both opaque and safe — SAFE_ARGS here is stale: ${bothLists}`)

  const unclassified = API_METHODS.filter((m) => !OPAQUE_ARGS.has(m) && !SAFE_ARGS.has(m)).sort()
  assert.deepEqual(
    unclassified,
    [],
    'new GurtApi method(s) with no decision about their arguments: ' +
      `${unclassified}. If any argument can carry user or agent prose (a prompt, a message, a ` +
      'config or credential payload), add the method to OPAQUE_ARGS in src/main/ipc.ts; if it ' +
      'only takes ids/names/flags, add it to SAFE_ARGS in this test.'
  )
})

// --- 2. the signatures agree with the classification ---
test('signatures agree with the classification', () => {
  const sigs = gurtApiSignatures()
  const fromApiTs = [...sigs.keys()].sort()
  assert.deepEqual(
    fromApiTs,
    [...API_METHODS].sort(),
    'the `GurtApi` interface and the runtime API_METHODS listing disagree — see ipc-contract.test.mjs'
  )

  const shouldBeOpaque = []
  for (const [method, params] of sigs) {
    const reason = proseReason(params)
    if (reason && !OPAQUE_ARGS.has(method)) shouldBeOpaque.push(`${method} (${reason})`)
  }
  assert.deepEqual(
    shouldBeOpaque,
    [],
    'these GurtApi methods take prose-shaped arguments but are missing from OPAQUE_ARGS in ' +
      `src/main/ipc.ts, so their values would be written to gurt.log at DBG: ${shouldBeOpaque.join('; ')}`
  )
  // Not an assertion in the other direction: a method may be opaque for a
  // reason no signature shows. Print it, so the list stays reviewable.
  const opaqueWithoutProseSignature = opaque.filter((m) => !proseReason(sigs.get(m) ?? []))
  if (opaqueWithoutProseSignature.length)
    console.log(`opaque beyond what the signature shows: ${opaqueWithoutProseSignature.join(', ')}`)
})

// --- 3. argCtx() hands the logger a count, and only a count ---
test('argCtx() returns a bare argument count for all opaque methods', () => {
  const SECRET = 'PROSE-c4f1a9-do-not-log-me'
  // One argument list per arity the API actually uses, each with the marker
  // buried at a different depth: a plain value, inside an object, inside an
  // array, and behind a `toJSON`-less class instance.
  const payloads = [
    [],
    [SECRET],
    ['ws', { message: SECRET }],
    ['ws', 'task', ['a', [SECRET]]],
    ['id', { patch: { startPrompt: SECRET, images: [{ data: SECRET }] } }, undefined, null]
  ]
  for (const method of opaque) {
    for (const args of payloads) {
      const ctx = argCtx(method, args)
      assert.equal(
        typeof ctx,
        'string',
        `argCtx('${method}') must collapse the arguments to a string, got ${typeof ctx}`
      )
      assert.equal(
        ctx,
        `${args.length} arg(s) [not logged]`,
        `argCtx('${method}') reports the argument count and nothing else`
      )
      // The logger serializes whatever it is given: what matters is that no
      // rendering of this value can contain the argument.
      assert.ok(
        !JSON.stringify(ctx).includes(SECRET) && !String(ctx).includes(SECRET),
        `argCtx('${method}') leaked an argument value into the log context`
      )
    }
  }
})

// The other branch still has to be useful, or the trace is pointless.
test('argCtx() still passes non-opaque arguments through', () => {
  const safeArgs = ['ws', 'task', 42, true]
  assert.deepEqual(
    argCtx('getFileDiff', safeArgs),
    safeArgs,
    'argCtx() passes a non-opaque method\'s arguments through for the DBG trace'
  )
  assert.deepEqual(argCtx('getTree', []), [], 'argCtx() of a no-argument method is the empty list')
})

// --- 4. the boundary actually routes its arguments through argCtx ---
test('both ipc.ts argument traces go through argCtx()', () => {
  const ipcSrc = fs.readFileSync(IPC_TS, 'utf8')
  const sites = argsSites(ipcSrc)
  // The only `args:` ipc.ts may contain: argCtx's own parameter declaration,
  // and the two traces — each reading through argCtx.
  const traced = sites.filter((s) => /^args\s*:\s*argCtx\(m, args\)/.test(s))
  const declarations = sites.filter((s) => /^args\s*:\s*unknown\[\]/.test(s))
  const bare = sites.filter((s) => !traced.includes(s) && !declarations.includes(s))
  assert.deepEqual(
    bare,
    [],
    `ipc.ts puts \`args\` in a log context without going through argCtx(): ${bare.join(' | ')}`
  )
  assert.equal(traced.length, 2, 'both the ipc.call and the ipc.fail trace log their args through argCtx()')
  assert.match(
    ipcSrc,
    /log\.debug\('ipc\.call', \{ method: m, ms: Date\.now\(\) - started, args: argCtx\(m, args\) \}\)/,
    'the ipc.call trace still records method/ms/args only — never the call\'s result, which is where ' +
      'session snapshots and chat history come back'
  )
})

after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(sandbox, { recursive: true, force: true })
})
