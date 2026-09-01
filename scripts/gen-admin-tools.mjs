// Generates src/shared/adminTools.generated.ts from src/shared/api.ts
// (docs/requirements-session-operator.md §3.2): one MCP tool definition per
// method whose exposure annotation is `read` or `write` — the zod parameter
// schema built from the method's TypeScript parameter types with the
// TypeScript compiler API, the tool description lifted verbatim from the
// method's JSDoc, the name mechanically snake_cased, and the leading `ws`
// parameter dropped (the host binds the operator's own workspace).
//
// The generated file is checked in; CI regenerates and asserts an empty diff
// (scripts/admin-surface.test.mjs spawns `--check`) — the same guarantee
// `satisfies` gives for the annotation, for shapes the type system cannot
// carry to runtime.
//
//   node scripts/gen-admin-tools.mjs           # rewrite the generated file
//   node scripts/gen-admin-tools.mjs --check   # exit 1 if it would change
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const API = path.join(ROOT, 'src', 'shared', 'api.ts')
const OUT = path.join(ROOT, 'src', 'shared', 'adminTools.generated.ts')

const program = ts.createProgram([API], {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true
})
const checker = program.getTypeChecker()
const source = program.getSourceFile(API)
if (!source) throw new Error(`cannot load ${API}`)

/** camelCase → snake_case — the naming convention the `gurt` server already
 *  uses (`create_session`, `complete`). */
const snake = (name) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

// --- read the exposure annotation off the METHODS object literal ------------

/** @type {Map<string, string>} method → 'read' | 'write' | 'none' */
const exposures = new Map()
for (const stmt of source.statements) {
  if (!ts.isVariableStatement(stmt)) continue
  for (const decl of stmt.declarationList.declarations) {
    if (!ts.isIdentifier(decl.name) || decl.name.text !== 'METHODS' || !decl.initializer) continue
    let obj = decl.initializer
    // `{...} as const satisfies Record<...>` wraps the literal twice.
    while (ts.isSatisfiesExpression(obj) || ts.isAsExpression(obj)) obj = obj.expression
    if (!ts.isObjectLiteralExpression(obj)) continue
    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
      if (ts.isStringLiteral(prop.initializer)) exposures.set(prop.name.text, prop.initializer.text)
    }
  }
}
if (!exposures.size) throw new Error('METHODS literal not found in api.ts — the extractor needs updating')

// --- the GurtApi interface, in declaration order ----------------------------

const gurtApi = source.statements.find(
  (s) => ts.isInterfaceDeclaration(s) && s.name.text === 'GurtApi'
)
if (!gurtApi) throw new Error('interface GurtApi not found in api.ts')

// --- TypeScript type → zod expression ---------------------------------------

/** Depth cap: past it a shape degrades to z.unknown() rather than recursing
 *  forever through a self-referential type. Nothing on the surface is near it. */
const MAX_DEPTH = 8

/** @returns {{ expr: string, optional: boolean }} zod source for `type`;
 *  `optional` is true when the type admits `undefined` (the property form of
 *  an optional parameter). */
function zodFor(type, depth) {
  if (depth > MAX_DEPTH) return { expr: 'z.unknown()', optional: false }
  const text = checker.typeToString(type)
  if (text === 'string') return { expr: 'z.string()', optional: false }
  if (text === 'number') return { expr: 'z.number()', optional: false }
  if (text === 'boolean') return { expr: 'z.boolean()', optional: false }
  if (text === 'true') return { expr: 'z.literal(true)', optional: false }
  if (text === 'false') return { expr: 'z.literal(false)', optional: false }
  if (text === 'any' || text === 'unknown') return { expr: 'z.unknown()', optional: true }
  if (text === 'null') return { expr: 'z.null()', optional: false }
  if (text === 'undefined' || text === 'void') return { expr: 'z.undefined()', optional: true }
  if (type.isStringLiteral()) return { expr: `z.literal(${JSON.stringify(type.value)})`, optional: false }
  if (type.isNumberLiteral()) return { expr: `z.literal(${type.value})`, optional: false }
  if (type.isUnion()) return unionZod(type, depth)
  if (checker.isArrayType(type)) {
    const [element] = checker.getTypeArguments(type)
    const inner = element ? zodFor(element, depth + 1) : { expr: 'z.unknown()' }
    return { expr: `z.array(${inner.expr})`, optional: false }
  }
  const stringIndex = type.getStringIndexType?.()
  if (stringIndex && type.getProperties().length === 0) {
    const value = zodFor(stringIndex, depth + 1)
    return { expr: `z.record(z.string(), ${value.expr})`, optional: false }
  }
  if (type.getProperties().length || type.getCallSignatures().length === 0) {
    return objectZod(type, depth)
  }
  return { expr: 'z.unknown()', optional: false }
}

function unionZod(type, depth) {
  const members = type.types
  const optional = members.some((t) => t.flags & ts.TypeFlags.Undefined)
  let rest = members.filter((t) => !(t.flags & ts.TypeFlags.Undefined))
  // TS spells `boolean` in a union as its two literals — fold them back.
  const hasTrue = rest.some((t) => checker.typeToString(t) === 'true')
  const hasFalse = rest.some((t) => checker.typeToString(t) === 'false')
  const folded = []
  if (hasTrue && hasFalse) {
    rest = rest.filter((t) => {
      const s = checker.typeToString(t)
      return s !== 'true' && s !== 'false'
    })
    folded.push('z.boolean()')
  }
  if (rest.every((t) => t.isStringLiteral()) && rest.length > 1 && folded.length === 0) {
    const values = rest.map((t) => JSON.stringify(t.value)).join(', ')
    return { expr: `z.enum([${values}])`, optional }
  }
  const parts = [...rest.map((t) => zodFor(t, depth + 1).expr), ...folded]
  const unique = [...new Set(parts)]
  const expr = unique.length === 1 ? unique[0] : `z.union([${unique.join(', ')}])`
  return { expr, optional }
}

