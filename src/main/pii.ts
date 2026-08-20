// PII/secret masking, host side (docs/requirements-pii-mask.md).
//
// Owns the three things the pure module in shared/pii.ts deliberately does not:
// the per-session encryption keys, the pattern fetch/cache, and the external
// detector backend. The seam it is wired into is src/main/sessions.ts and only
// that — encode on the outbound `session/prompt` text, decode on everything
// arriving over `session/update`.
//
// Key policy (§3): gurt generates the key, on the host, always. An external
// backend is a *detector* — it is told what text to look at and answers with
// offsets; the encryption of the values it found happens here, under a key that
// never leaves this process. Nothing outside gurt ever produces key material we
// then trust.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import {
  PII_DEFAULT_PORT,
  PII_TOKEN_RE,
  builtinDetector,
  piiConfigError,
  piiSourceDef,
  piiSourceUrl,
  piiToken,
  presidioUrl,
  replaceSpans,
  resolveSpans,
  tokenSpans,
  type Detector,
  type PiiPatternCache,
  type PiiSettings,
  type PiiSpan,
  type PiiStatus
} from '../shared/pii'
import type { CredentialEntry } from '../shared/credentials'
import { adaptSource } from './piiSources'
import { run } from './provision'
import * as store from './store'
import { createLogger } from './log'

const log = createLogger('pii')

/** The seam sessions.ts talks to. Deliberately narrow: four calls, no settings. */
export interface PiiMask {
  /** Masking can run right now — a backend is selected *and* usable (§5.1). */
  ready(): boolean
  /** real → token, for one session's outbound prompt text. Rejects rather than
   *  falling back to the cleartext: failing open would defeat the whole point. */
  encode(sessionId: string, text: string): Promise<string>
  /** token → real, for everything coming back to that session. Always safe to
   *  call: text with no tokens, or a session with no key, comes back unchanged. */
  decode(sessionId: string, text: string): string
  /** The session is gone — drop its key, and with it its tokens forever (§3). */
  drop(sessionId: string): void
}

/** The masker plus the settings surface the IPC layer drives. */
export interface PiiManager extends PiiMask {
  /** Read settings + pattern caches off disk. Awaited once, during boot restore. */
  load(): Promise<void>
  status(): PiiStatus
  setSettings(settings: PiiSettings): Promise<PiiStatus>
  /** Fetch → adapt → cache one source at its pinned ref (§4.1). */
  refreshSource(sourceId: string): Promise<PiiStatus>
}

// --- external backend: the Presidio analyzer HTTP API ------------------------

/**
 * Pinned, like every other image gurt runs. One minor behind the recognizer
 * source's own pin (§4.1) simply because that is the newest published image —
 * both are release-tagged, neither is `latest`.
 */
const PRESIDIO_IMAGE = 'mcr.microsoft.com/presidio-analyzer:2.2.362'
/** Docker is the registry here too — the name *is* the lookup (see containers.ts). */
const PRESIDIO_CONTAINER = 'gurt-presidio-analyzer'

/**
 * `POST /analyze` — Presidio's own shape. We ask it for spans only and never
 * for its `anonymize` service: the replacement is ours to make, under our key.
 */
function presidioDetector(url: string, apiKey?: string): Detector {
  return {
    async detect(text: string): Promise<PiiSpan[]> {
      const res = await fetch(`${url}/analyze`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify({ text, language: 'en' }),
        signal: AbortSignal.timeout(20_000)
      })
      if (!res.ok) throw new Error(`presidio analyzer answered ${res.status}`)
      const raw = (await res.json()) as unknown
      if (!Array.isArray(raw)) throw new Error('presidio analyzer returned an unexpected body')
      const spans: PiiSpan[] = []
      for (const r of raw as Record<string, unknown>[]) {
        const start = Number(r.start)
        const end = Number(r.end)
        const type = typeof r.entity_type === 'string' ? r.entity_type : ''
        if (Number.isInteger(start) && Number.isInteger(end) && end > start && type)
          spans.push({ start, end, type })
      }
      return spans
    }
  }
}

/**
 * Bring up the local analyzer sidecar. The env-image path builds from a
 * devcontainer; there is nothing to build here, so the analogue of
 * `docker build`/`up` is a `docker run` of the pinned published image, named so
 * the daemon itself answers "is it already there?". Best-effort by design: a
 * failure is logged and surfaces as the first `analyze` call failing, which is
 * where the user can actually see it.
 */
