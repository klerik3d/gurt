// Env-config normal form (docs/requirements-env-devcontainer.md): one shared
// parse/validate/identity helper used by the editor, the store and the
// provisioning pipeline, so every path agrees on what a valid env is.
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser'
import type { EnvConfig } from './types'

/** The `build` section of a devcontainer.json, as far as gurt reads it. */
export interface DevcontainerBuild {
  dockerfile?: string
  context?: string
  args?: Record<string, string>
  target?: string
}

export interface ParsedEnvConfig {
  /** Parsed devcontainer object — absent on `error`. */
  config?: Record<string, unknown>
  /** The config's `build` section, when present (and an object). */
  build?: DevcontainerBuild
  /** Set on JSONC parse failure / non-object root. */
  error?: string
}

/** Parse the env's devcontainer text (JSONC — comments and trailing commas ok). */
export function parseEnvDevcontainer(text: string): ParsedEnvConfig {
  const errors: ParseError[] = []
  const config = parse(text, errors, { allowTrailingComma: true }) as unknown
  if (errors.length) {
    const e = errors[0]
    return { error: `devcontainer: ${printParseErrorCode(e.error)} at offset ${e.offset}` }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config))
    return { error: 'devcontainer must be a JSON object' }
  const cfg = config as Record<string, unknown>
  const rawBuild = cfg.build
  const build =
    rawBuild && typeof rawBuild === 'object' && !Array.isArray(rawBuild)
      ? (rawBuild as DevcontainerBuild)
      : undefined
  return { config: cfg, build }
}

/** null = ok. The devcontainer is mandatory; a `build` section requires the
 *  companion Dockerfile content. Nothing else is validated — compose configs
 *  etc. are the author's responsibility. */
export function validateEnvConfig(env: EnvConfig): string | null {
  if (!env.devcontainer.trim()) return 'devcontainer config is required'
  const parsed = parseEnvDevcontainer(env.devcontainer)
  if (parsed.error) return parsed.error
  if (parsed.build && !env.dockerfile?.trim())
    return 'Dockerfile is required when devcontainer has a build section'
  return null
}

/**
 * gurt-env:<sha256(repoUrl \n commit \n dockerfileContent \n canonicalBuild).hex.slice(0,16)>
 *
 * canonicalBuild is the `build` object with the `dockerfile` key removed and
 * keys sorted — args/target/context affect the image; the file *path* does not
 * (its content is hashed directly). Same commit + same config ⇒ same tag on
 * every path, which is what lets a pre-built image be reused by session start.
 */
export function envImageTag(
  repoUrl: string,
  commit: string,
  dockerfile: string,
  build: object
): string {
  const { dockerfile: _path, ...rest } = build as Record<string, unknown>
  void _path
  const hash = sha256Hex(`${repoUrl}\n${commit}\n${dockerfile}\n${canonicalJson(rest)}`)
  return `gurt-env:${hash.slice(0, 16)}`
}

/** JSON with object keys sorted at every level — a canonical form to hash. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// Pure-JS SHA-256 (FIPS 180-4). This module is shared with the renderer, which
// has neither node:crypto nor its types — and the tag must be computable
// synchronously. Content addressing only, not security. Verified against
// node:crypto in scripts/env-config.test.mjs.

// K: first 32 bits of the fractional parts of the cube roots of the first 64 primes.
// prettier-ignore
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))

function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const H = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]
  const l = bytes.length
  const padded = new Uint8Array((((l + 8) >> 6) + 1) << 6)
  padded.set(bytes)
  padded[l] = 0x80
  const dv = new DataView(padded.buffer)
  dv.setUint32(padded.length - 8, Math.floor(l / 0x20000000))
  dv.setUint32(padded.length - 4, (l << 3) >>> 0)
  const w = new Uint32Array(64)
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = H
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      h = g; g = f; f = e
      e = (d + t1) >>> 0
      d = c; c = b; b = a
      a = (t1 + t2) >>> 0
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0
  }
  return H.map((x) => x.toString(16).padStart(8, '0')).join('')
}
