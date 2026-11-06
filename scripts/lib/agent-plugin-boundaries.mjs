// The import boundaries around agent plugins (docs/requirements-agent-plugins.md
// §4.1–4.3), decided on resolved paths.
//
// `no-restricted-imports` matches a specifier as written, so `./../x`, `a//b`
// or a sibling hop inside a plugin folder walked straight past patterns that
// read fine. This rule resolves every relative specifier against the importing
// file, normalizes it, and asks where it lands:
//
//   - the core (src/main, src/preload, src/shared, src/renderer) reaches the
//     plugins only through the two list files — and src/shared and the
//     renderer never through the main-only one;
//   - a plugin file imports its own folder, the contract
//     (src/shared/agentPlugin.ts) and npm packages — no Node built-in, and
//     never its own folder's `main.ts`: only the main list may, because
//     anything else that does carries the main half into the renderer;
//   - the shared list imports plugin folders' shared halves and the contract;
//     the main list, plugin folders and the contract.
//
// What a per-file rule cannot see — a chain of allowed hops that still ends in
// a main half — scripts/agent-plugin-boundaries.test.mjs checks on the whole
// import graph. Used by eslint.config.mjs and by that test.
import path from 'node:path'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = path.join(ROOT, 'src')
const PLUGINS = path.join(SRC, 'plugins', 'agents')
const SHARED_LIST = path.join(PLUGINS, 'index')
const MAIN_LIST = path.join(PLUGINS, 'main')
const CONTRACT = path.join(SRC, 'shared', 'agentPlugin')
const CORE = ['main', 'preload', 'shared', 'renderer'].map((d) => path.join(SRC, d))
const RENDERER_SIDE = ['shared', 'renderer'].map((d) => path.join(SRC, d))
const BUILTINS = new Set(builtinModules)

export const MESSAGES = {
  core: 'The core reaches agent plugins only through src/plugins/agents/index.ts (and, in main, src/plugins/agents/main.ts).',
  mainList: 'src/plugins/agents/main.ts is main-only: shared code and the renderer read src/plugins/agents/index.ts.',
  plugin: 'An agent plugin imports only src/shared/agentPlugin.ts, its own folder and npm packages.',
  mainHalf:
    "A plugin's main.ts is imported only by src/plugins/agents/main.ts — anything else that imports it carries it into the renderer.",
  list: 'A plugin list imports only plugin folders and src/shared/agentPlugin.ts.',
  sharedList: 'The shared list is bundled into the renderer: main halves belong in src/plugins/agents/main.ts.',
  node: 'An agent plugin gets what it needs from the core as a parameter (fetch, the clock, …), not from Node.'
}

const inside = (p, dir) => p === dir || p.startsWith(dir + path.sep)

/** A module as the comparisons see it: normalized, no extension, and the
 *  plugins directory itself read as its index. */
function moduleId(abs) {
  const p = path.normalize(abs).replace(/\.(tsx?|mjs|cjs|js)$/, '')
  return p === PLUGINS ? SHARED_LIST : p
}

/** The plugin folder a module sits in — undefined for the list files and
 *  anything outside src/plugins/agents/. */
function pluginFolderOf(p) {
  const rel = path.relative(PLUGINS, p)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !rel.includes(path.sep)) return undefined
  return path.join(PLUGINS, rel.split(path.sep)[0])
}

const isMainHalf = (p) => {
  const folder = pluginFolderOf(p)
  return !!folder && p === path.join(folder, 'main')
}

/**
 * Why `filename` may not import `specifier`, or undefined when it may.
 * @param {string} filename absolute path of the importing file
 * @param {string} specifier the module specifier as written
 * @returns {keyof typeof MESSAGES | undefined}
 */
export function boundaryViolation(filename, specifier) {
  const from = moduleId(filename)
  const inPlugins = inside(from, PLUGINS)
  if (!specifier.startsWith('.') && !path.isAbsolute(specifier)) {
    // A package. Plugins may use npm packages, never Node itself.
    const name = specifier.split('/')[0] ?? specifier
    return inPlugins && (specifier.startsWith('node:') || BUILTINS.has(specifier) || BUILTINS.has(name))
      ? 'node'
      : undefined
  }
  const to = moduleId(path.resolve(path.dirname(filename), specifier))

  if (CORE.some((d) => inside(from, d))) {
    if (inside(to, PLUGINS) && to !== SHARED_LIST && to !== MAIN_LIST) return 'core'
    if (to === MAIN_LIST && RENDERER_SIDE.some((d) => inside(from, d))) return 'mainList'
    return undefined
  }
  if (!inPlugins) return undefined

  if (to === CONTRACT) return undefined
  if (path.dirname(from) === PLUGINS) {
    // A list file.
    if (!pluginFolderOf(to)) return 'list'
    if (from === SHARED_LIST && isMainHalf(to)) return 'sharedList'
    return undefined
  }
  // A plugin file.
  const own = pluginFolderOf(from)
  if (!own || !inside(to, own)) return 'plugin'
  if (isMainHalf(to)) return 'mainHalf'
  return undefined
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Agent plugin import boundaries, on resolved paths.' },
    messages: MESSAGES,
    schema: []
  },
  create(context) {
    const filename = context.filename
    /** @param {any} source */
    const check = (source) => {
      if (!source || source.type !== 'Literal' || typeof source.value !== 'string') return
      const violation = boundaryViolation(filename, source.value)
      if (violation) context.report({ node: source, messageId: violation })
    }
    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      /** @param {any} node */
      TSImportEqualsDeclaration: (node) => {
        if (node.moduleReference?.type === 'TSExternalModuleReference') check(node.moduleReference.expression)
      },
      /** @param {any} node */
      TSImportType: (node) => check(node.argument?.type === 'TSLiteralType' ? node.argument.literal : node.argument),
      /** @param {any} node */
      CallExpression: (node) => {
        if (node.callee?.type === 'Identifier' && node.callee.name === 'require') check(node.arguments?.[0])
      }
    }
  }
}

export default rule
