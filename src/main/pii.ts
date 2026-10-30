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
  nerScriptMismatch,
  piiConfigError,
  piiSourceDef,
  piiSourceUrl,
  piiToken,
  piiType,
  presidioLanguages,
  presidioModelSize,
  presidioUrl,
  replaceSpans,
  resolveSpans,
  revealTokens,
  tokenSpans,
  type Detector,
  type PiiAnalyzerStatus,
  type PiiPatternCache,
  type PiiSettings,
  type PiiSpan,
  type PiiStatus,
  type PiiTable,
  type PiiTestResult
} from '../shared/pii'
import type { CredentialEntry } from '../shared/credentials'
import { adaptSource } from './piiSources'
import { analyzerPlan, createAnalyzer, healthy, supportedEntities, type Analyzer } from './piiAnalyzer'
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
  /** The presidio analyzer's live state; null while presidio is not the engine. */
  analyzer(): Promise<PiiAnalyzerStatus | null>
  /** Recreate the local sidecar from the current settings. Resolves once it is up or has failed. */
  restartAnalyzer(): Promise<void>
  /** Run the active detector over a sample without touching any session's table. */
  test(text: string): Promise<PiiTestResult>
}

// --- external backend: the Presidio analyzer HTTP API ------------------------

interface PresidioOptions {
  apiKey?: string | undefined
  languages: string[]
  threshold: number
  entities?: string[] | undefined
  /** An operation on the local sidecar that has not finished — fail fast with it. */
  pending: () => string | undefined
}

/**
 * `POST /analyze` — Presidio's own shape. We ask it for spans only and never
 * for its `anonymize` service: the replacement is ours to make, under our key.
 * The endpoint takes one language per call, so a text is analyzed once per
 * selected language and the findings are pooled; a NER finding in the wrong
 * script for its language is dropped (`nerScriptMismatch`).
 */
