import { useCallback, useEffect, useState } from 'react'
import type { CredentialEntry } from '../../../../shared/credentials'
import { piiCredentials } from '../../../../shared/credentials'
import type {
  PiiAnalyzerState,
  PiiAnalyzerStatus,
  PiiBackendId,
  PiiSettings,
  PiiStatus,
  PiiTestResult
} from '../../../../shared/pii'
import {
  PII_BACKENDS,
  PII_DEFAULT_PORT,
  PII_SOURCES,
  PRESIDIO_LANGUAGES,
  PRESIDIO_MODELS,
  presidioLanguages,
  presidioModelSize
} from '../../../../shared/pii'
import { run } from '../../async'
import { CredentialPick } from './shared'

// ---- Masking — the PII/secret layer's global switch (docs/requirements-pii-mask.md §5.1) ----

/** `2026-08-20T…` → `20 Aug 2026`, for the "fetched" line under a source. */
const fetchedLabel = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString()
}

/** Analyzer states that end on their own — the section polls until they do. */
const ANALYZER_BUSY: PiiAnalyzerState[] = ['pulling', 'building', 'starting']

/**
 * Picks the active detector backend, and for the built-in one the pattern
 * source it runs (§4.1: nothing ships in the repo — a source is fetched once,
 * pinned to a commit/tag, and cached); for presidio, the analyzer's languages,
 * model, threshold and entity types, and its live state. TEST runs whatever is
 * active over a sample. No backend selected *is* "off": nothing is masked.
 * Facts and controls only — no prose explaining them.
 */
