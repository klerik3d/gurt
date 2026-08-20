// PII/secret masking — pure data and pure functions, shared by main and renderer
// (docs/requirements-pii-mask.md).
//
// The contract in one line: the agent's context only ever holds *tokens*, the
// user's chat view only ever holds *reals*. `encode` runs on the outbound
// `session/prompt` text, `decode` on everything coming back over
// `session/update` — one seam, in src/main/sessions.ts, and nowhere else.
//
// Everything here is Electron-free and node-free: the registries (which
// detector backends exist, which public pattern collections a built-in
// detector may be fed from), the token grammar, and the regex detector built
// out of an adapted pattern set. The crypto, the fetch/cache and the external
// backend live in src/main/pii.ts — the renderer only ever sees settings and
// status.

/** One entity a detector found, as a half-open span of the text it scanned. */
export interface PiiSpan {
  start: number
  end: number
  /** Entity type, already normalized to the token grammar (see `piiType`). */
  type: string
}

/**
 * §4's one interface. The built-in detector answers synchronously; an external
 * backend is an HTTP round trip, hence the union — callers always `await`.
 */
export interface Detector {
  detect(text: string): PiiSpan[] | Promise<PiiSpan[]>
}

/** One `{ type, regex }` pair, as an adapter pulled it out of a source file. */
export interface PiiPattern {
  type: string
  /** JS-flavoured source (the adapter already translated the upstream dialect). */
  regex: string
  /** Regex flags minus `g`, which the detector adds itself. */
  flags?: string
  /** Where it came from, for the settings UI and for debugging a false positive. */
  name?: string
}

// --- detector backends (§4/§5.1) --------------------------------------------

export type PiiBackendId = 'built-in' | 'presidio'

export interface PiiBackendDef {
  id: PiiBackendId
  label: string
  description: string
  /** Text leaves the host to be scanned — the settings UI says so out loud. */
  external: boolean
}

/** Registry, same shape as `MCP_DEFS`/`mcpDef` in shared/mcp.ts. */
export const PII_BACKENDS: PiiBackendDef[] = [
  {
    id: 'built-in',
    label: 'built-in',
    description:
      'Regex + checksum only, in-process. Needs a pattern source (below) fetched once; ' +
      'no free-text NER — that is what an external backend is for.',
    external: false
  },
  {
    id: 'presidio',
    label: 'presidio',
    description:
      'Microsoft Presidio analyzer over HTTP — adds NER on top of patterns. Either a ' +
      'gurt-managed local docker sidecar, or an analyzer you already run.',
    external: true
  }
]

export const piiBackendDef = (id: string): PiiBackendDef | undefined =>
  PII_BACKENDS.find((b) => b.id === id)

// --- pattern sources for the built-in detector (§4.1) ------------------------

export interface PiiSourceDef {
  id: string
  label: string
  description: string
  /** Shown in settings — every source here is permissively licensed. */
  license: string
  repo: string
  /**
   * The pinned commit sha or release tag the raw files are fetched at. Never a
   * moving branch: patterns must not change underfoot between two launches.
   * Bumping this constant is what "check for updates" offers the user.
   */
  ref: string
  /** Raw-file base; the GET is `${raw}/${ref}/${file}`. */
  raw: string
  /** Repo-relative files fetched at `ref`, in adapter order. */
  files: string[]
}

/**
 * The public collections gurt can feed its built-in detector from. Nothing is
 * vendored: this is a list of URLs, fetched at runtime on explicit user action
 * and cached under `~/.gurt/pii-patterns/<id>.json`.
 */
