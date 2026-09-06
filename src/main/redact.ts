// Value-based secret redaction, shared by the log writer (log.ts, which every
// outgoing log line passes through) and the MCP read scrub (scrub.ts, which
// every admin-surface result passes through —
// docs/requirements-session-operator.md §8). Lifted out of log.ts so the two
// consumers provably share one registered-value set and one matching rule:
// a secret redacted from the log but not from a config read (or vice versa)
// would be exactly the drift §8 exists to prevent.

export const REDACTED = '[redacted]'

/** Secret values (raw + base64 + base64url) redacted from every outgoing line. */
const secrets = new Set<string>()
/** Longest first, so a secret containing another is replaced whole. */
let secretsByLength: string[] = []
/** Below this a "secret" is more likely a common word than a credential — the
 *  false-positive cost of redacting ordinary short strings outweighs catching
 *  a credential this short, which real secret generators essentially never
 *  produce. This is a deliberate, documented exception to the "every secret is
 *  replaced wherever it appears" rule in docs/logging.md's Redaction section:
 *  a secret shorter than `MIN_SECRET_LEN` is never redacted. */
export const MIN_SECRET_LEN = 6

/**
 * Register secret values to redact. Sourced from the credential store (loaded
 * at startup, refreshed on every save), so redaction is value-based: it catches
 * a token wherever it appears — an argv entry, a git error, agent stderr, an
 * MCP read result — without any call site having to know it was a secret.
 */
export function addSecrets(values: string[]): void {
  let added = false
  for (const v of values) {
    if (typeof v !== 'string') continue
    const raw = v.trim()
    if (raw.length < MIN_SECRET_LEN) continue
    const b64 = Buffer.from(raw, 'utf8').toString('base64')
    const b64url = Buffer.from(raw, 'utf8').toString('base64url')
    for (const form of [raw, b64, b64.replace(/=+$/, ''), b64url]) {
      if (form.length < MIN_SECRET_LEN || secrets.has(form)) continue
      secrets.add(form)
      added = true
    }
  }
  if (added) secretsByLength = [...secrets].sort((a, b) => b.length - a.length)
}

/** `scheme://user:pass@host` — the one credential shape that rides in a URL.
 *  Quantifiers are bounded: an unbounded `scheme` + `user` + `pass` run makes
 *  this pattern backtrack quadratically over a long match-free string (a 60 KB
 *  line of plain letters took ~6.5 s; 240 KB took ~100 s). No real scheme,
 *  username or password is anywhere near these lengths. */
const URL_CREDS_RE = /([a-zA-Z][a-zA-Z0-9+.-]{0,30}:\/\/)[^\s/@:]{1,256}:[^\s/@]{1,256}@/g

/** Replace every registered secret (raw/base64/base64url) and every
 *  `://user:pass@` URL credential in `s` with `[redacted]`. */
export function redact(s: string): string {
  let out = s
  for (const secret of secretsByLength)
    if (out.includes(secret)) out = out.split(secret).join(REDACTED)
  return out.replace(URL_CREDS_RE, `$1${REDACTED}@`)
}

/** Key substrings that redact their value outright, whatever it holds. The key
 *  is case-folded and stripped of `-`/`_` before matching, so `api_key`,
 *  `api-key` and `apiKey` all hit `apikey` (docs/logging.md, Redaction). */
export const DENY_KEYS = [
  'token',
  'authorization',
  'password',
  'secret',
  'apikey',
  'passphrase',
  'credential',
  'cookie',
  'bearer'
]

export const deniedKey = (key: string): boolean => {
  const k = key.toLowerCase().replace(/[-_]/g, '')
  return DENY_KEYS.some((d) => k.includes(d))
}
