// The import boundaries around agent plugins (docs/requirements-agent-plugins.md
// §4.1–4.4), on the whole graph.
//
// The ESLint rule (scripts/lib/agent-plugin-boundaries.mjs) judges one import
// at a time, on its resolved path. What it cannot see is a chain of allowed
// hops — a shared half importing a helper that imports the main half — and
// the property that matters is exactly that chain's end: nothing a plugin's
// main half holds (OAuth clients, endpoints, Node-side code) may reach the
// renderer bundle. So this file does two things:
//
//   - pins the rule on the ways a specifier can be spelled to slip past a
//     string match (`./../`, `a//b`, `./main` from a shared half, a dynamic
//     import, a type-only one), and on what must stay allowed;
//   - walks the real import graph from the renderer's entry and from every
//     src/shared file, and fails if it reaches src/main, the main list or any
//     plugin's main.ts. Type-only imports are skipped (they are erased); an
//     `import { type X }` is not, since it can still survive as a side-effect
//     import under verbatimModuleSyntax.
//
//   node scripts/agent-plugin-boundaries.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { Linter } from 'eslint'
import tseslint from 'typescript-eslint'
import rule, { boundaryViolation } from './lib/agent-plugin-boundaries.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const at = (rel) => path.join(ROOT, rel)

// --- the rule, one import at a time -------------------------------------------

const linter = new Linter({ configType: 'flat' })
/** @type {import('eslint').Linter.Config[]} */
const CONFIG = [
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { parser: tseslint.parser },
    plugins: { gurt: { rules: { 'agent-plugin-boundaries': rule } } },
    rules: { 'gurt/agent-plugin-boundaries': 'error' }
  }
]
/** The rule's verdicts on `code` linted as the file `rel`. */
const lint = (rel, code) =>
  linter.verify(code, CONFIG, { filename: at(rel) }).map((m) => m.messageId ?? m.message)

test('the spellings that slipped past a string match are refused', () => {
  const cases = [
    // A shared half re-exporting its main half carries it into the renderer.
    ['src/plugins/agents/claude-code/shared.ts', "export { main } from './main'", 'mainHalf'],
    ['src/plugins/agents/claude-code/shared.ts', "import { main } from './sub/../main'", 'mainHalf'],
    ['src/plugins/agents/claude-code/manifest.ts', "export * from './main'", 'mainHalf'],
    // The shared list reaching the main one.
    ['src/plugins/agents/index.ts', "export { AGENT_MAIN_PLUGINS } from './main'", 'list'],
    ['src/plugins/agents/index.ts', "import { main } from './codex/main'", 'sharedList'],
    ['src/plugins/agents/index.ts', "import { main } from './codex//main.ts'", 'sharedList'],
    // A plugin reaching the core through a `./` prefix, or another plugin.
    ['src/plugins/agents/claude-code/shared.ts', "export { getAgents } from './../../../main/store'", 'plugin'],
    ['src/plugins/agents/claude-code/main.ts', "import { agentDef } from '../../../shared/agents'", 'plugin'],
    ['src/plugins/agents/claude-code/shared.ts', "export { manifest } from '../codex/manifest'", 'plugin'],
    ['src/plugins/agents/claude-code/main.ts', "type T = import('../../../main/store').Store", 'plugin'],
    ['src/plugins/agents/claude-code/main.ts', "const s = require('../../../main/store')", 'plugin'],
    // Node, however it is named.
    ['src/plugins/agents/claude-code/main.ts', "import fs from 'node:fs'", 'node'],
    ['src/plugins/agents/claude-code/main.ts', "import { join } from 'path/posix'", 'node'],
    // The core reaching into a plugin folder, or the renderer side the main list.
    ['src/main/agentPlugins.ts', "export { manifest } from '../plugins//agents/codex/manifest'", 'core'],
    ['src/main/agentPlugins.ts', "export { manifest } from '../plugins/agents/./codex/manifest.ts'", 'core'],
    ['src/renderer/src/components/icons.tsx', "import type { M } from '../../../plugins/agents/codex/manifest'", 'core'],
    ['src/shared/agents.ts', "export const x = import('../plugins/agents/./main')", 'mainList'],
    ['src/renderer/src/App.tsx', "import { AGENT_MAIN_PLUGINS } from '../../plugins/agents/main'", 'mainList']
  ]
  for (const [rel, code, expected] of cases)
    assert.deepEqual(lint(rel, code), [expected], `${rel}: ${code}`)
})

