// The import boundaries around RPM (t3v2 §1), decided on resolved paths — the
// same approach as scripts/lib/agent-plugin-boundaries.mjs, for the same
// reason: a string match lets `./../x` and friends walk past it.
//
//   1. src/rpm/** imports nothing of src/main, src/renderer, src/preload (or any
//      other app folder); of src/shared only types (`import type`). No Electron.
//   2. The app imports only src/rpm/{core,main,ui}/index.ts — nobody reaches a
//      deep RPM file. Inside RPM, one layer reaches another only through that
//      layer's index too.
//   3. rpm/core imports neither rpm/main nor rpm/ui; rpm/ui does not import
//      rpm/main (and rpm/main, the node side, not rpm/ui).
//   Plus what keeps each layer runnable where it runs: rpm/core and rpm/ui use
//   no Node built-in, rpm/core no React; the renderer and src/shared do not
//   pull rpm/main at runtime, src/main and src/preload not rpm/ui.
//
// What a per-file rule cannot see — a chain of allowed hops —
// scripts/rpm-boundaries.test.mjs checks on the whole import graph. Used by
// eslint.config.mjs and by that test.
import path from 'node:path'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = path.join(ROOT, 'src')
const RPM = path.join(SRC, 'rpm')
const SHARED = path.join(SRC, 'shared')
const RENDERER_SIDE = ['renderer', 'shared'].map((d) => path.join(SRC, d))
const MAIN_SIDE = ['main', 'preload'].map((d) => path.join(SRC, d))
const LAYERS = /** @type {const} */ (['core', 'main', 'ui'])
const BUILTINS = new Set(builtinModules)
const REACT = new Set(['react', 'react-dom'])

export const MESSAGES = {
  app: 'RPM does not import app code (src/main, src/renderer, src/preload, …): it gets what it needs through its ports.',
  sharedValue: 'RPM takes only types from src/shared — use `import type`.',
  deep: 'RPM is reached only through src/rpm/{core,main,ui}/index.ts.',
  layer: 'rpm/core imports neither rpm/main nor rpm/ui; rpm/ui and rpm/main do not import each other.',
  rendererMain: 'rpm/main is node-side: the renderer and src/shared take only types from it.',
  mainUi: 'rpm/ui is React: src/main and src/preload take only types from it.',
  node: 'rpm/core and rpm/ui run in the renderer too: no Node built-ins.',
  react: 'rpm/core is pure TS: no React.',
  electron: 'RPM does not import Electron: it gets what it needs through its ports.'
}

const inside = (p, dir) => p === dir || p.startsWith(dir + path.sep)

/** A module as the comparisons see it: normalized, no extension, a layer
 *  directory read as its index. */
function moduleId(abs) {
  const p = path.normalize(abs).replace(/\.(tsx?|mjs|cjs|js)$/, '')
  return LAYERS.some((l) => p === path.join(RPM, l)) ? path.join(p, 'index') : p
}

/** @returns {'core' | 'main' | 'ui' | undefined} */
const layerOf = (p) => LAYERS.find((l) => inside(p, path.join(RPM, l)))
const isIndex = (p) => LAYERS.some((l) => p === path.join(RPM, l, 'index'))

/**
 * Why `filename` may not import `specifier`, or undefined when it may.
 * @param {string} filename absolute path of the importing file
 * @param {string} specifier the module specifier as written
 * @param {boolean} [typeOnly] the import is erased (`import type`, `export type`, `import('x').T`)
 * @returns {keyof typeof MESSAGES | undefined}
 */
export function rpmViolation(filename, specifier, typeOnly = false) {
  const from = moduleId(filename)
  if (!inside(from, SRC)) return undefined
  const fromRpm = inside(from, RPM)
  const fromLayer = layerOf(from)

  if (!specifier.startsWith('.') && !path.isAbsolute(specifier)) {
    // A package.
    if (!fromRpm || typeOnly) return undefined
    const parts = specifier.split('/')
    const name = (specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]) ?? specifier
    if (name === 'electron') return 'electron'
    if ((fromLayer === 'core' || fromLayer === 'ui') &&
      (specifier.startsWith('node:') || BUILTINS.has(specifier) || BUILTINS.has(name))) return 'node'
    if (fromLayer === 'core' && REACT.has(name)) return 'react'
    return undefined
  }
  const to = moduleId(path.resolve(path.dirname(filename), specifier))

  if (fromRpm) {
    if (inside(to, RPM)) {
      const toLayer = layerOf(to)
      if (fromLayer && toLayer === fromLayer) return undefined
      if (!toLayer || !isIndex(to)) return 'deep'
      if (fromLayer === 'core' || (fromLayer === 'ui' && toLayer === 'main') || (fromLayer === 'main' && toLayer === 'ui'))
        return 'layer'
      return undefined
    }
    if (inside(to, SHARED)) return typeOnly ? undefined : 'sharedValue'
    if (inside(to, SRC)) return 'app'
    return undefined
  }

  // The app.
  if (!inside(to, RPM)) return undefined
  if (!isIndex(to)) return 'deep'
  if (typeOnly) return undefined
  const toLayer = layerOf(to)
  if (toLayer === 'main' && RENDERER_SIDE.some((d) => inside(from, d))) return 'rendererMain'
  if (toLayer === 'ui' && MAIN_SIDE.some((d) => inside(from, d))) return 'mainUi'
  return undefined
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'RPM import boundaries (t3v2 §1), on resolved paths.' },
    messages: MESSAGES,
    schema: []
  },
  create(context) {
    const filename = context.filename
    /** @param {any} source @param {boolean} typeOnly */
    const check = (source, typeOnly) => {
      if (!source || source.type !== 'Literal' || typeof source.value !== 'string') return
      const violation = rpmViolation(filename, source.value, typeOnly)
      if (violation) context.report({ node: source, messageId: violation })
    }
    return {
      // `import { type X }` is not type-only: under verbatimModuleSyntax it
      // survives as a side-effect import.
      /** @param {any} node */
      ImportDeclaration: (node) => check(node.source, node.importKind === 'type'),
      /** @param {any} node */
      ExportNamedDeclaration: (node) => check(node.source, node.exportKind === 'type'),
      /** @param {any} node */
      ExportAllDeclaration: (node) => check(node.source, node.exportKind === 'type'),
      ImportExpression: (node) => check(node.source, false),
      /** @param {any} node */
      TSImportEqualsDeclaration: (node) => {
        if (node.moduleReference?.type === 'TSExternalModuleReference')
          check(node.moduleReference.expression, node.importKind === 'type')
      },
      /** @param {any} node */
      TSImportType: (node) => check(node.argument?.type === 'TSLiteralType' ? node.argument.literal : node.argument, true),
      /** @param {any} node */
      CallExpression: (node) => {
        if (node.callee?.type === 'Identifier' && node.callee.name === 'require') check(node.arguments?.[0], false)
      }
    }
  }
}

export default rule
