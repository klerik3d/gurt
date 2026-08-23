/**
 * Syntax coloring, and merging it with word-level diff highlighting, for the
 * split view. Pure — no React, no DOM — so it's testable on its own
 * (scripts/syntax-highlight.test.mjs). See docs/requirements-manual-review.md.
 */
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import graphql from 'highlight.js/lib/languages/graphql'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import less from 'highlight.js/lib/languages/less'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import scss from 'highlight.js/lib/languages/scss'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

let registered = false
function ensureRegistered(): void {
  if (registered) return
  registered = true
  hljs.registerLanguage('bash', bash)
  hljs.registerLanguage('c', c)
  hljs.registerLanguage('cpp', cpp)
  hljs.registerLanguage('csharp', csharp)
  hljs.registerLanguage('css', css)
  hljs.registerLanguage('dockerfile', dockerfile)
  hljs.registerLanguage('go', go)
  hljs.registerLanguage('graphql', graphql)
  hljs.registerLanguage('ini', ini)
  hljs.registerLanguage('java', java)
  hljs.registerLanguage('javascript', javascript)
  hljs.registerLanguage('json', json)
  hljs.registerLanguage('kotlin', kotlin)
  hljs.registerLanguage('less', less)
  hljs.registerLanguage('markdown', markdown)
  hljs.registerLanguage('php', php)
  hljs.registerLanguage('python', python)
  hljs.registerLanguage('ruby', ruby)
  hljs.registerLanguage('rust', rust)
  hljs.registerLanguage('scss', scss)
  hljs.registerLanguage('sql', sql)
  hljs.registerLanguage('typescript', typescript)
  hljs.registerLanguage('xml', xml)
  hljs.registerLanguage('yaml', yaml)
}

/** One run of a line under one syntax scope (`hljs-keyword`, …); `null` = unhighlighted. */
export interface SyntaxSpan {
  text: string
  cls: string | null
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'" }
const unescape = (s: string): string =>
  // The alternation and the map hold the same five names, so the fallback is
  // unreachable — it keeps the entity's own text rather than inventing one.
  s.replace(/&(amp|lt|gt|quot|#x27);/g, (m: string, e: string) => ENTITIES[e] ?? m)

/**
 * hljs's HTML output is a strict, known-shape grammar (its own `escapeHTML`
 * only ever produces those 5 entities, and every scope is exactly one
 * `<span class="...">...</span>`, arbitrarily nested) — small enough to walk
 * with a regex and a stack instead of pulling in an HTML parser, and it works
 * the same in Node (tests) and the renderer.
 */
function parseHljsHtml(html: string): SyntaxSpan[] {
  const spans: SyntaxSpan[] = []
  const stack: string[] = []
  const re = /<span class="([^"]*)">|<\/span>|[^<]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    if (m[0] === '</span>') stack.pop()
    else if (m[1] !== undefined) stack.push(m[1])
    else spans.push({ text: unescape(m[0]), cls: stack[stack.length - 1] ?? null })
  }
  return spans
}

/** Syntax spans covering `text` exactly; `lang: null` or an unknown language
 *  renders as one unhighlighted span — the current, safe fallback. */
export function tokenize(text: string, lang: string | null): SyntaxSpan[] {
  if (!lang) return [{ text, cls: null }]
  ensureRegistered()
  if (!hljs.getLanguage(lang)) return [{ text, cls: null }]
  try {
    return parseHljsHtml(hljs.highlight(text, { language: lang, ignoreIllegals: true }).value)
  } catch {
    return [{ text, cls: null }]
  }
}

/** One rendered run: syntax color plus whether it fell inside a diff-changed
 *  word. What `Code` in ReviewModal.tsx renders. */
export interface MergedSpan {
  text: string
  cls: string | null
  changed: boolean
}

/**
 * Two partitions of the same string — syntax scopes and diff-word spans —
 * combined into their shared boundaries. A two-pointer walk: at each step
 * take as much as both current spans agree on, then advance whichever (or
 * both) that exhausts.
 */
export function mergeSpans(syntax: SyntaxSpan[], diff: { text: string; changed: boolean }[]): MergedSpan[] {
  const out: MergedSpan[] = []
  let si = 0
  let sOff = 0
  let di = 0
  let dOff = 0
  for (;;) {
    // Both cursors are bounded by their array's length; reading them here is
    // also the loop's exit condition.
    const s = syntax[si]
    const d = diff[di]
    if (!s || !d) break
    const take = Math.min(s.text.length - sOff, d.text.length - dOff)
    if (take > 0)
      out.push({ text: s.text.slice(sOff, sOff + take), cls: s.cls, changed: d.changed })
    sOff += take
    dOff += take
    if (sOff >= s.text.length) {
      si++
      sOff = 0
    }
    if (dOff >= d.text.length) {
      di++
      dOff = 0
    }
  }
  return out
}