function objectZod(type, depth) {
  const props = type.getProperties()
  const parts = []
  for (const prop of props) {
    const decl = prop.valueDeclaration ?? prop.declarations?.[0] ?? gurtApi
    const propType = checker.getTypeOfSymbolAtLocation(prop, decl)
    const inner = zodFor(propType, depth + 1)
    const optional = inner.optional || (prop.flags & ts.SymbolFlags.Optional) !== 0
    parts.push(`${JSON.stringify(prop.name)}: ${inner.expr}${optional ? '.optional()' : ''}`)
  }
  const stringIndex = type.getStringIndexType?.()
  if (!parts.length && stringIndex) {
    const value = zodFor(stringIndex, depth + 1)
    return { expr: `z.record(z.string(), ${value.expr})`, optional: false }
  }
  return {
    expr: parts.length ? `z.strictObject({ ${parts.join(', ')} })` : 'z.strictObject({})',
    optional: false
  }
}

// --- one tool per exposed method --------------------------------------------

const defs = []
for (const member of gurtApi.members) {
  if (!ts.isMethodSignature(member) || !ts.isIdentifier(member.name)) continue
  const method = member.name.text
  const exposure = exposures.get(method)
  if (exposure === undefined) throw new Error(`method "${method}" has no exposure annotation`)
  if (exposure === 'none') continue
  const symbol = checker.getSymbolAtLocation(member.name)
  const description = symbol
    ? ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim()
    : ''
  const params = []
  const shape = []
  let bindWs = false
  member.parameters.forEach((param, i) => {
    const name = ts.isIdentifier(param.name) ? param.name.text : param.name.getText(source)
    if (i === 0 && name === 'ws') {
      // §3.2 narrowing 1: the host binds the operator's own workspace; the
      // agent cannot express another one.
      bindWs = true
      return
    }
    const type = checker.getTypeAtLocation(param)
    const inner = zodFor(type, 0)
    const optional = inner.optional || param.questionToken !== undefined
    params.push(name)
    shape.push(`${JSON.stringify(name)}: ${inner.expr}${optional ? '.optional()' : ''}`)
  })
  defs.push({
    name: snake(method),
    method,
    exposure,
    description: description || `GurtApi.${method}`,
    bindWs,
    params,
    shape: shape.length ? `{ ${shape.join(', ')} }` : '{}'
  })
}

// --- emit --------------------------------------------------------------------

const lines = []
lines.push('// GENERATED by scripts/gen-admin-tools.mjs — DO NOT EDIT.')
lines.push('//')
lines.push('// One MCP tool definition per `read`/`write`-annotated GurtApi method')
lines.push('// (docs/requirements-session-operator.md §3.2): the schema is derived from')
lines.push('// the parameter types, the description is the JSDoc, the name is the')
lines.push("// method's snake_case, and the leading `ws` parameter is dropped — the host")
lines.push("// binds the operator's own workspace. Regenerate with:")
lines.push('//')
lines.push('//   node scripts/gen-admin-tools.mjs')
lines.push('//')
lines.push('// CI regenerates and asserts an empty diff (scripts/admin-surface.test.mjs).')
lines.push("import { z } from 'zod'")
lines.push("import type { GurtApi } from './api'")
lines.push('')
lines.push('export interface AdminToolDef {')
lines.push('  /** MCP tool name — the snake_case of `method`. */')
lines.push('  name: string')
lines.push('  /** The GurtApi method this tool derives from. */')
lines.push('  method: keyof GurtApi')
lines.push("  exposure: 'read' | 'write'")
lines.push("  /** The method's JSDoc, verbatim. */")
lines.push('  description: string')
lines.push("  /** True when the method's leading `ws` parameter is host-bound (§3.2). */")
lines.push('  bindWs: boolean')
lines.push('  /** Remaining parameter names, in call order — how named tool arguments')
lines.push('   *  map back onto the positional method call. */')
lines.push('  params: readonly string[]')
lines.push('  /** zod shape over `params` — what the MCP tool validates. */')
lines.push('  input: z.ZodRawShape')
lines.push('}')
lines.push('')
lines.push('export const ADMIN_TOOLS: readonly AdminToolDef[] = [')
for (const def of defs) {
  lines.push('  {')
  lines.push(`    name: ${JSON.stringify(def.name)},`)
  lines.push(`    method: ${JSON.stringify(def.method)},`)
  lines.push(`    exposure: ${JSON.stringify(def.exposure)},`)
  lines.push(`    description: ${JSON.stringify(def.description)},`)
  lines.push(`    bindWs: ${def.bindWs},`)
  lines.push(`    params: ${JSON.stringify(def.params)},`)
  lines.push(`    input: ${def.shape}`)
  lines.push('  },')
}
lines.push(']')
const output = lines.join('\n') + '\n'

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : ''
  if (current !== output) {
    console.error(
      'src/shared/adminTools.generated.ts is out of date — run: node scripts/gen-admin-tools.mjs'
    )
    process.exit(1)
  }
  console.log(`adminTools.generated.ts is current (${defs.length} tools)`)
} else {
  fs.writeFileSync(OUT, output)
  console.log(`wrote ${path.relative(ROOT, OUT)} (${defs.length} tools)`)
}