export function MaskingSection() {
  const [status, setStatus] = useState<PiiStatus | null>(null)
  const [credentials, setCredentials] = useState<CredentialEntry[]>([])
  /** Source id currently being fetched — the network is only touched here. */
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [analyzer, setAnalyzer] = useState<PiiAnalyzerStatus | null>(null)
  const [sample, setSample] = useState('')
  const [result, setResult] = useState<PiiTestResult | null>(null)
  const [testError, setTestError] = useState('')

  useEffect(() => {
    window.gurt.getPiiStatus().then(setStatus).catch((e) => setError(String(e)))
    window.gurt.getCredentials().then((f) => setCredentials(f.credentials)).catch(() => {})
  }, [])

  const probe = useCallback(() => {
    window.gurt
      .getPiiAnalyzer()
      .then(setAnalyzer)
      .catch(() => setAnalyzer(null))
  }, [])
  // Every settings change can mean a new image or container.
  useEffect(() => {
    if (status) probe()
  }, [status, probe])
  useEffect(() => {
    if (!analyzer || !ANALYZER_BUSY.includes(analyzer.state)) return
    const t = setTimeout(probe, 2000)
    return () => clearTimeout(t)
  }, [analyzer, probe])

  const settings = status?.settings ?? {}
  const detectors = piiCredentials(credentials)
  const languages = presidioLanguages(settings)
  const local = settings.presidioMode !== 'remote'
  const knownEntities = [
    ...new Set([...(analyzer?.entities ?? []), ...(settings.presidioEntities ?? [])])
  ].sort()
  const picked = settings.presidioEntities

  const save = async (patch: Partial<PiiSettings>) => {
    if (!status) return
    setError('')
    setBusy('save')
    try {
      setStatus(await window.gurt.setPiiSettings({ ...settings, ...patch }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const refresh = async (sourceId: string) => {
    setError('')
    setBusy(sourceId)
    try {
      setStatus(await window.gurt.refreshPiiSource(sourceId))
    } catch (e) {
      setError(`could not fetch patterns: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }

  const restart = async () => {
    setError('')
    setAnalyzer((a) => (a ? { ...a, state: 'starting', detail: undefined } : a))
    // Resolves only once the sidecar is up (or failed); the poll shows progress meanwhile.
    await window.gurt.restartPiiAnalyzer().catch((e) => setError(String(e)))
    probe()
  }

  const runTest = async () => {
    setTestError('')
    setResult(null)
    try {
      setResult(await window.gurt.testPii(sample))
    } catch (e) {
      setTestError(e instanceof Error ? e.message : String(e))
    }
  }

  const pickBackend = (backend: PiiBackendId | undefined) =>
    save({
      backend,
      // Selecting presidio for the first time lands on the mode that needs no
      // external service; the local sidecar comes up on save.
      presidioMode: backend === 'presidio' ? (settings.presidioMode ?? 'local') : settings.presidioMode
    })

  const toggleLanguage = (id: string) => {
    const next = languages.includes(id) ? languages.filter((l) => l !== id) : [...languages, id]
    // At least one: an analyzer with no language cannot analyze anything.
    if (next.length) void save({ presidioLanguages: next })
  }

  // No selection means every type; a chip shows on while its type is masked.
  const entityOn = (e: string) => !picked?.length || picked.includes(e)
  const toggleEntity = (e: string) => {
    const current = picked?.length ? picked : knownEntities
    const next = current.includes(e) ? current.filter((x) => x !== e) : [...current, e]
    if (!next.length) return
    void save({
      presidioEntities: knownEntities.every((x) => next.includes(x)) ? undefined : next
    })
  }

  const analyzerBusy = !!analyzer && ANALYZER_BUSY.includes(analyzer.state)

  return (
    <>
      <div className="set-head">
        <div className="set-title-wrap">
          <span className="set-title">Masking</span>
          <span className="set-count mono">{status ? (status.ready ? 'on' : 'off') : '…'}</span>
        </div>
      </div>
      <div className="set-list">
        <div className="set-card">
          <div className="set-card-body">
            <div className="fld">
              <span className="seclabel">ENGINE</span>
              <div className="chip-row">
                <button
                  type="button"
                  className={`chip-btn ${settings.backend ? '' : 'on'}`}
                  disabled={!status || !!busy}
                  onClick={run(() => pickBackend(undefined))}
                >
                  off
                </button>
                {PII_BACKENDS.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    className={`chip-btn ${settings.backend === b.id ? 'on' : ''}`}
                    disabled={!status || !!busy}
                    onClick={run(() => pickBackend(b.id))}
                  >
                    {b.label}
                  </button>
                ))}
              </div>
            </div>

            {settings.backend === 'built-in' && (
              <div className="fld">
                <span className="seclabel">RULES</span>
                {PII_SOURCES.map((src) => {
                  const cached = status?.sources[src.id]
                  const active = settings.source === src.id
                  const stale = cached && cached.ref !== src.ref
                  return (
                    <div key={src.id} className="mask-src">
                      <div className="mask-src-main">
                        <div className="mask-src-name">
                          {src.label} <span className="tag">{src.license}</span>
                        </div>
                        <div className="fld-hint mono">
                          {cached
                            ? `${cached.patterns} patterns${cached.skipped ? ` · ${cached.skipped} skipped` : ''} · fetched ${fetchedLabel(cached.fetchedAt)}${stale ? ' · update available' : ''}`
                            : 'not fetched yet'}
                        </div>
                      </div>
                      <button
                        type="button"
                        className={`chip-btn ${active ? 'on' : ''}`}
                        disabled={!status || !!busy}
                        onClick={run(() => save({ source: src.id }))}
                      >
                        {active ? 'active' : 'use'}
                      </button>
                      <button
                        type="button"
                        className="chip-btn"
                        disabled={!status || !!busy}
                        onClick={() => void refresh(src.id)}
                        title={`GET ${src.repo} at ${src.ref}`}
                      >
                        {busy === src.id ? 'fetching…' : cached ? 'update' : 'fetch'}
                      </button>
                    </div>
                  )
                })}
              </div>
            )}

            {settings.backend === 'presidio' && (
              <>
                <div className="fld narrow">
                  <span className="seclabel">ANALYZER</span>
                  <div className="chip-row">
                    <button
                      type="button"
                      className={`chip-btn ${local ? 'on' : ''}`}
                      disabled={!status || !!busy}
                      onClick={run(() => save({ presidioMode: 'local' }))}
                      title="gurt runs the analyzer image as a local docker sidecar"
                    >
                      run locally
                    </button>
                    <button
                      type="button"
                      className={`chip-btn ${!local ? 'on' : ''}`}
                      disabled={!status || !!busy}
                      onClick={run(() => save({ presidioMode: 'remote' }))}
                      title="an analyzer you already run"
                    >
                      remote
                    </button>
                  </div>
                </div>
                {!local ? (
                  <>
                    <label className="fld narrow">
                      <span className="seclabel">ANALYZER URL</span>
                      <input
                        className="input mono"
                        placeholder="https://presidio.internal:3000"
                        defaultValue={settings.presidioUrl ?? ''}
                        title="left empty, the linked credential's own url is used"
                        onBlur={(e) => {
                          if (e.target.value.trim() !== (settings.presidioUrl ?? ''))
                            void save({ presidioUrl: e.target.value })
                        }}
                      />
                    </label>
                    <div className="fld narrow">
                      <span className="seclabel">CREDENTIAL</span>
                      <CredentialPick
                        tokens={detectors}
                        value={settings.credentialId}
                        onPick={(credentialId) => void save({ credentialId })}
                      />
                      {detectors.length === 0 && (
                        <div className="fld-hint">no pii detector credentials yet</div>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <label className="fld narrow">
                      <span className="seclabel">HOST PORT</span>
                      <input
                        className="input mono"
                        placeholder={String(PII_DEFAULT_PORT)}
                        defaultValue={String(settings.presidioPort ?? PII_DEFAULT_PORT)}
                        onBlur={(e) => {
                          const port = Number(e.target.value)
                          if (Number.isInteger(port) && port > 0 && port !== settings.presidioPort)
                            void save({ presidioPort: port })
                        }}
                      />
                    </label>
                    <div className="fld">
                      <span className="seclabel">MODEL</span>
                      <div className="chip-row">
                        {PRESIDIO_MODELS.map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            className={`chip-btn ${presidioModelSize(settings) === m.id ? 'on' : ''}`}
                            disabled={!status || !!busy}
                            onClick={run(() => save({ presidioModel: m.id }))}
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
                <div className="fld">
                  <span className="seclabel">LANGUAGES</span>
                  <div className="chip-row">
                    {PRESIDIO_LANGUAGES.map((l) => (
                      <button
                        key={l.id}
                        type="button"
                        className={`chip-btn ${languages.includes(l.id) ? 'on' : ''}`}
                        disabled={!status || !!busy}
                        onClick={() => toggleLanguage(l.id)}
                      >
                        {l.label}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="fld narrow">
                  <span className="seclabel">MIN SCORE</span>
                  <input
                    key={settings.presidioThreshold ?? 0}
                    className="input mono"
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    defaultValue={settings.presidioThreshold ?? 0}
                    onBlur={(e) => {
                      const v = Number(e.target.value)
                      if (Number.isFinite(v) && v >= 0 && v <= 1 && v !== (settings.presidioThreshold ?? 0))
                        void save({ presidioThreshold: v })
                    }}
                  />
                </label>
                {knownEntities.length > 0 && (
                  <div className="fld">
                    <span className="seclabel">ENTITIES</span>
                    <div className="chip-row">
                      <button
                        type="button"
                        className={`chip-btn ${picked?.length ? '' : 'on'}`}
                        disabled={!status || !!busy}
                        onClick={run(() => save({ presidioEntities: undefined }))}
                      >
                        all
                      </button>
                      {knownEntities.map((e) => (
                        <button
                          key={e}
                          type="button"
                          className={`chip-btn ${entityOn(e) ? 'on' : ''}`}
                          disabled={!status || !!busy}
                          onClick={() => toggleEntity(e)}
                        >
                          {e.toLowerCase()}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="fld">
                  <span className="seclabel">STATUS</span>
                  <div className="mask-status">
                    <span className="fld-hint mono">
                      {analyzer
                        ? `${analyzer.image ?? analyzer.url} · ${analyzer.state}${analyzer.detail ? ` — ${analyzer.detail}` : ''}`
                        : '…'}
                    </span>
                    {local && (
                      <button
                        type="button"
                        className="chip-btn"
                        disabled={!status || !!busy || analyzerBusy}
                        onClick={() => void restart()}
                      >
                        restart
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}

            {status && settings.backend && !status.ready && (
              <div className="error">{status.reason}</div>
            )}

            {status?.ready && (
              <div className="fld">
                <span className="seclabel">TEST</span>
                <textarea
                  className="input mono"
                  rows={3}
                  spellCheck={false}
                  value={sample}
                  placeholder="My name is John Smith, mail john@example.com"
                  onChange={(e) => setSample(e.target.value)}
                />
                <div className="chip-row">
                  <button
                    type="button"
                    className="chip-btn"
                    disabled={!sample.trim() || !!busy}
                    onClick={() => void runTest()}
                  >
                    test
                  </button>
                </div>
                {result && (
                  <>
                    <pre className="mask-test-out mono">{result.masked}</pre>
                    {result.findings.map((f, i) => (
                      <div key={i} className="mask-finding mono">
                        <span>{f.type}</span>
                        <span>{f.value}</span>
                        <span>{f.score === undefined ? '' : f.score.toFixed(2)}</span>
                      </div>
                    ))}
                  </>
                )}
                {testError && <div className="error">{testError}</div>}
              </div>
            )}
            {error && <div className="error">{error}</div>}
          </div>
        </div>
      </div>
    </>
  )
}