export const PII_SOURCES: PiiSourceDef[] = [
  {
    id: 'commonregex',
    label: 'CommonRegex',
    description:
      'A small, well-known set of everyday-PII regexes (email, phone, SSN, card, IP, address).',
    license: 'MIT',
    repo: 'https://github.com/madisonmay/CommonRegex',
    ref: '2425abdb79c8992b8b655c27e1fb195cc54457ab',
    raw: 'https://raw.githubusercontent.com/madisonmay/CommonRegex',
    files: ['commonregex.py']
  },
  {
    id: 'presidio-recognizers',
    label: 'Presidio recognizers',
    description:
      "Presidio's own predefined pattern recognizers (generic + US), without the Python runtime.",
    license: 'MIT',
    repo: 'https://github.com/microsoft/presidio',
    ref: '2.2.364',
    raw: 'https://raw.githubusercontent.com/data-privacy-stack/presidio',
    // Only the recognizers whose patterns stand on their own. Presidio scores
    // its "very weak" ones for a context enhancer we do not run (a bare
    // `\\b[0-9]{9}\\b` for a passport, `[A-Z][0-9]{1,12}` for a driver
    // license) — fetching those files would cost a round trip to produce
    // nothing but false positives on ordinary code.
    files: [
      'presidio-analyzer/presidio_analyzer/predefined_recognizers/generic/credit_card_recognizer.py',
      'presidio-analyzer/presidio_analyzer/predefined_recognizers/generic/crypto_recognizer.py',
      'presidio-analyzer/presidio_analyzer/predefined_recognizers/generic/email_recognizer.py',
      'presidio-analyzer/presidio_analyzer/predefined_recognizers/generic/iban_recognizer.py',
      'presidio-analyzer/presidio_analyzer/predefined_recognizers/generic/ip_recognizer.py',
      'presidio-analyzer/presidio_analyzer/predefined_recognizers/generic/mac_recognizer.py',
      'presidio-analyzer/presidio_analyzer/predefined_recognizers/country_specific/us/us_ssn_recognizer.py',
      'presidio-analyzer/presidio_analyzer/predefined_recognizers/country_specific/us/us_itin_recognizer.py'
    ]
  },
  {
    id: 'gitleaks',
    label: 'gitleaks rules',
    description:
      'Provider API keys and tokens (AWS, GitHub, Stripe, Slack, …) — the secret half of §1.',
    license: 'MIT',
    repo: 'https://github.com/gitleaks/gitleaks',
    ref: 'v8.30.1',
    raw: 'https://raw.githubusercontent.com/gitleaks/gitleaks',
    files: ['config/gitleaks.toml']
  }
]

export const piiSourceDef = (id: string): PiiSourceDef | undefined =>
  PII_SOURCES.find((s) => s.id === id)

/** The one URL shape a fetch uses — pinned to `def.ref`, never to a branch. */
export const piiSourceUrl = (def: PiiSourceDef, file: string): string =>
  `${def.raw}/${def.ref}/${file}`

// --- settings + status (§5.1) -----------------------------------------------

export interface PiiSettings {
  /** Absent = nothing is masked anywhere. That *is* "off" (§5.1). */
  backend?: PiiBackendId
  /** `built-in`: which pattern source is active. */
  source?: string
  /** `presidio`: a gurt-managed docker sidecar, or an analyzer someone else runs. */
  presidioMode?: 'local' | 'remote'
  /** `presidio` + remote: analyzer base URL; falls back to the credential's `url`. */
  presidioUrl?: string
  /** `presidio` + local: host port the sidecar's 3000 is published on. */
  presidioPort?: number
  /** Linked `pii-detector` credential (url + apiKey) for a remote analyzer (§5.3). */
  credentialId?: string
}

/** What a fetched-and-adapted source looks like once cached. */
export interface PiiSourceState {
  /** The ref actually cached — older than `PiiSourceDef.ref` after a pin bump. */
  ref: string
  fetchedAt: string
  /** Usable `{type, regex}` pairs the adapter produced. */
  patterns: number
  /** Upstream entries the adapter had to drop (unsupported regex dialect, …). */
  skipped: number
}

/**
 * The `~/.gurt/pii-patterns/<source>.json` cache (§4.1): the fetched raw files
 * exactly as they came off the wire, plus the adapted form the detector runs.
 * Keeping the raw copy means a fixed adapter can re-derive patterns without
 * touching the network again.
 */
export interface PiiPatternCache {
  source: string
  ref: string
  fetchedAt: string
  raw: Record<string, string>
  patterns: PiiPattern[]
  skipped: number
}