function presidioDetector(url: string, opts: PresidioOptions): Detector {
  async function analyze(text: string, language: string): Promise<PiiSpan[]> {
    const res = await fetch(`${url}/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {})
      },
      body: JSON.stringify({
        text,
        language,
        score_threshold: opts.threshold,
        ...(opts.entities?.length ? { entities: opts.entities } : {})
      }),
      signal: AbortSignal.timeout(20_000)
    })
    if (!res.ok) throw new Error(`presidio analyzer answered ${res.status} for language "${language}"`)
    const raw: unknown = await res.json()
    if (!Array.isArray(raw)) throw new Error('presidio analyzer returned an unexpected body')
    const spans: PiiSpan[] = []
    for (const r of raw as Record<string, unknown>[]) {
      const start = Number(r['start'])
      const end = Number(r['end'])
      const type = typeof r['entity_type'] === 'string' ? r['entity_type'] : ''
      const score = typeof r['score'] === 'number' ? r['score'] : undefined
      if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start || !type) continue
      // Applied here too: a remote analyzer is not ours to trust with the threshold.
      if (score !== undefined && score < opts.threshold) continue
      if (nerScriptMismatch(type, text.slice(start, end), language)) continue
      spans.push({ start, end, type, score })
    }
    return spans
  }
  return {
    async detect(text: string): Promise<PiiSpan[]> {
      const busy = opts.pending()
      if (busy) throw new Error(`presidio analyzer is not up yet (${busy})`)
      return (await Promise.all(opts.languages.map((l) => analyze(text, l)))).flat()
    }
  }
}

// --- the manager -------------------------------------------------------------

export interface PiiDeps {
  /** The credential store, for the `pii-detector` entry a remote analyzer links (§5.3). */
  credentials: () => Promise<CredentialEntry[]>
  /** The local sidecar; a test passes its own so no docker is ever touched. */
  analyzer?: Analyzer | undefined
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
  const sidecar = deps.analyzer ?? createAnalyzer()

  const isLocalPresidio = (): boolean =>
    settings.backend === 'presidio' && settings.presidioMode === 'local'
  const localPort = (): number => settings.presidioPort ?? PII_DEFAULT_PORT
  const localPlan = () => analyzerPlan(presidioLanguages(settings), presidioModelSize(settings))

  /** Whatever was found in `text`, minus what is already a token, made non-overlapping. */
  async function spansIn(active: Detector, text: string): Promise<PiiSpan[]> {
    const found = await active.detect(text)
    // Text can already carry tokens — the composer quotes an earlier answer,
    // the user pastes one back. Those spans are off limits: they already mean
    // something, and re-detecting inside one would only invent a new row.
    const guards = tokenSpans(text)
    return resolveSpans(found.filter((s) => !guards.some((g) => s.start < g.end && g.start < s.end)))
  }

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
    const local = isLocalPresidio()
    detector = presidioDetector(presidioUrl(settings, credentialUrl), {
      apiKey: credentialKey,
      languages: presidioLanguages(settings),
      threshold: settings.presidioThreshold ?? 0,
      entities: settings.presidioEntities,
      pending: () => (local ? sidecar.pending() : undefined)
    })
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
      // The sidecar restarts with docker, but a plan changed while gurt was down
      // (or a removed container) is only noticed here. Not awaited: a build can
      // take minutes, and until it is up `encode` fails closed with the reason.
      if (isLocalPresidio()) void sidecar.ensure(localPlan(), localPort())
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
        credentialId: next.credentialId || undefined,
        presidioLanguages: next.presidioLanguages?.length ? [...next.presidioLanguages] : undefined,
        presidioModel: next.presidioModel,
        presidioThreshold:
          typeof next.presidioThreshold === 'number' && next.presidioThreshold > 0
            ? Math.min(1, next.presidioThreshold)
            : undefined,
        presidioEntities: next.presidioEntities?.length ? [...next.presidioEntities] : undefined
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
      rebuild()
      // In the background: pulling or building an image takes minutes. The
      // section polls `analyzer()` for progress, and `encode` fails closed
      // with the phase until the sidecar answers.
      if (isLocalPresidio()) void sidecar.ensure(localPlan(), localPort())
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
      const spans = await spansIn(active, text)
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

    async analyzer(): Promise<PiiAnalyzerStatus | null> {
      if (settings.backend !== 'presidio') return null
      const url = presidioUrl(settings, credentialUrl)
      const languages = presidioLanguages(settings)
      if (!isLocalPresidio()) {
        const up = !!url && (await healthy(url, credentialKey))
        return {
          mode: 'remote',
          url,
          state: up ? 'running' : 'unreachable',
          detail: up ? undefined : url ? `no answer from ${url}/health` : 'no analyzer url',
          entities: up ? await supportedEntities(url, languages, credentialKey) : []
        }
      }
      const plan = localPlan()
      const phase = await sidecar
        .status(plan, localPort())
        .catch((e: unknown) => ({ state: 'error' as const, detail: e instanceof Error ? e.message : String(e) }))
      return {
        mode: 'local',
        url,
        image: plan.image,
        state: phase.state,
        detail: phase.detail,
        entities: phase.state === 'running' ? await supportedEntities(url, languages) : []
      }
    },

    async restartAnalyzer(): Promise<void> {
      if (!isLocalPresidio()) throw new Error('the analyzer is not a local sidecar')
      await sidecar.ensure(localPlan(), localPort(), { recreate: true })
    },

    async test(text: string): Promise<PiiTestResult> {
      const active = detector
      if (!active) throw new Error(error ?? 'masking is off')
      const spans = await spansIn(active, text)
      // Ordinals as a fresh session would hand them out, left to right.
      const seen = new Map<string, string>()
      const counts = new Map<string, number>()
      for (const sp of spans) {
        const type = piiType(sp.type)
        const k = indexKey(type, text.slice(sp.start, sp.end))
        if (seen.has(k)) continue
        const n = (counts.get(type) ?? 0) + 1
        counts.set(type, n)
        seen.set(k, piiToken(type, n))
      }
      return {
        masked: replaceSpans(text, spans, (value, rawType) => seen.get(indexKey(piiType(rawType), value))!),
        findings: spans.map((sp) => ({
          type: piiType(sp.type),
          value: text.slice(sp.start, sp.end),
          score: sp.score
        }))
      }
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
