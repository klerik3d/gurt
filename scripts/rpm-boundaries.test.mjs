// The import boundaries around RPM (t3v2 §1), per import and on the whole graph.
//
// The ESLint rule (scripts/lib/rpm-boundaries.mjs) judges one import at a time,
// on its resolved path. This file:
//
//   - pins the rule on what it must refuse (however the specifier is spelled)
//     and on what the layout allows;
//   - walks the real runtime import graph: each RPM layer reaches only itself
//     and the layers below it (core ← main, core ← ui), the renderer and
//     src/shared never reach rpm/main, src/main never reaches rpm/ui.
//     Type-only imports are skipped — they are erased.
//
//   node scripts/rpm-boundaries.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { Linter } from 'eslint'
import tseslint from 'typescript-eslint'
import rule, { rpmViolation } from './lib/rpm-boundaries.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const at = (rel) => path.join(ROOT, rel)

// --- the rule, one import at a time -------------------------------------------

const linter = new Linter({ configType: 'flat' })
/** @type {import('eslint').Linter.Config[]} */
const CONFIG = [
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { parser: tseslint.parser },
    plugins: { rpm: { rules: { boundaries: rule } } },
    rules: { 'rpm/boundaries': 'error' }
  }
]
/** The rule's verdicts on `code` linted as the file `rel`. */
const lint = (rel, code) =>
  linter.verify(code, CONFIG, { filename: at(rel) }).map((m) => m.messageId ?? m.message)

test('the rule refuses what t3v2 §1 forbids', () => {
  const cases = [
    // 1. RPM imports no app code, and from src/shared only types.
    ['src/rpm/main/api.ts', "import { SessionManager } from '../../main/sessions'", 'app'],
    ['src/rpm/main/api.ts', "import type { SessionManager } from './../../main//sessions'", 'app'],
    ['src/rpm/ui/index.ts', "import { App } from '../../renderer/src/App'", 'app'],
    ['src/rpm/core/model.ts', "type T = import('../../preload/api').Api", 'app'],
    ['src/rpm/main/api.ts', "const s = require('../../main/store')", 'app'],
    ['src/rpm/main/api.ts', "import { AGENT_PLUGINS } from '../../plugins/agents'", 'app'],
    ['src/rpm/main/api.ts', "import { SESSION_ROLES } from '../../shared/types'", 'sharedValue'],
    ['src/rpm/core/model.ts', "import { type SessionRole } from '../../shared/types'", 'sharedValue'],
    ['src/rpm/main/api.ts', "import { app } from 'electron'", 'electron'],
    // 2. Nobody reaches a deep RPM file.
    ['src/main/kernel.ts', "import { createRpm } from '../rpm/main/api'", 'deep'],
    ['src/main/kernel.ts', "import type { Rpm } from '../rpm/main/./api.ts'", 'deep'],
    ['src/renderer/src/App.tsx', "import type { RpmState } from '../../rpm/core/model'", 'deep'],
    ['src/shared/types.ts', "import type { RpmChatLine } from '../rpm/core/../core/model'", 'deep'],
    ['src/rpm/ui/index.ts', "import type { RpmState } from '../core/model'", 'deep'],
    ['src/rpm/main/api.ts', "export * from '../core/model'", 'deep'],
    // 3. Layers.
    ['src/rpm/core/model.ts', "import type { Rpm } from '../main'", 'layer'],
    ['src/rpm/core/model.ts', "import { ReviewTab } from '../ui/index'", 'layer'],
    ['src/rpm/ui/index.ts', "import { createRpm } from '../main'", 'layer'],
    ['src/rpm/main/api.ts', "import { ReviewTab } from '../ui'", 'layer'],
    // The renderer side never pulls rpm/main in, the main side never rpm/ui.
    ['src/renderer/src/App.tsx', "import { createRpm } from '../../rpm/main'", 'rendererMain'],
    ['src/shared/types.ts', "export { createRpm } from '../rpm/main/index.ts'", 'rendererMain'],
    ['src/main/kernel.ts', "import { ReviewTab } from '../rpm/ui'", 'mainUi'],
    // core and ui stay free of Node, core of React.
    ['src/rpm/core/model.ts', "import { createHash } from 'node:crypto'", 'node'],
    ['src/rpm/ui/index.ts', "import fs from 'fs/promises'", 'node'],
    ['src/rpm/core/model.ts', "import { useState } from 'react'", 'react']
  ]
  for (const [rel, code, expected] of cases)
    assert.deepEqual(lint(rel, code), [expected], `${rel}: ${code}`)
})