test('what the layout allows stays allowed', () => {
  const cases = [
    ['src/plugins/agents/claude-code/shared.ts', "import { manifest } from './manifest'"],
    ['src/plugins/agents/claude-code/main.ts', "import { manifest } from './manifest'"],
    ['src/plugins/agents/claude-code/main.ts', "import { z } from 'zod'"],
    ['src/plugins/agents/claude-code/shared.ts', "import type { AgentPlugin } from '../../../shared/agentPlugin'"],
    ['src/plugins/agents/claude-code/shared.ts', "import type { AgentPlugin } from './../claude-code/../../../shared/agentPlugin'"],
    ['src/plugins/agents/index.ts', "import { manifest } from './codex/manifest'"],
    ['src/plugins/agents/index.ts', "import { shared } from './claude-code/shared'"],
    ['src/plugins/agents/main.ts', "import { main } from './codex/main'"],
    ['src/shared/agents.ts', "import { AGENT_PLUGINS } from '../plugins/agents'"],
    ['src/shared/agents.ts', "import { AGENT_PLUGINS } from '../plugins/agents/index.ts'"],
    ['src/main/agentPlugins.ts', "import { AGENT_MAIN_PLUGINS } from '../plugins/agents/main'"],
    ['src/main/sessions.ts', "import fs from 'node:fs'"]
  ]
  for (const [rel, code] of cases) assert.deepEqual(lint(rel, code), [], `${rel}: ${code}`)
  assert.equal(boundaryViolation(at('scripts/x.mjs'), '../src/plugins/agents/codex/main'), undefined, 'not the core')
})

// --- the graph ------------------------------------------------------------------

/** The files `file` imports at runtime (type-only imports skipped), resolved;
 *  packages are not followed. */
function runtimeImports(file) {
  const text = fs.readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const specs = []
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier))
      specs.push(node.moduleSpecifier.text)
    else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
      specs.push(node.moduleSpecifier.text)
    else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression))
      specs.push(node.moduleReference.expression.text)
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]))
      specs.push(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return specs.flatMap((spec) => {
    if (!spec.startsWith('.')) return []
    const base = path.resolve(path.dirname(file), spec)
    const hit = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]
      .find((p) => fs.existsSync(p) && fs.statSync(p).isFile())
    return hit ? [hit] : []
  })
}

/** Every file reachable from `entry`, each with one path that reaches it. */
function closure(entry) {
  const via = new Map([[entry, [entry]]])
  const queue = [entry]
  while (queue.length) {
    const file = queue.shift()
    for (const next of runtimeImports(file))
      if (!via.has(next)) {
        via.set(next, [...via.get(file), next])
        queue.push(next)
      }
  }
  return via
}

/** What renderer-side code must never reach. */
const forbidden = (plugins) => (file) =>
  file.startsWith(path.join(ROOT, 'src', 'main') + path.sep) ||
  file === path.join(plugins, 'main.ts') ||
  (path.basename(file) === 'main.ts' && path.dirname(path.dirname(file)) === plugins)

/** The chains from `entries` that end in something forbidden, spelled out. */
function leaks(entries, plugins, root) {
  const bad = forbidden(plugins)
  const out = []
  for (const entry of entries)
    for (const [file, chain] of closure(entry))
      if (bad(file)) out.push(chain.map((f) => path.relative(root, f)).join(' → '))
  return [...new Set(out)]
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-plugin-graph-'))
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('the graph walk finds a main half however far down the chain', () => {
  // A miniature layout: the shared list → a shared half → a helper → main.ts.
  const plugins = path.join(tmp, 'src', 'plugins', 'agents')
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true })
    fs.writeFileSync(path.join(tmp, rel), text)
  }
  write('src/plugins/agents/index.ts', "import { shared } from './x/shared'\nexport const L = [shared]\n")
  write('src/plugins/agents/x/shared.ts', "import { helper } from './helper'\nexport const shared = helper\n")
  write('src/plugins/agents/x/helper.ts', "import type { T } from './types'\nimport { main } from './main'\nexport const helper = main\n")
  write('src/plugins/agents/x/types.ts', "import { secret } from '../../../main/secret'\nexport type T = typeof secret\n")
  write('src/plugins/agents/x/main.ts', 'export const main = 1\n')
  write('src/main/secret.ts', 'export const secret = 1\n')
  assert.deepEqual(leaks([path.join(plugins, 'index.ts')], plugins, tmp), [
    'src/plugins/agents/index.ts → src/plugins/agents/x/shared.ts → src/plugins/agents/x/helper.ts → src/plugins/agents/x/main.ts'
  ], 'and a type-only hop (types.ts → src/main) is not a runtime one')
})

test('no main half, no main list and nothing of src/main reaches the renderer or src/shared', () => {
  const plugins = at('src/plugins/agents')
  const shared = fs.readdirSync(at('src/shared')).filter((f) => /\.ts$/.test(f)).map((f) => at(`src/shared/${f}`))
  const entries = [at('src/renderer/src/main.tsx'), at('src/plugins/agents/index.ts'), ...shared]
  const reached = closure(entries[0])
  assert.ok(reached.has(at('src/plugins/agents/index.ts')), 'the renderer does read the shared list')
  assert.ok([...reached.keys()].some((f) => f.endsWith(path.join('claude-code', 'manifest.ts'))), 'and the manifests')
  assert.deepEqual(leaks(entries, plugins, ROOT), [])
})
