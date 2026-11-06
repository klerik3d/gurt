import { usePreference, z } from '../../persisted'
import { useEffect, useRef, useState } from 'react'
import type {
  CredentialEntry,
  CredentialKind,
  CredentialKindDef
} from '../../../../shared/credentials'
import {
  CREDENTIAL_KINDS,
  OAUTH_PROVIDER_CHOICES,
  isGitKind,
  oauthSignedOut,
  signedOutError
} from '../../../../shared/credentials'
import { useOutsideClose } from '../../hooks'
import { confirmDialog } from '../../dialog'
import { Icon } from '../icons'
import { run } from '../../async'

// ---- Credentials (#4d) ----

const hostsToText = (hosts: string[]) => hosts.join(', ')
const textToHosts = (text: string) => text.split(',').map((h) => h.trim()).filter(Boolean)

/** Preview of an entry's secret field for the collapsed row. `data.secret` is
 *  already masked server-side (getCredentials() never serves plaintext) — used
 *  as-is. */
function maskedPreview(c: CredentialEntry): string {
  if (c.kind === 'oauth')
    return c.data['account'] ? `signed in as ${c.data['account']}` : 'not signed in'
  if (c.data['secret']) return c.data['secret']
  return c.kind === 'git-host' ? 'ambient host auth' : '—'
}

const KIND_TAG: Record<CredentialKind, string> = {
  'git-token': 'token',
  'git-app': 'app',
  'git-host': 'host',
  'agent-token': 'agent',
  'mcp-token': 'mcp',
  oauth: 'oauth',
  'pii-detector': 'pii'
}

/** Tag for a stored entry, tolerating a kind this build retired (§10.1) — such
 *  an entry still round-trips through credentials.json, so the UI has to be
 *  able to draw it. */
const kindTag = (kind: string): string => KIND_TAG[kind as CredentialKind] ?? kind

