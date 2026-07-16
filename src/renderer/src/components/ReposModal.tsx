import { useEffect, useState } from 'react'
import type { RepoConfig, Tree } from '../../../shared/types'
import type { CredentialEntry } from '../../../shared/credentials'
import { credentialKindLabel, resolveForRepo } from '../../../shared/credentials'
import { canonicalRepoId } from '../../../shared/repoId'
import { Modal } from './Modal'

/** Human summary of which credential answers for `repo`, on its own host (§9). */
function describeResolution(credentials: CredentialEntry[], repo: RepoConfig): string {
  const host = canonicalRepoId(repo.url)?.host
  if (!host) return 'cannot parse a host from the url'
  const r = resolveForRepo(credentials, repo)
  if (!r) return 'cannot parse a host from the url'
  if (r.error) return `⚠ ${r.error}`
  if (!r.entry) return `host credentials (ambient) — ${host}`
  const via = r.source === 'link' ? 'linked' : 'auto →'
  return `${via} ${r.entry.label} · ${credentialKindLabel(r.entry.kind)} (${host})`
}

export function ReposModal({ tree, ws, onClose }: { tree: Tree; ws: string; onClose: () => void }) {
  const [editing, setEditing] = useState<RepoConfig | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const [credentials, setCredentials] = useState<CredentialEntry[]>([])

  useEffect(() => {
    window.gurt.getCredentials().then((f) => setCredentials(f.credentials)).catch(() => {})
  }, [])

  const repos = tree.workspaces.find((w) => w.name === ws)?.repos ?? []

  const act = async (fn: () => Promise<unknown>) => {
    setError('')
    try {
      await fn()
      setEditing(null)
      setAdding(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal title={`Repos — ${ws}`} onClose={onClose}>
      <div className="form">
        {repos.map((r) => (
          <div key={r.name} className="repo-row">
            <span className="node-label">{r.name}</span>
            <span className="dim repo-url">{r.url}</span>
            <span className="spacer" />
            <button className="icon-btn" title="edit repo" onClick={() => { setEditing(r); setAdding(false) }}>✎</button>
            <button
              className="icon-btn"
              title="delete repo"
              onClick={() => act(() => window.gurt.removeRepo(ws, r.name))}
            >
              🗑
            </button>
          </div>
        ))}
        {repos.length === 0 && <div className="hint">no repos yet</div>}
        {!editing && !adding && <button onClick={() => setAdding(true)}>Add repo</button>}
        {(editing || adding) && (
          <RepoForm
            key={editing?.name ?? '__new'}
            initial={editing ?? undefined}
            credentials={credentials}
            onCancel={() => { setEditing(null); setAdding(false) }}
            onSubmit={(repo) =>
              act(() => (editing ? window.gurt.updateRepo(ws, repo) : window.gurt.addRepo(ws, repo)))
            }
          />
        )}
        {error && <div className="error">{error}</div>}
      </div>
    </Modal>
  )
}

function RepoForm({
  initial,
  credentials,
  onCancel,
  onSubmit
}: {
  initial?: RepoConfig
  credentials: CredentialEntry[]
  onCancel: () => void
  onSubmit: (repo: RepoConfig) => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [url, setUrl] = useState(initial?.url ?? '')
  const [devcontainer, setDevcontainer] = useState(initial?.devcontainer ?? '')
  const [credentialId, setCredentialId] = useState(initial?.credentialId ?? '')
  const [discovering, setDiscovering] = useState(false)
  const [discoverMsg, setDiscoverMsg] = useState('')
  const valid = name.trim() && url.trim()

  const draft: RepoConfig = {
    name: name.trim(),
    url: url.trim(),
    devcontainer,
    credentialId: credentialId || undefined
  }

  const discover = async () => {
    setDiscoverMsg('')
    setDiscovering(true)
    try {
      const found = await window.gurt.discoverDevcontainer(url.trim())
      if (found) {
        setDevcontainer(found.content)
        setDiscoverMsg(`loaded ${found.path}`)
      } else {
        setDiscoverMsg('no devcontainer.json found in repo')
      }
    } catch (e) {
      setDiscoverMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setDiscovering(false)
    }
  }

  return (
    <div className="form repo-form">
      <input
        autoFocus
        placeholder="name"
        value={name}
        disabled={!!initial}
        onChange={(e) => setName(e.target.value)}
      />
      <input placeholder="git url (https or ssh)" value={url} onChange={(e) => setUrl(e.target.value)} />
      <label>
        credential
        <select value={credentialId} onChange={(e) => setCredentialId(e.target.value)}>
          <option value="">auto (match by host)</option>
          {credentials.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label} · {credentialKindLabel(c.kind)}
            </option>
          ))}
        </select>
        {url.trim() && <span className="dim">{describeResolution(credentials, draft)}</span>}
      </label>
      <label>
        devcontainer.json (optional — leave empty to use the repo’s own; build paths must be
        ${'{localWorkspaceFolder}'}-based)
        <div className="row-buttons">
          <button type="button" disabled={!url.trim() || discovering} onClick={discover}>
            {discovering ? 'detecting…' : 'Auto-detect from repo'}
          </button>
          {discoverMsg && <span className="dim">{discoverMsg}</span>}
        </div>
        <textarea
          rows={8}
          placeholder='{ "image": "mcr.microsoft.com/devcontainers/base:ubuntu" }'
          value={devcontainer}
          onChange={(e) => setDevcontainer(e.target.value)}
        />
      </label>
      <div className="row-buttons">
        <button disabled={!valid} onClick={() => onSubmit(draft)}>
          {initial ? 'Save' : 'Add'}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
