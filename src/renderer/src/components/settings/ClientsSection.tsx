import {
  clientConfigPath,
  parseClientConfig,
  clientConfigExample
} from '../../../../shared/clientConfig'
import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { AgentInstance, AgentsFile } from '../../../../shared/types'
import type { CredentialEntry } from '../../../../shared/credentials'
import { agentCredentials } from '../../../../shared/credentials'
import { AGENT_MANIFESTS, DEFAULT_AGENT_KIND, agentDef } from '../../../../shared/agents'
import type { LimitSettings } from '../../../../shared/planUsage'
import { LIMIT_THRESHOLD_MAX, LIMIT_THRESHOLD_MIN } from '../../../../shared/planUsage'
import { refreshAgents } from '../../useAgents'
import { useOutsideClose } from '../../hooks'
import { confirmDialog } from '../../dialog'
import { AgentIcon, Icon } from '../icons'
import { AgentTag } from '../tags'
import { run } from '../../async'
import { CredentialPick } from './shared'

// ---- Clients (#4c) — agent instances ----

/** Temp-keyed rows are new instances whose id is minted from the label on save. */
const isTemp = (id: string) => id.startsWith('__new__:')

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

function uniqueId(label: string, kind: string, taken: Set<string>): string {
  const base = slug(label) || kind
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  return id
}

/** Serialize/parse the extra-env map as `KEY=VALUE` lines for the textarea. */
const envToText = (env?: Record<string, string>) =>
  Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n')

function textToEnv(text: string): Record<string, string> | undefined {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
  }
  return Object.keys(env).length ? env : undefined
}

