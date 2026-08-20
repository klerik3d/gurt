// Adapters for the public pattern collections gurt can feed its built-in
// detector from (docs/requirements-pii-mask.md §4.1).
//
// One small parser per source, written here rather than pulled in as a
// dependency: each pulls just the `{ type, regex }` pairs out of that source's
// own file format. This is text extraction of a handful of fields — a Python
// module's `re.compile(...)` calls, a recognizer class's `PATTERNS` list, the
// `[[rules]]` blocks of a TOML config — not a full-fidelity parser, and
// deliberately not a TOML or Python-AST library.
//
// Everything an adapter cannot use is *counted*, never guessed at: an upstream
// regex in a dialect V8 does not speak is dropped and shows up as `skipped` in
// Settings, so a source that yields half of what it should says so.
import { piiType, type PiiPattern } from '../shared/pii'

export interface AdaptedSource {
  patterns: PiiPattern[]
  /** Upstream entries the adapter had to drop. */
  skipped: number
}

// --- Python / TOML string literals ------------------------------------------

interface ScannedString {
  value: string
  /** Index just past the closing quote. */
  end: number
}

/**
 * Read the string literal starting at `i` (which may sit on a `r`/`b`/`u`/`f`
 * prefix). Handles `'''`/`"""`/`'`/`"`. Non-raw literals get the only escape
 * collapsing a regex cares about: `\\` → `\`, `\'` → `'`, `\"` → `"`. Every
 * other Python escape (`\d`, `\b`, `\xab`, `“`) means the same thing in a
 * JS regex, so it is carried through verbatim.
 */
function readString(src: string, i: number): ScannedString | null {
  let raw = false
  while (i < src.length && /[rbufRBUF]/.test(src[i])) {
    if (src[i] === 'r' || src[i] === 'R') raw = true
    i++
  }
  const q = src[i]
  if (q !== '"' && q !== "'") return null
  const triple = src.slice(i, i + 3) === q.repeat(3)
  const quote = triple ? q.repeat(3) : q
  i += quote.length
  let out = ''
  while (i < src.length) {
    if (src.startsWith(quote, i)) return { value: out, end: i + quote.length }
    if (src[i] === '\\' && i + 1 < src.length) {
      const next = src[i + 1]
      if (!raw && (next === '\\' || next === "'" || next === '"')) out += next
      else out += src[i] + next
      i += 2
      continue
    }
    out += src[i]
    i++
  }
  return null
}

/** Index just past the `)` matching the `(` at `open`, skipping string bodies. */
function endOfCall(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '"' || c === "'") {
      const s = readString(src, i)
      if (!s) return src.length
      i = s.end - 1
      continue
    }
    if (c === '#') {
      const nl = src.indexOf('\n', i)
      if (nl < 0) return src.length
      i = nl
      continue
    }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i + 1
  }
  return src.length
}

/** Every string literal inside `text`, in order (used for `Pattern(...)` args). */
function stringsIn(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '#') {
      const nl = text.indexOf('\n', i)
      if (nl < 0) break
      i = nl
      continue
    }
    if (c !== '"' && c !== "'") continue
    // Rewind onto any string prefix so `r"..."` is read as raw.
    let start = i
    while (start > 0 && /[rbufRBUF]/.test(text[start - 1])) start--
    const s = readString(text, start)
    if (!s) continue
    out.push(s.value)
    i = s.end - 1
  }
  return out
}

// --- upstream regex dialect → JS --------------------------------------------

/** Inline `(?i)`-style group flags, as Python and Go RE2 both write them. */
const INLINE_FLAGS = /^\(\?([aiLmsux]+)\)/

/**
 * Translate an upstream regex into one V8 accepts, or null when it cannot be:
 * `(?x)`/`re.VERBOSE` has no JS equivalent (whitespace inside the pattern
 * changes meaning), `(?#…)` comments do not exist, and anything else that
 * fails to compile is dropped rather than shipped broken.
 */