export interface PiiStatus {
  settings: PiiSettings
  /** Masking can actually run right now — what the New Session chip gates on. */
  ready: boolean
  /** Why not, when `ready` is false. Shown inline on the disabled chip (§5.2). */
  reason?: string
  /** Cached pattern sets by source id — drives the "fetched / update available" badges. */
  sources: Record<string, PiiSourceState>
}

export const PII_DEFAULT_PORT = 5002

/** Analyzer base URL for the current settings, or '' when it cannot be resolved. */
export function presidioUrl(settings: PiiSettings, credentialUrl?: string): string {
  if (settings.presidioMode === 'local')
    return `http://127.0.0.1:${settings.presidioPort ?? PII_DEFAULT_PORT}`
  return (settings.presidioUrl || credentialUrl || '').replace(/\/+$/, '')
}

/**
 * The single "can masking run" verdict, shared by main (which gates encoding on
 * it) and the renderer (which gates the chip on it). Pure: everything it needs
 * — the settings, the cache index, the resolved credential url — is passed in.
 */
export function piiConfigError(
  settings: PiiSettings,
  sources: Record<string, PiiSourceState>,
  credentialUrl?: string
): string | undefined {
  if (!settings.backend) return 'no detector backend selected — Settings → Masking'
  if (settings.backend === 'built-in') {
    if (!settings.source) return 'no pattern source selected — Settings → Masking'
    const def = piiSourceDef(settings.source)
    if (!def) return `unknown pattern source "${settings.source}"`
    const cached = sources[settings.source]
    if (!cached) return `${def.label} has never been fetched — fetch it in Settings → Masking`
    if (!cached.patterns) return `${def.label} produced no usable patterns`
    return undefined
  }
  if (settings.backend === 'presidio') {
    if (!presidioUrl(settings, credentialUrl)) return 'presidio analyzer url is not configured'
    return undefined
  }
  return `unknown detector backend "${String(settings.backend)}"`
}

// --- token grammar (§3) ------------------------------------------------------

/**
 * `<TYPE:ciphertext>`; ciphertext is base64url so it never contains `<`, `>`
 * or `:` and a token can therefore be found again by this exact regex in text
 * the agent has copied, quoted or reflowed.
 */
export const PII_TOKEN_RE = /<([A-Z][A-Z0-9_]*):([A-Za-z0-9_-]{16,})>/g

/** Normalize an upstream entity name into the `TYPE` half of the grammar. */
export function piiType(raw: string): string {
  const t = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return /^[A-Z]/.test(t) ? t : `X_${t || 'PII'}`
}

/** Format one token. `payload` must already be base64url. */
export const piiToken = (type: string, payload: string): string => `<${type}:${payload}>`

/** A token that has begun but not closed: `<`, `<EMA`, `<EMAIL`, `<EMAIL:abc`.
 *  The bare `<` counts — a chunk can end on exactly that one character. */
const PARTIAL_TOKEN_RE = /^<(?:[A-Z][A-Z0-9_]*(?::[A-Za-z0-9_-]*)?)?$/

/** Longest fragment held back as a possible partial token. Payloads are far
 *  shorter than this; the bound only stops a stray `<` from swallowing an
 *  answer if an agent writes one and then never closes it. */
const MAX_PENDING = 512

/**
 * Split a streamed chunk into the part that is safe to decode now and a
 * trailing fragment that might still become a token once more arrives. ACP
 * chops an answer into chunks with no regard for our grammar, so a token can
 * straddle two of them — decoding each chunk on its own would leave both halves
 * showing in the chat, which is exactly what §2.1 promises never happens.
 */
export function splitPendingToken(text: string): [ready: string, pending: string] {
  const lt = text.lastIndexOf('<')
  if (lt < 0 || text.indexOf('>', lt) >= 0) return [text, '']
  const tail = text.slice(lt)
  if (tail.length > MAX_PENDING || !PARTIAL_TOKEN_RE.test(tail)) return [text, '']
  return [text.slice(0, lt), tail]
}

