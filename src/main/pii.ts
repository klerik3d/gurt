// PII/secret masking, host side (docs/requirements-pii-mask.md).
//
// Owns the three things the pure module in shared/pii.ts deliberately does not:
// the per-session correspondence tables, the pattern fetch/cache, and the
// external detector backend. `encode` swaps a real value for `[type:N]`; the
// table that says what N is lives in one JSON file per session and is dropped
// with the session. There is no cryptography in the scheme: the table is what
// keeps reals out of the agent's context, and a table nobody ships to the agent
// is as private as any other file under ~/.gurt.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  PII_DEFAULT_PORT,
  builtinDetector,
  emptyPiiTable,
  piiConfigError,
  piiSourceDef,
  piiSourceUrl,
  piiToken,
  piiType,
  presidioUrl,
  replaceSpans,
  resolveSpans,
  revealTokens,
  tokenSpans,
  type Detector,
  type PiiPatternCache,
  type PiiSettings,
  type PiiSpan,
  type PiiStatus,
  type PiiTable
} from '../shared/pii'
import type { CredentialEntry } from '../shared/credentials'
import { adaptSource } from './piiSources'
import { run } from './provision'
import * as store from './store'
import { createLogger } from './log'

const log = createLogger('pii')

/** The seam sessions.ts talks to. Deliberately narrow: no settings. */
export interface PiiMask {
  /** Masking can run right now — a backend is selected *and* usable (§5.1). */
  ready(): boolean
  /** real → token, for one session's outbound text. Rejects rather than falling
   *  back to the cleartext: failing open would defeat the whole point. The new
   *  table entries are on disk before this resolves, so a token never reaches
   *  the agent without a row behind it. */
  encode(sessionId: string, text: string): Promise<string>
  /** token → real, for text main itself has to show. Always safe to call: text
   *  with no tokens, or a session with no table, comes back unchanged. */
  decode(sessionId: string, text: string): string
  /** The session's table as it stands — what the chat view substitutes from. */
  table(sessionId: string): PiiTable
  /** A session's table gained a row. Fires after the file is written. */
  onTable(listener: (sessionId: string, table: PiiTable) => void): void
  /** The session is gone — its table goes with it, so its tokens end (§3). */
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
      const raw: unknown = await res.json()
      if (!Array.isArray(raw)) throw new Error('presidio analyzer returned an unexpected body')
      const spans: PiiSpan[] = []
      for (const r of raw as Record<string, unknown>[]) {
        const start = Number(r['start'])
        const end = Number(r['end'])
        const type = typeof r['entity_type'] === 'string' ? r['entity_type'] : ''
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
  /** Per session id, its table plus the value → ordinal index encode needs. */
  const sessions = new Map<string, Held>()
  const listeners: Array<(sessionId: string, table: PiiTable) => void> = []
  /** Per-session write chain, so two encodes never interleave a file write. */
  const writes = new Map<string, Promise<void>>()

  /** Rebuild the active detector from the current settings. Never throws: an
   *  unusable configuration becomes `error`, which is what the chip explains. */
  function rebuild(): void {
    error = piiConfigError(settings, sourceStates(), credentialUrl)
    if (error) {
      detector = null
      return
    }
    if (settings.backend === 'built-in') {
      // `piiConfigError` has already refused a built-in backend whose source
      // is not cached, so the lookup always lands.
      detector = builtinDetector(caches[settings.source!]?.patterns ?? [])
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
    credentialUrl = entry.data['url'] || undefined
    credentialKey = entry.data['apiKey'] || undefined
  }

  /** The session's table, read off disk on first touch. Sync on purpose: it is
   *  a small file, and `decode` is a pure-looking call sites rely on. */
  function held(sessionId: string): Held {
    let h = sessions.get(sessionId)
    if (h) return h
    let table = emptyPiiTable()
    try {
      const raw = JSON.parse(fs.readFileSync(tableFile(sessionId), 'utf8')) as PiiTable
      if (raw && raw.v === 1 && raw.tokens && typeof raw.tokens === 'object') table = raw
    } catch {
      // No file yet (a fresh session) or one we cannot read: start empty. An
      // unreadable table only ever costs the tokens it held, never an error.
    }
    const index = new Map<string, string>()
    for (const [type, rows] of Object.entries(table.tokens))
      for (const [n, value] of Object.entries(rows)) index.set(indexKey(type, value), n)
    h = { table, index }
    sessions.set(sessionId, h)
    return h
  }

  /** Atomic, owner-only, and serialized per session. */
  function persist(sessionId: string, table: PiiTable): Promise<void> {
    const next = (writes.get(sessionId) ?? Promise.resolve()).then(async () => {
      const file = tableFile(sessionId)
      await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      const tmp = `${file}.tmp`
      await fsp.writeFile(tmp, JSON.stringify(table), { mode: 0o600 })
      await fsp.rename(tmp, file)
    })
    writes.set(sessionId, next.catch(() => {}))
    return next
  }

  /** The ordinal for one value, allocating the next free one on first sight. */
  function ordinal(h: Held, type: string, value: string): { n: string; added: boolean } {
    const k = indexKey(type, value)
    const known = h.index.get(k)
    if (known) return { n: known, added: false }
    const rows = (h.table.tokens[type] ??= {})
    // max + 1, never a count: ordinals are not reused, so a token cannot
    // silently come to mean a different value later in the session.
    const n = String(Math.max(0, ...Object.keys(rows).map(Number)) + 1)
    rows[n] = value
    h.index.set(k, n)
    return { n, added: true }
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
        await manager.refreshSource(settings.source).catch((e: unknown) =>
          log.warn('pii.fetch-failed', { source: settings.source, err: e })
        )
      if (settings.backend === 'presidio' && settings.presidioMode === 'local')
        await ensureLocalAnalyzer(settings.presidioPort ?? PII_DEFAULT_PORT).catch((e: unknown) =>
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
      // the user pastes one back. Those spans are off limits: they already mean
      // something, and re-detecting inside one would only invent a new row.
      const guards = tokenSpans(text)
      const spans = resolveSpans(
        found.filter((s) => !guards.some((g) => s.start < g.end && g.start < s.end))
      )
      if (!spans.length) return text
      const h = held(sessionId)
      // Ordinals are handed out left to right — `replaceSpans` works back to
      // front, so allocating inside its callback would number a text's values in
      // reverse order of appearance.
      let added = false
      const tokens = new Map<string, string>()
      for (const sp of spans) {
        const type = piiType(sp.type)
        const value = text.slice(sp.start, sp.end)
        const r = ordinal(h, type, value)
        added ||= r.added
        tokens.set(indexKey(type, value), piiToken(type, r.n))
      }
      const out = replaceSpans(
        text,
        spans,
        (value, rawType) => tokens.get(indexKey(piiType(rawType), value))!
      )
      if (added) {
        // Write-ahead: the row is durable before the token can leave.
        await persist(sessionId, h.table)
        for (const l of listeners) l(sessionId, h.table)
      }
      return out
    },

    decode: (sessionId: string, text: string): string => revealTokens(text, held(sessionId).table),

    table: (sessionId: string): PiiTable => held(sessionId).table,

    onTable(listener): void {
      listeners.push(listener)
    },

    drop(sessionId: string): void {
      sessions.delete(sessionId)
      const pending = writes.get(sessionId) ?? Promise.resolve()
      writes.delete(sessionId)
      // After any in-flight write, or the file would be recreated behind us.
      void pending.then(() => fsp.rm(tableFile(sessionId), { force: true })).catch(() => {})
    }
  }
  return manager
}

/** One session's table in memory, with the reverse index `encode` dedupes by. */
interface Held {
  table: PiiTable
  index: Map<string, string>
}

/** Outside every session mount: this directory is read by the host and by
 *  nothing that runs in a container. */
const tableFile = (sessionId: string): string =>
  path.join(store.gurtRoot, 'pii-tables', `${sessionId}.json`)

/** Same value, same token. Mail addresses are case-insensitive, so two spellings
 *  of one address are one row; everything else is compared as typed. */
const indexKey = (type: string, value: string): string =>
  `${type}\0${type === 'email' ? value.toLowerCase() : value}`