export function CredentialsSection() {
  const [usage, setUsage] = useState<Record<string, string[] | null>>({})
  const [filter, setFilter] = usePreference<'all' | 'unused' | 'used'>('credentialFilter', 'all', z.enum(['all', 'unused', 'used']))
  const [query, setQuery] = usePreference('credentialSearch', '', z.string())
  const [entries, setEntries] = useState<CredentialEntry[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [draft, setDraft] = useState<CredentialEntry | null>(null)
  const [draftHosts, setDraftHosts] = useState('')
  const [plaintext, setPlaintext] = useState(false)
  const [error, setError] = useState('')
  // A browser sign-in round-trip is pending for the open card (§4 of
  // docs/requirements-oauth-credentials.md). One attempt at most: the button
  // becomes Cancel, and main cancels-and-restarts if asked again anyway.
  const [signingIn, setSigningIn] = useState(false)
  // Entries created this session: their secret must be typed in before the
  // first save. For anything already stored, an empty secret field means
  // "keep the stored one" — so only fresh entries get the required check.
  const freshIds = useRef(new Set<string>())

  useEffect(() => {
    window.gurt
      .getCredentials()
      .then((f) => {
        setEntries(f.credentials)
        setPlaintext(!!f.plaintext)
      })
      .catch((e: unknown) => setError(String(e)))
  }, [])

  useEffect(() => {
    let cancelled = false
    setUsage({})
    void Promise.all((entries ?? []).map(async (entry) => {
      try { return [entry.id, await window.gurt.credentialUsedBy(entry.id)] as const }
      catch { return [entry.id, null] as const }
    })).then((pairs) => { if (!cancelled) setUsage(Object.fromEntries(pairs)) })
    return () => { cancelled = true }
  }, [entries])

  const expand = (c: CredentialEntry) => {
    setOpen(c.id)
    // Secret fields open empty — the served value is only ever a mask, and an
    // empty field on save means "keep what's stored" (main's sentinel
    // resolution). The mask shows up as the input's placeholder instead.
    const data = { ...c.data }
    for (const f of kindDef(c.kind)?.fields ?? []) if (f.secret) data[f.key] = ''
    setDraft({ ...c, data })
    setDraftHosts(hostsToText(c.hosts))
    setError('')
  }

  const collapse = () => {
    // Dismissing the card abandons its pending sign-in: the loopback listener
    // must not outlive the UI that started it.
    if (signingIn && open) void window.gurt.oauthCancel(open)
    setSigningIn(false)
    setOpen(null)
    setDraft(null)
    setError('')
    setEntries((prev) => prev && prev.filter((c) => c.label.trim() || c.id !== open))
  }

  const add = () => {
    const e: CredentialEntry = {
      id: crypto.randomUUID(),
      label: '',
      kind: 'git-token',
      hosts: [],
      data: {}
    }
    freshIds.current.add(e.id)
    setEntries((prev) => [...(prev ?? []), e])
    expand(e)
  }

  const persist = async (out: CredentialEntry[]) => {
    await window.gurt.setCredentials({ credentials: out })
    // Re-read: save-time verification may stamp identity fields.
    const f = await window.gurt.getCredentials()
    setEntries(f.credentials)
    setPlaintext(!!f.plaintext)
  }

  const save = async () => {
    if (!entries || !draft) return
    if (!draft.label.trim()) {
      setError('name must not be empty')
      return
    }
    if (freshIds.current.has(draft.id)) {
      // Hidden fields are the flow-obtained ones (oauth) — there is nothing
      // the user could type, so the required check skips them: saving a
      // not-yet-signed-in entry is legal, it just blocks at resolve time.
      const missing = (kindDef(draft.kind)?.fields ?? []).find(
        (f) => f.secret && !f.hidden && !(draft.data[f.key] ?? '').trim()
      )
      if (missing) {
        setError(`${missing.label} must not be empty`)
        return
      }
    }
    const cleaned: CredentialEntry = {
      ...draft,
      // Non-git kinds never host-match; drop hosts a kind switch may have left behind.
      hosts: isGitKind(draft.kind) ? textToHosts(draftHosts) : []
    }
    const out = entries
      .map((c) => (c.id === draft.id ? cleaned : c))
      .filter((c) => c.label.trim())
    setError('')
    try {
      await persist(out)
      freshIds.current.delete(draft.id)
      setOpen(null)
      setDraft(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * Run the browser sign-in for the open `oauth` draft
   * (docs/requirements-oauth-credentials.md §4). Main owns the whole flow —
   * system browser, loopback listener, code exchange — and persists the token
   * set itself; the renderer only ever sees the refreshed masked view. A
   * successful sign-in *is* the save for a fresh entry, so the label has to be
   * there first. On failure the entry stays as it was and the provider's
   * error shows as a sentence.
   */
  const signIn = async () => {
    if (!draft) return
    if (!draft.label.trim()) {
      setError('name must not be empty')
      return
    }
    if (!(draft.data['providerId'] ?? '').trim()) {
      setError('choose a provider first')
      return
    }
    setError('')
    setSigningIn(true)
    try {
      await window.gurt.oauthSignIn({ ...draft, kind: 'oauth', hosts: [] })
      freshIds.current.delete(draft.id)
      const f = await window.gurt.getCredentials()
      setEntries(f.credentials)
      setPlaintext(!!f.plaintext)
      // Reopen from the stored view, the way expand() does, so the card now
      // shows "signed in as <account>" and Re-authenticate.
      const stored = f.credentials.find((x) => x.id === draft.id)
      if (stored) {
        const data = { ...stored.data }
        for (const fld of kindDef(stored.kind)?.fields ?? []) if (fld.secret) data[fld.key] = ''
        setDraft({ ...stored, data })
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // Cancelled by the user (the Cancel button, or a restart) — not an error.
      if (!message.includes('cancelled')) setError(message)
    } finally {
      setSigningIn(false)
    }
  }

  const remove = async (c: CredentialEntry) => {
    setError('')
    // Block deleting an entry a repo, client or MCP server still links to (§9).
    const used = await window.gurt.credentialUsedBy(c.id).catch(() => [])
    if (used.length) {
      setError(`linked by ${used.join(', ')} — unlink it (repo / client / MCP settings) first`)
      return
    }
    if (
      !(await confirmDialog(`Delete credential "${c.label || 'unnamed'}"?`, {
        title: 'Delete credential',
        confirmText: 'Delete',
        danger: true
      }))
    )
      return
    const out = (entries ?? []).filter((e) => e.id !== c.id && e.label.trim())
    try {
      await persist(out)
      if (open === c.id) {
        setOpen(null)
        setDraft(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const visible = (entries ?? []).filter((c) => c.id === open || (
    (filter === 'all' || (Array.isArray(usage[c.id]) && (filter === 'unused' ? usage[c.id]!.length === 0 : usage[c.id]!.length > 0))) &&
    [c.label, kindTag(c.kind), ...c.hosts, ...(usage[c.id] ?? [])].join(' ').toLowerCase().includes(query.toLowerCase())
  ))
  const usageMarkers = (id: string) => <span className="cred-usage">
    {usage[id] === undefined ? <span className="faint">Checking usage…</span> : usage[id] === null ? <span className="yellow">Usage unavailable</span> :
      usage[id].length ? usage[id].map((label) => <span key={label} className="tag" title={label}>{label}</span>) : <span className="tag faint">Unused</span>}
  </span>
  const count = (entries ?? []).filter((c) => c.label.trim()).length
  const kindDef = (kind: CredentialKind): CredentialKindDef | undefined =>
    CREDENTIAL_KINDS.find((k) => k.kind === kind)

  return (
    <>
      <div className="set-head">
        <div className="set-title-wrap">
          <span className="set-title">Credentials</span>
          <span className="set-count mono">
            {count} stored · <Icon name="lock" size={10} /> stored locally, plaintext never sent
          </span>
        </div>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={add}>
          + New credential
        </button>
      </div>
      {plaintext && (
        <div className="error">
          secrets are stored unencrypted — no system keystore available
        </div>
      )}
      <div className="set-list">
        <div className="cred-filters">
          <div className="cred-filter-options" role="group" aria-label="Credential usage">
            {(['all', 'unused', 'used'] as const).map((value) => <button key={value} className={`btn btn-xs${filter === value ? ' active' : ''}`} aria-pressed={filter === value} onClick={() => setFilter(value)}>
              {value === 'all' ? 'All' : value === 'unused' ? 'Unused' : 'In use'}
            </button>)}
          </div>
          <input className="input" aria-label="Search credentials" placeholder="Search name, type, host or usage…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {visible.map((c) => {
          if (open !== c.id) {
            if (!c.label.trim()) return null
            return (
              <div key={c.id} className="set-row clickable" onClick={() => expand(c)}>
                <Icon name="key" size={13} className="faint" style={{ flex: 'none' }} />
                <span className="cred-name mono">{c.label}</span>
                <span className="cred-tag">
                  <span className="tag">{kindTag(c.kind)}</span>
                </span>
                {usageMarkers(c.id)}
                <span className="cred-preview mono">{maskedPreview(c)}</span>
                <Icon name="chevron" size={12} className="faint" style={{ transform: 'rotate(-90deg)' }} />
              </div>
            )
          }
          const def = draft ? kindDef(draft.kind) : null
          return (
            <div key={c.id} className="set-card">
              <div className="set-card-head" onClick={collapse}>
                <Icon name="key" size={13} style={{ color: 'var(--yellow)', flex: 'none' }} />
                <span className="cred-name mono">{draft?.label || c.label || 'new credential'}</span>
                <span className="cred-tag">
                  <span className="tag">{kindTag(draft?.kind ?? c.kind)}</span>
                </span>
                {usageMarkers(c.id)}
                <span className="cred-preview mono">{maskedPreview(c)}</span>
                <Icon name="chevron" size={12} className="faint" />
              </div>
              {draft && (
                <div className="set-card-body">
                  <div className="cred-grid">
                    <label className="fld">
                      <span className="seclabel">NAME</span>
                      <input
                        className="input mono"
                        autoFocus={!c.label}
                        placeholder="GITHUB_TOKEN"
                        value={draft.label}
                        onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                      />
                    </label>
                    <div className="fld cred-type">
                      <span className="seclabel">TYPE</span>
                      <KindPick
                        value={draft.kind}
                        onPick={(kind) => setDraft({ ...draft, kind })}
                      />
                    </div>
                  </div>
                  <div className={def ? 'fld-hint' : 'error'}>
                    {def ? (
                      <>
                        {def.hint}
                        {!def.implemented && ' — stored, runtime not wired yet'}
                      </>
                    ) : (
                      `"${draft.kind}" credentials are no longer supported — ssh git access was ` +
                      'removed; anything resolving to this entry is blocked. Switch it to a token ' +
                      'credential above, or delete it.'
                    )}
                  </div>
                  {(def?.fields ?? []).filter((f) => !f.hidden).map((f) => (
                    <label key={f.key} className="fld">
                      <span className="seclabel">{f.label.toUpperCase()}</span>
                      <input
                        className="input mono"
                        type={f.secret ? 'password' : 'text'}
                        placeholder={f.secret ? c.data[f.key] || f.placeholder : f.placeholder}
                        value={draft.data[f.key] ?? ''}
                        onChange={(e) =>
                          setDraft({ ...draft, data: { ...draft.data, [f.key]: e.target.value } })
                        }
                      />
                    </label>
                  ))}
                  {draft.kind === 'oauth' && (
                    <>
                      <div className="fld cred-type">
                        <span className="seclabel">PROVIDER</span>
                        <ProviderPick
                          value={draft.data['providerId'] ?? ''}
                          onPick={(id) =>
                            setDraft({ ...draft, data: { ...draft.data, providerId: id } })
                          }
                        />
                      </div>
                      {/* State is read from the *stored* masked entry `c`, not
                          the draft — expand() blanks the draft's secret fields,
                          which would read as signed out. */}
                      {c.data['refresh'] && !oauthSignedOut(c) && (
                        <div className="fld-hint">
                          signed in as {c.data['account'] || 'an unnamed account'}
                        </div>
                      )}
                      {oauthSignedOut(c) && c.data['account'] && (
                        <div className="error">{signedOutError(c)}</div>
                      )}
                      <div className="set-card-foot" style={{ justifyContent: 'flex-start' }}>
                        {signingIn ? (
                          <>
                            <span className="fld-hint">waiting for the browser sign-in…</span>
                            <button
                              className="btn"
                              onClick={() => void window.gurt.oauthCancel(draft.id)}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button className="btn" onClick={run(signIn)}>
                            {c.data['refresh'] && !oauthSignedOut(c) ? 'Re-authenticate' : 'Sign in'}
                          </button>
                        )}
                      </div>
                    </>
                  )}
                  {draft.kind === 'git-token' && draft.data['gitEmail'] && (
                    <div className="fld-hint">
                      verified identity: {draft.data['gitName']} &lt;{draft.data['gitEmail']}&gt;
                    </div>
                  )}
                  {isGitKind(draft.kind) && (
                    <label className="fld">
                      <span className="seclabel">HOSTS</span>
                      <input
                        className="input mono"
                        placeholder="github.com (comma-separated; empty = link-only)"
                        value={draftHosts}
                        onChange={(e) => setDraftHosts(e.target.value)}
                      />
                    </label>
                  )}
                  {error && <div className="error">{error}</div>}
                  <div className="set-card-foot">
                    <button className="btn-danger-text" onClick={run(() => remove(c))}>
                      Delete
                    </button>
                    <span className="spacer" />
                    <button className="btn" onClick={collapse}>
                      Cancel
                    </button>
                    <button className="btn btn-primary" onClick={run(save)}>
                      Save
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
        {count > 0 && visible.length === 0 && <div className="tp-dashed">No credentials match these filters</div>}
        {count === 0 && open === null && <div className="tp-dashed">no credentials yet</div>}
      </div>
    </>
  )
}

/** Provider picker for an `oauth sign-in` entry — which of main's provider
 *  modules owns it (`data.providerId`). */
function ProviderPick({ value, onPick }: { value: string; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(open, ref, () => setOpen(false))
  const cur = OAUTH_PROVIDER_CHOICES.find((p) => p.id === value)
  return (
    <div className="pick-wrap" ref={ref}>
      <button type="button" className="pick-row" onClick={() => setOpen((o) => !o)}>
        <span className="pick-value">{cur?.label ?? 'choose provider…'}</span>
        <span className="spacer" />
        <Icon name="chevron" size={12} className="faint" style={{ flex: 'none' }} />
      </button>
      {open && (
        <div className="menu pick-menu">
          {OAUTH_PROVIDER_CHOICES.map((p) => (
            <div
              key={p.id}
              className={`menu-item ${p.id === value ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                onPick(p.id)
                setOpen(false)
              }}
            >
              {p.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Credential kind picker for the TYPE column. */
function KindPick({ value, onPick }: { value: CredentialKind; onPick: (k: CredentialKind) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(open, ref, () => setOpen(false))
  const cur = CREDENTIAL_KINDS.find((k) => k.kind === value)
  return (
    <div className="pick-wrap" ref={ref}>
      <button type="button" className="pick-row" onClick={() => setOpen((o) => !o)}>
        <span className="pick-value">{cur?.label ?? value}</span>
        <span className="spacer" />
        <Icon name="chevron" size={12} className="faint" style={{ flex: 'none' }} />
      </button>
      {open && (
        <div className="menu pick-menu">
          {CREDENTIAL_KINDS.map((k) => (
            <div
              key={k.kind}
              className={`menu-item ${k.kind === value ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                onPick(k.kind)
                setOpen(false)
              }}
            >
              {k.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
