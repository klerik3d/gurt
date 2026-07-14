import { useState } from 'react'
import type { RepoConfig, Tree } from '../../../shared/types'
import { Modal } from './Modal'

export function ReposModal({ tree, ws, onClose }: { tree: Tree; ws: string; onClose: () => void }) {
  const [editing, setEditing] = useState<RepoConfig | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')

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
  onCancel,
  onSubmit
}: {
  initial?: RepoConfig
  onCancel: () => void
  onSubmit: (repo: RepoConfig) => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [url, setUrl] = useState(initial?.url ?? '')
  const [devcontainer, setDevcontainer] = useState(initial?.devcontainer ?? '')
  const valid = name.trim() && url.trim()
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
        devcontainer.json (optional — leave empty to use the repo’s own; build paths must be
        ${'{localWorkspaceFolder}'}-based)
        <textarea
          rows={8}
          placeholder='{ "image": "mcr.microsoft.com/devcontainers/base:ubuntu" }'
          value={devcontainer}
          onChange={(e) => setDevcontainer(e.target.value)}
        />
      </label>
      <div className="row-buttons">
        <button disabled={!valid} onClick={() => onSubmit({ name: name.trim(), url: url.trim(), devcontainer })}>
          {initial ? 'Save' : 'Add'}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