async function ensureLocalAnalyzer(port: number): Promise<void> {
  const sink = (line: string): void => log.debug('presidio.docker', { line })
  const existing = (await run('docker', ['ps', '-aq', '--filter', `name=^${PRESIDIO_CONTAINER}$`], sink).catch(() => '')).trim()
  if (existing) {
    await run('docker', ['start', PRESIDIO_CONTAINER], sink)
    return
  }
  await run(
    'docker',
    [
      'run', '-d',
      '--name', PRESIDIO_CONTAINER,
      '--label', 'gurt.pii=analyzer',
      '--restart', 'unless-stopped',
      '-p', `127.0.0.1:${port}:3000`,
      PRESIDIO_IMAGE
    ],
    sink
  )
}

// --- the manager -------------------------------------------------------------

export interface PiiDeps {
  /** The credential store, for the `pii-detector` entry a remote analyzer links (§5.3). */
  credentials: () => Promise<CredentialEntry[]>
}

export function createPiiMask(deps: PiiDeps): PiiManager {
  let settings: PiiSettings = {}
  let caches: Record<string, PiiPatternCache> = {}
  /** Resolved from the linked `pii-detector` credential; refreshed with settings. */
  let credentialUrl: string | undefined
  let credentialKey: string | undefined
  let detector: Detector | null = null
  let error: string | undefined = 'masking settings have not been read yet'
  /** Per session id, its own 32-byte key. In-memory only — §3's auto-expiry. */
  const keys = new Map<string, Buffer>()

  /** Rebuild the active detector from the current settings. Never throws: an
   *  unusable configuration becomes `error`, which is what the chip explains. */
  function rebuild(): void {
    error = piiConfigError(settings, sourceStates(), credentialUrl)
    if (error) {
      detector = null
      return
    }
    if (settings.backend === 'built-in') {
      detector = builtinDetector(caches[settings.source!].patterns)
      return
    }
    detector = presidioDetector(presidioUrl(settings, credentialUrl), credentialKey)
  }

  function sourceStates(): PiiStatus['sources'] {
    const out: PiiStatus['sources'] = {}
    for (const [id, c] of Object.entries(caches))
      out[id] = { ref: c.ref, fetchedAt: c.fetchedAt, patterns: c.patterns.length, skipped: c.skipped }
    return out
  }

  async function resolveCredential(): Promise<void> {
    credentialUrl = undefined
    credentialKey = undefined
    if (!settings.credentialId) return
    const entry = (await deps.credentials()).find((c) => c.id === settings.credentialId)
    if (!entry) {
      log.warn('pii.credential-missing', { id: settings.credentialId })
      return
    }
    credentialUrl = entry.data.url || undefined
    credentialKey = entry.data.apiKey || undefined
  }

  function key(sessionId: string): Buffer {
    let k = keys.get(sessionId)
    if (!k) {
      // Generated here, by us, at the session's first masked byte — §3's key
      // policy in one line. It is never written anywhere, so the tokens of a
      // finished session stop being decodable when the app exits.
      k = randomBytes(32)
      keys.set(sessionId, k)
    }
    return k
  }

  /**
   * `AES-GCM(sessionKey, realValue)`, with the IV derived from the value
   * instead of drawn at random: the same value must produce the same token
   * every time it appears in a session, or the agent could not tell that two
   * mentions are the same person. The key is what keeps that from being a leak
   * — without it the mapping is unguessable — and the type is bound in as
   * additional data, so a token cannot be re-labelled and still decode.
   */
  function seal(k: Buffer, type: string, value: string): string {
    const iv = createHmac('sha256', k).update(`${type}\0${value}`).digest().subarray(0, 12)
    const cipher = createCipheriv('aes-256-gcm', k, iv)
    cipher.setAAD(Buffer.from(type, 'utf8'))
    const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url')
  }

  /** The inverse; null for a token this key did not produce (another session's,
   *  or one from a previous run whose key is gone). The caller leaves those
   *  alone rather than showing an error where a value used to be. */
  function open(k: Buffer, type: string, payload: string): string | null {
    const buf = Buffer.from(payload, 'base64url')
    if (buf.length <= 28) return null
    try {
      const decipher = createDecipheriv('aes-256-gcm', k, buf.subarray(0, 12))
      decipher.setAAD(Buffer.from(type, 'utf8'))
      decipher.setAuthTag(buf.subarray(12, 28))
      return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8')
    } catch {
      return null
    }
  }

  const manager: PiiManager = {
    async load(): Promise<void> {
      settings = await store.getPiiSettings()
      caches = await store.readPiiPatterns()
      await resolveCredential()
      rebuild()
      log.info('pii.loaded', {
        backend: settings.backend,
        source: settings.source,
        ready: !error,
        reason: error
      })
    },

    ready: () => !!detector,

    status: (): PiiStatus => ({
      settings,
      ready: !!detector,
      reason: error,
      sources: sourceStates()
    }),

    async setSettings(next: PiiSettings): Promise<PiiStatus> {
      settings = {
        backend: next.backend,
        source: next.source,
        presidioMode: next.presidioMode,
        presidioUrl: next.presidioUrl?.trim() || undefined,
        presidioPort: next.presidioPort,
        credentialId: next.credentialId || undefined
      }
      await store.setPiiSettings(settings)
      await resolveCredential()
      // Selecting the built-in backend with a source that was never fetched is
      // the normal first-run path — fetch it now, so "pick a source" is the
      // whole gesture (§5.1). A failure leaves the setting saved and the reason
      // on the status, which is what the section renders.
      if (settings.backend === 'built-in' && settings.source && !caches[settings.source])
        await manager.refreshSource(settings.source).catch((e) =>
          log.warn('pii.fetch-failed', { source: settings.source, err: e })
        )
      if (settings.backend === 'presidio' && settings.presidioMode === 'local')
        await ensureLocalAnalyzer(settings.presidioPort ?? PII_DEFAULT_PORT).catch((e) =>
          log.warn('pii.sidecar-failed', { err: e })
        )
      rebuild()
      return manager.status()
    },

    async refreshSource(sourceId: string): Promise<PiiStatus> {
      const def = piiSourceDef(sourceId)
      if (!def) throw new Error(`unknown pattern source "${sourceId}"`)
      const raw: Record<string, string> = {}
      for (const file of def.files) {
        const url = piiSourceUrl(def, file)
        const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
        if (!res.ok) throw new Error(`${url} answered ${res.status}`)
        raw[file] = await res.text()
      }
      const adapted = adaptSource(sourceId, raw)
      const cache: PiiPatternCache = {
        source: sourceId,
        ref: def.ref,
        fetchedAt: new Date().toISOString(),
        raw,
        patterns: adapted.patterns,
        skipped: adapted.skipped
      }
      await store.writePiiPatterns(cache)
      caches = { ...caches, [sourceId]: cache }
      log.info('pii.source-fetched', {
        source: sourceId,
        ref: def.ref,
        patterns: adapted.patterns.length,
        skipped: adapted.skipped
      })
      rebuild()
      return manager.status()
    },

    async encode(sessionId: string, text: string): Promise<string> {
      const active = detector
      if (!active || !text) return text
      const found = await active.detect(text)
      // Text can already carry tokens — the composer quotes an earlier answer,
      // the user pastes one back. Those spans are off limits: re-encoding a
      // token would bury the real value one layer deeper on every round trip.
      const guards = tokenSpans(text)
      const spans = resolveSpans(
        found.filter((s) => !guards.some((g) => s.start < g.end && g.start < s.end))
      )
      if (!spans.length) return text
      const k = key(sessionId)
      return replaceSpans(text, spans, (value, type) => piiToken(type, seal(k, type, value)))
    },

    decode(sessionId: string, text: string): string {
      const k = keys.get(sessionId)
      // Decoding does not depend on the *current* settings: a session that was
      // masked keeps its own key for its whole life, so turning masking off
      // mid-session never leaves the user staring at raw tokens.
      if (!k || !text || !text.includes('<')) return text
      return text.replace(PII_TOKEN_RE, (whole, type: string, payload: string) => {
        const real = open(k, type, payload)
        return real === null ? whole : real
      })
    },

    drop(sessionId: string): void {
      keys.delete(sessionId)
    }
  }
  return manager
}