export function toJsRegex(
  source: string,
  upstreamFlags = ''
): { regex: string; flags: string } | null {
  let regex = source
  let flags = upstreamFlags
  for (let m = INLINE_FLAGS.exec(regex); m; m = INLINE_FLAGS.exec(regex)) {
    for (const f of m[1]) {
      if (f === 'x') return null
      if (f === 'i' || f === 's' || f === 'm') flags += f
    }
    regex = regex.slice(m[0].length)
  }
  if (regex.includes('(?#')) return null
  // Python's named groups; the rest of the group syntax is already shared.
  regex = regex.replace(/\(\?P</g, '(?<').replace(/\(\?P=(\w+)\)/g, '\\k<$1>')
  flags = [...new Set(flags)].sort().join('')
  try {
    new RegExp(regex, `${flags}g`)
  } catch {
    return null
  }
  return { regex, flags }
}

// --- CommonRegex -------------------------------------------------------------

/**
 * `name = re.compile('…', re.IGNORECASE)` per line. The module's own variable
 * names are the only entity labels it has, so the mapping to gurt's token
 * vocabulary is explicit here. Names with no entry are skipped on purpose:
 * `date`, `time`, `price`, `hex_color`, `link` and `zip_code` are not
 * identifying on their own, and masking every date, URL and five-digit number
 * in a coding chat would cost the agent far more than it protects.
 */
const COMMONREGEX_TYPES: Record<string, string> = {
  email: 'EMAIL',
  phone: 'PHONE_NUMBER',
  phones_with_exts: 'PHONE_NUMBER',
  ssn: 'US_SSN',
  credit_card: 'CREDIT_CARD',
  btc_address: 'CRYPTO',
  ip: 'IP_ADDRESS',
  ipv6: 'IP_ADDRESS',
  street_address: 'LOCATION',
  po_box: 'LOCATION'
}

const PY_FLAGS: Record<string, string> = {
  IGNORECASE: 'i',
  DOTALL: 's',
  MULTILINE: 'm',
  VERBOSE: 'x',
  UNICODE: '',
  ASCII: '',
  LOCALE: ''
}

function adaptCommonRegex(text: string): AdaptedSource {
  const patterns: PiiPattern[] = []
  let skipped = 0
  const decl = /^(\w+)\s*=\s*re\.compile\(/gm
  for (let m = decl.exec(text); m; m = decl.exec(text)) {
    const open = m.index + m[0].length - 1
    const call = text.slice(open + 1, endOfCall(text, open) - 1)
    const type = COMMONREGEX_TYPES[m[1]]
    if (!type) continue
    const literal = stringsIn(call)[0]
    if (literal === undefined) {
      skipped++
      continue
    }
    let flags = ''
    for (const f of call.matchAll(/re\.([A-Z]+)/g)) flags += PY_FLAGS[f[1]] ?? ''
    const js = toJsRegex(literal, flags)
    if (!js) {
      skipped++
      continue
    }
    patterns.push({ type, regex: js.regex, flags: js.flags, name: m[1] })
  }
  return { patterns, skipped }
}

// --- Presidio predefined recognizers -----------------------------------------

/**
 * A recognizer class names its entity in the `supported_entity` default and
 * lists `Pattern(name, regex, score)` triples in `PATTERNS`. Scores below this
 * are Presidio's "very weak" tier: they only ever fire together with its
 * context enhancer (a nearby "ssn"/"passport" word), which is NLP we do not
 * run — on their own they are `\b[0-9]{9}\b`-shaped and would mask ordinary
 * numbers in code.
 */
const PRESIDIO_MIN_SCORE = 0.3

function adaptPresidio(files: Record<string, string>): AdaptedSource {
  const patterns: PiiPattern[] = []
  let skipped = 0
  for (const [file, text] of Object.entries(files)) {
    const entity = /supported_entity:\s*str\s*=\s*["']([A-Za-z0-9_]+)["']/.exec(text)?.[1]
    if (!entity) {
      skipped++
      continue
    }
    const type = piiType(entity)
    for (const m of text.matchAll(/\bPattern\(/g)) {
      const open = m.index! + m[0].length - 1
      const call = text.slice(open + 1, endOfCall(text, open) - 1)
      const literals = stringsIn(call)
      if (literals.length < 2) {
        skipped++
        continue
      }
      // Adjacent literals are Python's implicit concatenation — one regex
      // written across several source lines (see the IBAN recognizer).
      const [name, ...rest] = literals
      const score = Number(/(-?\d+(?:\.\d+)?)\s*,?\s*\)?\s*$/.exec(call)?.[1] ?? '0')
      if (!(score >= PRESIDIO_MIN_SCORE)) continue
      const js = toJsRegex(rest.join(''))
      if (!js) {
        skipped++
        continue
      }
      patterns.push({ type, regex: js.regex, flags: js.flags, name: `${file.split('/').pop()}: ${name}` })
    }
  }
  return { patterns, skipped }
}

// --- gitleaks rules ----------------------------------------------------------

/**
 * `[[rules]]` blocks, each with an `id` and one `regex = '''…'''`. Only the
 * rule's own top-level keys are read — a `[[rules.allowlists]]` sub-block
 * carries `regexes` of its own, and those describe what is *not* a secret.
 */
function adaptGitleaks(text: string): AdaptedSource {
  const patterns: PiiPattern[] = []
  let skipped = 0
  let id = ''
  let source: string | null = null
  let inRule = false
  const flush = (): void => {
    if (!id || source === null) {
      if (inRule && id) skipped++
    } else {
      const js = toJsRegex(source)
      if (js) patterns.push({ type: piiType(id), regex: js.regex, flags: js.flags, name: id })
      else skipped++
    }
    id = ''
    source = null
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '[[rules]]') {
      flush()
      inRule = true
      continue
    }
    if (!inRule) continue
    // Any other table header ends the rule's own key/value region.
    if (trimmed.startsWith('[')) {
      flush()
      inRule = false
      continue
    }
    const idMatch = /^id\s*=\s*(.*)$/.exec(trimmed)
    if (idMatch && !id) {
      id = stringsIn(idMatch[1])[0] ?? ''
      continue
    }
    const reMatch = /^regex\s*=\s*(.*)$/.exec(trimmed)
    if (reMatch && source === null) {
      const literal = stringsIn(reMatch[1])[0]
      if (literal !== undefined) source = literal
    }
  }
  flush()
  return { patterns, skipped }
}

// --- registry ----------------------------------------------------------------

/** Adapt one source's fetched raw files into gurt's own pattern shape. */
export function adaptSource(sourceId: string, files: Record<string, string>): AdaptedSource {
  switch (sourceId) {
    case 'commonregex':
      return adaptCommonRegex(Object.values(files).join('\n'))
    case 'presidio-recognizers':
      return adaptPresidio(files)
    case 'gitleaks':
      return adaptGitleaks(Object.values(files).join('\n'))
    default:
      throw new Error(`no pattern adapter for source "${sourceId}"`)
  }
}