/** Spans of `text` that are already tokens — never re-encoded, never re-detected. */
export function tokenSpans(text: string): PiiSpan[] {
  const out: PiiSpan[] = []
  // A fresh instance per call: the exported constant is shared, and a stateful
  // `lastIndex` on it would make this depend on who scanned last.
  for (const m of text.matchAll(new RegExp(PII_TOKEN_RE.source, 'g')))
    out.push({ start: m.index!, end: m.index! + m[0].length, type: m[1] })
  return out
}

// --- span algebra ------------------------------------------------------------

/**
 * Leftmost-longest, non-overlapping. Detectors run independently and overlap
 * constantly (a card number inside an account line, two phone patterns on one
 * number); replacing overlapping spans would corrupt the text, and picking the
 * longest keeps the *whole* entity behind one token instead of masking half of
 * it and leaking the rest.
 */
export function resolveSpans(spans: PiiSpan[]): PiiSpan[] {
  const sorted = [...spans]
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start || b.end - a.end)
  const out: PiiSpan[] = []
  let end = -1
  for (const s of sorted) {
    if (s.start < end) continue
    out.push(s)
    end = s.end
  }
  return out
}

/** Replace resolved spans back-to-front so earlier offsets stay valid. */
export function replaceSpans(
  text: string,
  spans: PiiSpan[],
  replace: (value: string, type: string) => string
): string {
  let out = text
  for (const s of [...spans].sort((a, b) => b.start - a.start))
    out = out.slice(0, s.start) + replace(text.slice(s.start, s.end), s.type) + out.slice(s.end)
  return out
}

// --- checksums (§4: "regex/checksum only") -----------------------------------

/** Luhn — the one cheap way to tell a card number from any other 16 digits. */
export function luhnValid(value: string): boolean {
  const digits = value.replace(/[^0-9]/g, '')
  if (digits.length < 12 || digits.length > 19) return false
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

/** ISO 13616 mod-97: an IBAN is 1 exactly when it checks out. */
export function ibanValid(value: string): boolean {
  const s = value.replace(/[\s-]/g, '').toUpperCase()
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(s)) return false
  const rearranged = s.slice(4) + s.slice(0, 4)
  let rem = 0
  for (const ch of rearranged) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97
  }
  return rem === 1
}

/**
 * Per-type validators applied after a regex hit. A type with no entry here is
 * taken at the regex's word — this is the whole of "checksum" in §4, not a
 * general validation framework.
 */
const CHECKSUMS: Record<string, (v: string) => boolean> = {
  CREDIT_CARD: luhnValid,
  IBAN_CODE: ibanValid,
  IBAN: ibanValid
}

export const checksumOk = (type: string, value: string): boolean =>
  CHECKSUMS[type]?.(value) ?? true

// --- the built-in detector (§4) ---------------------------------------------

/** A pattern that compiled; the ones that did not are dropped at build time. */
interface CompiledPattern {
  type: string
  re: RegExp
}

/**
 * v1: pure TS, regex + checksum, no npm dependency and no vendored pattern
 * data — `patterns` come from whichever source the user picked and gurt
 * fetched (§4.1). A pattern that does not compile in V8 is skipped rather than
 * failing the whole set: the upstream dialects (Python `re`, Go RE2) are
 * mostly-but-not-entirely JS-compatible, and one exotic rule must not cost the
 * other two hundred.
 */
export function builtinDetector(patterns: PiiPattern[]): Detector {
  const compiled: CompiledPattern[] = []
  for (const p of patterns) {
    try {
      compiled.push({ type: p.type, re: new RegExp(p.regex, `${p.flags ?? ''}g`) })
    } catch {
      // Unusable here; `adaptSource` already counted it as skipped.
    }
  }
  return {
    detect(text: string): PiiSpan[] {
      const spans: PiiSpan[] = []
      for (const { type, re } of compiled) {
        re.lastIndex = 0
        for (let m = re.exec(text); m; m = re.exec(text)) {
          // A zero-width match would spin `exec` forever on a `g` regex.
          if (m[0].length === 0) {
            re.lastIndex++
            continue
          }
          if (checksumOk(type, m[0])) spans.push({ start: m.index, end: m.index + m[0].length, type })
        }
      }
      return spans
    }
  }
}