export function ClientsSection() {
  const [agents, setAgents] = useState<AgentsFile | null>(null)
  const [credentials, setCredentials] = useState<CredentialEntry[]>([])
  const [open, setOpen] = useState<string | null>(null)
  /** Draft of the expanded card, editable without touching the saved file. */
  const [draft, setDraft] = useState<AgentInstance | null>(null)
  const [draftEnv, setDraftEnv] = useState('')
  const [draftConfig, setDraftConfig] = useState('')
  const [error, setError] = useState('')

  const load = () => {
    window.gurt.getAgents().then(setAgents).catch((e: unknown) => setError(String(e)))
    window.gurt.getCredentials().then((f) => setCredentials(f.credentials)).catch(() => {})
  }
  useEffect(load, [])

  const tokens = agentCredentials(credentials)
  const entries = Object.entries(agents ?? {})

  const expand = (id: string, inst: AgentInstance) => {
    setOpen(id)
    setDraft({ ...inst })
    setDraftEnv(envToText(inst.env))
    setDraftConfig(inst.config ? JSON.stringify(inst.config, null, 2) : '')
    setError('')
  }

  const collapse = () => {
    setOpen(null)
    setDraft(null)
    setError('')
    // Drop an unsaved new row when its card is dismissed.
    setAgents((prev) => {
      if (!prev) return prev
      const next = { ...prev }
      for (const id of Object.keys(next)) if (isTemp(id)) delete next[id]
      return next
    })
  }

  const add = () => {
    const key = `__new__:${crypto.randomUUID()}`
    const inst: AgentInstance = { kind: DEFAULT_AGENT_KIND, label: '' }
    setAgents((prev) => ({ ...(prev ?? {}), [key]: inst }))
    expand(key, inst)
  }

  const persist = async (next: AgentsFile) => {
    await window.gurt.setAgents(next)
    refreshAgents()
    setAgents(next)
  }

  const save = async () => {
    if (!agents || !open || !draft) return
    if (!draft.label.trim()) {
      setError('label must not be empty')
      return
    }
    const env = textToEnv(draftEnv)
    const inst: AgentInstance = { ...draft, ...(env ? { env } : {}) }
    if (!env) delete inst.env
    try {
      if (clientConfigPath(inst.kind) && (draftConfig.trim() || draft.config !== undefined)) {
        inst.config = parseClientConfig(draftConfig)
      } else {
        delete inst.config
      }
    } catch (e) {
      setError(`Invalid config: ${String(e)}`)
      return
    }
    const out: AgentsFile = {}
    const taken = new Set(Object.keys(agents).filter((id) => !isTemp(id) && id !== open))
    for (const [id, a] of Object.entries(agents)) {
      if (id === open) {
        const finalId = isTemp(id) ? uniqueId(inst.label, inst.kind, taken) : id
        out[finalId] = inst
      } else if (!isTemp(id)) {
        out[id] = a
      }
    }
    try {
      await persist(out)
      setOpen(null)
      setDraft(null)
    } catch (e) {
      setError(String(e))
    }
  }

  const remove = async (id: string, label: string) => {
    if (
      !(await confirmDialog(`Delete client "${label || id}"?`, {
        title: 'Delete client',
        confirmText: 'Delete',
        danger: true
      }))
    )
      return
    if (isTemp(id)) {
      collapse()
      return
    }
    const next = { ...(agents ?? {}) }
    delete next[id]
    try {
      await persist(next)
      if (open === id) collapse()
    } catch (e) {
      setError(String(e))
    }
  }

  const count = entries.filter(([id]) => !isTemp(id)).length

  return (
    <>
      <div className="set-head">
        <div className="set-title-wrap">
          <span className="set-title">Clients</span>
          <span className="set-count mono">{count} configured</span>
        </div>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={add}>
          + New client
        </button>
      </div>
      <div className="set-list">
        {entries.map(([id, cfg]) => {
          const kindLabel = agentDef(cfg.kind)?.label ?? cfg.kind
          // The draft kind's placeholders, else the default kind's.
          const hints = (draft && agentDef(draft.kind)?.instanceHints) ?? agentDef(DEFAULT_AGENT_KIND)?.instanceHints
          const example = draft && agentDef(draft.kind)?.clientConfig?.example
          if (open !== id)
            return (
              <div key={id} className="set-row clickable" onClick={() => expand(id, cfg)}>
                <span className="set-row-label">{cfg.label || 'unnamed'}</span>
                <AgentTag kind={cfg.kind} name={kindLabel} />
                <span className="spacer" />
                <Icon name="chevron" size={12} className="faint" style={{ transform: 'rotate(-90deg)' }} />
              </div>
            )
          return (
            <div key={id} className="set-card">
              <div className="set-card-head" onClick={collapse}>
                <span className="set-row-label">{draft?.label || cfg.label || 'new client'}</span>
                <AgentTag
                  kind={draft?.kind ?? cfg.kind}
                  name={agentDef(draft?.kind ?? cfg.kind)?.label ?? cfg.kind}
                />
                <span className="spacer" />
                <button
                  className="btn-danger-text sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    void remove(id, cfg.label)
                  }}
                >
                  delete
                </button>
                <Icon name="chevron" size={12} className="faint" />
              </div>
              {draft && (
                <div className="set-card-body">
                  <label className="fld narrow">
                    <span className="seclabel">LABEL</span>
                    <input
                      className="input"
                      autoFocus={isTemp(id)}
                      placeholder={hints?.label}
                      value={draft.label}
                      onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                    />
                  </label>
                  <ProviderCombo
                    value={draft.kind}
                    onPick={(kind) => {
                      if (kind === draft.kind) return
                      const next = { ...draft, kind }
                      delete next.config
                      setDraft(next)
                      setDraftConfig('')
                    }}
                  />
                  <div className="fld narrow">
                    <div className="fld-head">
                      <span className="seclabel">CREDENTIAL</span>
                      <span className="fld-hint">— which secret this client authenticates with</span>
                    </div>
                    <CredentialPick
                      tokens={tokens}
                      value={draft.credentialId}
                      onPick={(credentialId) => setDraft({ ...draft, credentialId })}
                    />
                    {tokens.length === 0 && (
                      <div className="fld-hint">no agent tokens yet — add one in Credentials</div>
                    )}
                  </div>
                  <label className="fld narrow">
                    <span className="seclabel">SECRET ENV VAR</span>
                    <input
                      className="input mono"
                      value={draft.secretEnv ?? agentDef(draft.kind)?.secretEnv ?? ''}
                      placeholder={agentDef(draft.kind)?.secretEnv}
                      onChange={(e) => setDraft({ ...draft, secretEnv: e.target.value })}
                    />
                  </label>
                  <label className="fld narrow">
                    <span className="seclabel">EXTRA ENV</span>
                    <textarea
                      className="input mono"
                      rows={2}
                      placeholder={hints?.env}
                      value={draftEnv}
                      onChange={(e) => setDraftEnv(e.target.value)}
                    />
                  </label>
                  {clientConfigPath(draft.kind) && (
                    <div className="fld">
                      <label className="seclabel" htmlFor="client-config-json">CONFIG JSON</label>
                      <textarea
                        id="client-config-json"
                        className="input mono"
                        rows={10}
                        spellCheck={false}
                        placeholder="{}"
                        value={draftConfig}
                        onChange={(e) => setDraftConfig(e.target.value)}
                      />
                      <div className="fld-hint">
                        Native client settings. Applied on the next session start or restart.
                        Clear to reset. Keep API keys in Credentials.
                        {example?.secretEnv && ` For ${example.label}, set Secret env var to ${example.secretEnv}.`}
                      </div>
                      {!draftConfig.trim() && example && (
                        <button className="btn" type="button" onClick={() => {
                          setDraftConfig(JSON.stringify(clientConfigExample(draft.kind), null, 2))
                          if (example.secretEnv) setDraft({ ...draft, secretEnv: example.secretEnv })
                        }}>
                          {`Example: ${example.label}`}
                        </button>
                      )}
                    </div>
                  )}
                  {error && <div className="error">{error}</div>}
                  <div className="set-card-foot">
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
        {count === 0 && open === null && (
          <div className="tp-dashed">no clients yet — add one and link its token</div>
        )}
      </div>
      <PlanLimitSettings />
    </>
  )
}

/** The plan-limit threshold — one for every client, applied per account. */
function PlanLimitSettings(): JSX.Element {
  const [settings, setSettings] = useState<LimitSettings | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    window.gurt.getLimitSettings().then(setSettings).catch((e: unknown) => setError(String(e)))
  }, [])
  const save = async (next: LimitSettings) => {
    const prior = settings
    setSettings(next)
    setError('')
    try {
      await window.gurt.setLimitSettings(next)
    } catch (e) {
      setSettings(prior)
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <div className="set-list">
      <div className="set-row">
        <span className="set-row-label">
          Hold new work at
          <div className="fld-hint">
            once any plan window of an account is this full, nothing new starts on it — queued
            sessions and queued messages wait for the reset, and a session the limit cut off
            sends “continue” on its own afterwards. Extra usage / credits lift the hold.
          </div>
        </span>
        <span className="spacer" />
        <input
          className="input"
          type="number"
          style={{ width: 80 }}
          min={LIMIT_THRESHOLD_MIN}
          max={LIMIT_THRESHOLD_MAX}
          disabled={!settings}
          value={settings?.thresholdPercent ?? ''}
          onChange={(e) => {
            const n = Number(e.target.value)
            if (Number.isFinite(n) && n >= LIMIT_THRESHOLD_MIN && n <= LIMIT_THRESHOLD_MAX)
              void save({ thresholdPercent: n })
          }}
        />
        <span className="faint">% used</span>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  )
}

/** Provider combobox with search (#4c): field row → filterable menu of the
 *  registry's agent kinds, each with its vendor. */
function ProviderCombo({ value, onPick }: { value: string; onPick: (kind: string) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(open, ref, () => setOpen(false))

  const cur = agentDef(value)
  const q = query.trim().toLowerCase()
  const filtered = AGENT_MANIFESTS.filter(
    (d) => !q || d.label.toLowerCase().includes(q) || d.vendor.toLowerCase().includes(q)
  )

  return (
    <div className="fld narrow">
      <span className="seclabel">PROVIDER</span>
      <div className="pick-wrap" ref={ref}>
        <button
          type="button"
          className={`pick-row provider-row ${open ? 'focus' : ''}`}
          onClick={() => {
            setOpen((o) => !o)
            setQuery('')
          }}
        >
          <AgentIcon kind={value} size={13} className="faint" style={{ flex: 'none' }} />
          <span className="pick-value">{cur?.label ?? value}</span>
          <span className="spacer" />
          <Icon name="chevron" size={12} className="faint" style={{ flex: 'none' }} />
        </button>
        {open && (
          <div className="menu pick-menu combo-menu">
            <div className="combo-search">
              <Icon name="search" size={12} className="faint" />
              <input
                autoFocus
                className="cmp-input"
                placeholder="Search providers…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  const first = filtered[0]
                  if (e.key === 'Enter' && first) {
                    onPick(first.id)
                    setOpen(false)
                  }
                }}
              />
            </div>
            {filtered.map((d) => (
              <div
                key={d.id}
                className={`menu-item ${d.id === value ? 'active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  onPick(d.id)
                  setOpen(false)
                }}
              >
                <AgentIcon kind={d.id} size={13} className="faint" />
                <span className={d.id === value ? 'strong' : undefined}>{d.label}</span>
                <span className="menu-meta mono">{d.vendor}</span>
              </div>
            ))}
            {filtered.length === 0 && <div className="menu-empty">no matching providers</div>}
          </div>
        )}
      </div>
    </div>
  )
}
