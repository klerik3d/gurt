// The core knows no agent by name (docs/requirements-agent-plugins.md §9.1).
//
// Every agent-specific fact lives in one folder per agent under
// src/plugins/agents/, reached through the registry; the core — src/main,
// src/shared, src/renderer, src/preload — runs on what the plugins declare.
// This holds that line mechanically: every .ts/.tsx file of the core goes
// through the TypeScript scanner, and any string literal, template-literal
// part, regex literal, identifier or JSX text naming an agent, a vendor or a
// vendor's own vocabulary fails the suite.
//
// The scanner is driven by the parser, not run bare: only the parser knows
// whether a `/` starts a regex literal or is a division, and where JSX text
// begins. Comments are trivia, not tokens, and are never read — what a comment
// may say is a review question (§5 principle 5), not this test's.
//
// An exception goes in ALLOWED below, with the reason it is one, and is listed
// in the As built section of the requirements document.
//
//   node scripts/agent-agnostic-core.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CORE = ['src/main', 'src/shared', 'src/renderer', 'src/preload']

/** Agent and vendor names, and the vocabulary only one of them uses. */
const NAMES = /claude|codex|gemini|opencode|anthropic|openai|chatgpt|google|sk-ant|mcp__|yolo|auto_review|five_hour|seven_day/i
/** pi is a word too short for a substring match — and `Math.PI` must pass. */
const isPi = (text) => text === 'pi' || text.startsWith('pi-')
const names = (text) => NAMES.test(text) || isPi(text)

/**
 * Known exceptions: `file` (repo-relative) and a fragment of the token's text.
 * @type {{ file: string, fragment: string, reason: string }[]}
 */
const ALLOWED = [
  {
    file: 'src/renderer/src/components/SettingsPage.tsx',
    fragment: "own .claude/skills is the repository",
    reason:
      'UI prose, not a branch: a repository may carry its own skills in the convention SKILL.md comes from, ' +
      'which gurt deliberately neither lists nor manages (shared/skills.ts). Rewording it would change UI text (§6).'
  },
  {
    file: 'src/renderer/src/components/ConfigTab.tsx',
    fragment: "own .claude/skills is the repo",
    reason: 'The same note as in SettingsPage.tsx, where a session picks its skills.'
  }
]

/** The token kinds that carry a name: literals, identifiers, JSX text. */
const CHECKED = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.PrivateIdentifier,
  ts.SyntaxKind.JsxText
])

/**
 * Every checked token of one source text that names an agent.
 * @param {string} fileName
 * @param {string} text
 * @returns {{ line: number, kind: string, text: string }[]}
 */
function namingTokens(fileName, text) {
  const tsx = fileName.endsWith('.tsx')
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  /** @type {{ line: number, kind: string, text: string }[]} */
  const hits = []
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (CHECKED.has(node.kind)) {
      // Cooked text for literals, the source spelling for everything else
      // (a regex literal's `.text` is its whole `/…/flags`).
      const value = 'text' in node && typeof node.text === 'string' ? node.text : node.getText(sf)
      if (names(value))
        hits.push({
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          kind: ts.SyntaxKind[node.kind],
          text: value
        })
    }
    // getChildren, not forEachChild: it scans the token nodes between the
    // syntax nodes too, so every token of the file is seen exactly once.
    for (const child of node.getChildren(sf)) visit(child)
  }
  visit(sf)
  return hits
}

/** @param {string} dir @returns {string[]} */
const sources = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return sources(p)
    return /\.tsx?$/.test(e.name) ? [p] : []
  })

test('the checker sees literals, regexes, identifiers and JSX text — and not comments', () => {
  const sample = [
    "const kind = 'claude-code'",
    'const re = /yolo/i',
    'const half = total / codex / 2',
    'const t = `${a}seven_day${b}`',
    'const pi = Math.PI',
    "const label = 'pi-acp'",
    '// a comment about gemini is not a token',
    '/* nor is anthropic in a block comment */',
    'const ok = Math.PI * spi'
  ].join('\n')
  const hits = namingTokens('sample.ts', sample).map((h) => `${h.line}:${h.kind}:${h.text}`)
  assert.deepEqual(hits, [
    '1:StringLiteral:claude-code',
    '2:RegularExpressionLiteral:/yolo/i',
    '3:Identifier:codex',
    '4:TemplateMiddle:seven_day',
    '5:Identifier:pi',
    '6:StringLiteral:pi-acp'
  ])
  const jsx = namingTokens('sample.tsx', 'export const A = () => <p title="x">runs on Gemini</p>')
  assert.deepEqual(jsx.map((h) => h.kind), ['JsxText'])
})

test('no file of the core names an agent', () => {
  const files = CORE.flatMap((dir) => sources(path.join(ROOT, dir)))
  assert.ok(files.length > 100, `scanned only ${files.length} files — is the core where this test looks?`)
  const used = new Set()
  const offenders = []
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    for (const hit of namingTokens(rel, fs.readFileSync(file, 'utf8'))) {
      const allowed = ALLOWED.findIndex((a) => a.file === rel && hit.text.includes(a.fragment))
      if (allowed >= 0) used.add(allowed)
      else offenders.push(`${rel}:${hit.line} ${hit.kind} ${JSON.stringify(hit.text.trim().slice(0, 80))}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'agent-specific facts belong in src/plugins/agents/<id>/ — reach them through the registry'
  )
  // An exception that no longer matches anything is stale: drop it.
  assert.deepEqual(
    ALLOWED.filter((_, i) => !used.has(i)).map((a) => `${a.file}: ${a.fragment}`),
    []
  )
})
