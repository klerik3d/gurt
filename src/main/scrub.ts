// The MCP read scrub (docs/requirements-session-operator.md §8): every result
// the admin surface answers passes through `scrub` before it crosses the tool
// boundary. It reuses log.ts's redaction verbatim (redact.ts — the same
// registered credential values in raw/base64/base64url form, the same
// documented MIN_SECRET_LEN exception) and adds docs/logging.md's key
// deny-list for structured results: a value under a key like `token` or
// `secret` is replaced whole, whatever it holds.
//
// It scrubs the *result*, not the file: the value on disk is untouched and
// Settings still shows it.
import { REDACTED, deniedKey, redact } from './redact'

/**
 * Keys the deny-list would hit that are links, names or containers, never
 * secret bytes — without them the surface stops working: `credentialId` is how
 * the operator reasons about what links to what (§5.1 exposes exactly that),
 * `credentialEnvVar` names the variable a local MCP entry reads, not its
 * value, and `credentials` is `CredentialsFile`'s envelope key, whose
 * secret-marked members §5.1's narrowing has already stripped before the
 * scrub ever sees them (and whose `secret` keys the deny-list still hits).
 * Compared the way `deniedKey` compares (case-folded, `-`/`_` stripped).
 * Widening this list is a change to docs/requirements-session-operator.md §8,
 * not a call-site judgement.
 */
const KEY_ALLOW = new Set(['credentialid', 'credentialenvvar', 'credentials'])

const allowedKey = (key: string): boolean =>
  KEY_ALLOW.has(key.toLowerCase().replace(/[-_]/g, ''))

/** Well past any legitimate result's nesting; a cycle (which JSON-able results
 *  cannot carry, but the walk must not trust that) bottoms out as `[redacted]`
 *  rather than a stack overflow — failing closed, like the rest of §8. */
const MAX_DEPTH = 64

/**
 * Deep-copy `value` with every string at every depth run through `redact()`,
 * and every member under a deny-listed key replaced by `[redacted]` outright.
 * Non-JSON leaves (functions, symbols) come back as `[redacted]` too — they
 * have no business in a tool result, and failing closed costs nothing.
 */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED
  if (typeof value === 'string') return redact(value)
  if (value === null || value === undefined) return value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue
      out[k] = !allowedKey(k) && deniedKey(k) ? REDACTED : scrub(v, depth + 1)
    }
    return out
  }
  return REDACTED
}