test('what the layout allows stays allowed', () => {
  const cases = [
    ['src/rpm/main/api.ts', "import type { SessionRole } from '../../shared/types'"],
    ['src/rpm/main/api.ts', "import type { RpmState } from '../core'"],
    ['src/rpm/main/api.ts', "import { DEFAULT_CONFIG } from '../core/index'"],
    ['src/rpm/main/api.ts', "import type { RpmPorts } from './ports'"],
    ['src/rpm/main/journal.ts', "import fs from 'node:fs'"],
    ['src/rpm/ui/index.ts', "import { DEFAULT_CONFIG } from '../core'"],
    ['src/rpm/ui/ReviewTab.tsx', "import { useState } from 'react'"],
    ['src/rpm/core/index.ts', "export * from './model'"],
    ['src/rpm/core/model.ts', "import { z } from 'zod'"],
    ['src/main/kernel.ts', "import { createRpm } from '../rpm/main'"],
    ['src/main/kernel.ts', "import { DEFAULT_CONFIG } from '../rpm/core/index.ts'"],
    ['src/shared/types.ts', "import type { RpmChatLine } from '../rpm/core'"],
    ['src/renderer/src/App.tsx', "import { ReviewTab } from '../../rpm/ui'"],
    ['src/renderer/src/App.tsx', "import type { Rpm } from '../../rpm/main'"]
  ]
  for (const [rel, code] of cases) assert.deepEqual(lint(rel, code), [], `${rel}: ${code}`)
  assert.equal(rpmViolation(at('scripts/x.test.mjs'), '../src/rpm/core/model'), undefined, 'tests may reach any file')
})

// --- the graph ------------------------------------------------------------------

/** Every relative import in `file`, resolved, with whether it is erased. */
function imports(file) {
  const text = fs.readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  /** @type {{ spec: string; typeOnly: boolean }[]} */
  const specs = []
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
      specs.push({ spec: node.moduleSpecifier.text, typeOnly: !!node.importClause?.isTypeOnly })
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
      specs.push({ spec: node.moduleSpecifier.text, typeOnly: node.isTypeOnly })
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal))
      specs.push({ spec: node.argument.literal.text, typeOnly: true })
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]))
      specs.push({ spec: node.arguments[0].text, typeOnly: false })
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return specs.flatMap(({ spec, typeOnly }) => {
    if (!spec.startsWith('.')) return []
    const base = path.resolve(path.dirname(file), spec)
    const hit = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]
      .find((p) => fs.existsSync(p) && fs.statSync(p).isFile())
    return hit ? [{ spec, file: hit, typeOnly }] : []
  })
}

/** Every file reachable at runtime from `entry`, each with one path that reaches it. */
function closure(entry) {
  const via = new Map([[entry, [entry]]])
  const queue = [entry]
  while (queue.length) {
    const file = queue.shift()
    for (const next of imports(file))
      if (!next.typeOnly && !via.has(next.file)) {
        via.set(next.file, [...via.get(file), next.file])
        queue.push(next.file)
      }
  }
  return via
}

/** All .ts/.tsx files under `dir`. */
const filesUnder = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => /\.tsx?$/.test(f)).map((f) => path.join(dir, f))
    : []

const inside = (p, dir) => p === dir || p.startsWith(dir + path.sep)

/** The chains from `entries` that reach a file `bad` accepts, spelled out. */
function leaks(entries, bad) {
  const out = []
  for (const entry of entries)
    for (const [file, chain] of closure(entry))
      if (bad(file)) out.push(chain.map((f) => path.relative(ROOT, f)).join(' → '))
  return [...new Set(out)]
}

test('the three layers and their index files exist', () => {
  for (const layer of ['core', 'main', 'ui']) assert.ok(fs.existsSync(at(`src/rpm/${layer}/index.ts`)), layer)
})

test('every import in src/ obeys the rule', () => {
  const bad = []
  for (const file of filesUnder(at('src')))
    for (const { spec, typeOnly } of imports(file)) {
      const v = rpmViolation(file, spec, typeOnly)
      if (v) bad.push(`${path.relative(ROOT, file)}: ${spec} (${v})`)
    }
  assert.deepEqual(bad, [])
})

test('each RPM layer reaches at runtime only itself and rpm/core', () => {
  const core = at('src/rpm/core')
  const allowed = { core: [core], main: [at('src/rpm/main'), core], ui: [at('src/rpm/ui'), core] }
  for (const [layer, dirs] of Object.entries(allowed))
    assert.deepEqual(leaks(filesUnder(at(`src/rpm/${layer}`)), (f) => !dirs.some((d) => inside(f, d))), [], layer)
})

test('the renderer and src/shared never reach rpm/main; src/main never reaches rpm/ui', () => {
  const shared = filesUnder(at('src/shared'))
  const renderer = [at('src/renderer/src/main.tsx'), ...shared]
  assert.deepEqual(leaks(renderer, (f) => inside(f, at('src/rpm/main'))), [])
  assert.deepEqual(leaks([at('src/main/index.ts'), at('src/preload/index.ts')].filter((f) => fs.existsSync(f)),
    (f) => inside(f, at('src/rpm/ui'))), [])
})

test('the graph walk follows a chain through allowed hops', () => {
  // shared/types.ts reaches rpm/core only by type today: nothing at runtime.
  const reached = [...closure(at('src/shared/types.ts')).keys()]
  assert.ok(!reached.some((f) => inside(f, at('src/rpm'))), 'type-only hops are not runtime ones')
  // rpm/main/index.ts reaches api.ts and ports.ts by `export *` (value re-exports).
  const main = closure(at('src/rpm/main/index.ts'))
  assert.ok(main.has(at('src/rpm/main/api.ts')) && main.has(at('src/rpm/main/ports.ts')))
})
