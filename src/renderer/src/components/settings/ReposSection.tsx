import { useEffect, useRef, useState } from 'react'
import type { PublishResult, RepoConfig, Tree } from '../../../../shared/types'
import type { CredentialEntry } from '../../../../shared/credentials'
import { credentialKindLabel, isGitKind, resolveForRepo } from '../../../../shared/credentials'
import { canonicalRepoId } from '../../../../shared/repoId'
import { useOutsideClose } from '../../hooks'
import { confirmDialog } from '../../dialog'
import { Icon } from '../icons'
import { Modal } from '../Modal'
import { run } from '../../async'
import { stripProtocol } from './shared'

// ---- Repos — the workspace's repo identities (url + credential) ----

export function ReposSection({ tree, ws }: { tree: Tree | null; ws: string | null }) {
  const [editing, setEditing] = useState<RepoConfig | null>(null)
  const [adding, setAdding] = useState(false)
  const repos = tree?.workspaces.find((w) => w.name === ws)?.repos ?? []

  return (
    <>
      <div className="set-head">
        <div className="set-title-wrap">
          <span className="set-title">Repos</span>
          <span className="set-count mono">
            {repos.length} repo{repos.length === 1 ? '' : 's'}
            {ws ? ` · ${ws}` : ''}
          </span>
        </div>
        <span className="spacer" />
        <button className="btn btn-primary" disabled={!ws} onClick={() => setAdding(true)}>
          + New repo
        </button>
      </div>
      <div className="set-list">
        {repos.map((r) => (
          <div key={r.name} className="set-row">
            <span className="set-row-label">{r.name}</span>
            <span className="set-row-url mono">
              {r.local ? 'local · not published' : stripProtocol(r.url)}
            </span>
            <button className="btn-link" onClick={() => setEditing(r)}>
              edit
            </button>
          </div>
        ))}
        {repos.length === 0 && (
          <div className="tp-dashed">no repos yet — add one to clone in a session</div>
        )}
      </div>
      {(editing || adding) && ws && (
        <RepoModal
          key={editing?.name ?? '__new'}
          ws={ws}
          initial={editing ?? undefined}
          onClose={() => {
            setEditing(null)
            setAdding(false)
          }}
        />
      )}
    </>
  )
}

function RepoModal({
  ws,
  initial,
  onClose
}: {
  ws: string
  initial?: RepoConfig | undefined
  onClose: () => void
}) {
  const editing = !!initial
  // A new repo is either registered by URL or created by gurt as a local one
  // (docs/requirements-new-projects.md §2); an existing local repo has no url
  // to edit, only a publish to offer.
  const [local, setLocal] = useState(!!initial?.local)
  const [publishing, setPublishing] = useState(false)
  const [name, setName] = useState(initial?.name ?? '')
  const [url, setUrl] = useState(initial?.url ?? '')
  const [credentialId, setCredentialId] = useState(initial?.credentialId ?? '')
  const [credentials, setCredentials] = useState<CredentialEntry[]>([])
  const [credMenu, setCredMenu] = useState(false)
  const [error, setError] = useState('')
  const credRef = useRef<HTMLDivElement>(null)
  useOutsideClose(credMenu, credRef, () => setCredMenu(false))

  useEffect(() => {
    window.gurt.getCredentials().then((f) => setCredentials(f.credentials)).catch(() => {})
  }, [])

  const valid = name.trim() && (local || url.trim())
  const draft: RepoConfig = {
    name: name.trim(),
    url: url.trim(),
    ...(credentialId ? { credentialId } : {})
  }

  const linked = credentials.find((c) => c.id === credentialId)
  const resolution = url.trim() ? resolveForRepo(credentials, draft) : null
  const host = url.trim() ? canonicalRepoId(url.trim())?.host : undefined
  const accessNote = !url.trim()
    ? null
    : !host
      ? 'cannot parse a host from the url'
      : resolution?.error
        ? `⚠ ${resolution.error}`
        : linked
          ? null
          : resolution?.entry
            ? `auto → ${resolution.entry.label} · ${credentialKindLabel(resolution.entry.kind)} (${host})`
            : `host credentials (ambient) — ${host}`

  const save = async () => {
    setError('')
    try {
      if (local && !editing) await window.gurt.createLocalRepo(ws, draft.name)
      else await (editing ? window.gurt.updateRepo(ws, draft) : window.gurt.addRepo(ws, draft))
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const del = async () => {
    // A local repo's storage goes with it (store.removeRepo) — and it is the
    // only copy of whatever was merged into it, so the prompt says so.
    const message = initial!.local
      ? `Delete repo "${initial!.name}"? It is local and unpublished — its history, kept only by gurt on this machine, is deleted with it.`
      : `Delete repo "${initial!.name}"?`
    if (!(await confirmDialog(message, { title: 'Delete repo', confirmText: 'Delete', danger: true })))
      return
    try {
      await window.gurt.removeRepo(ws, initial!.name)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal title={editing ? 'Edit repo' : 'New repo'} width={500} onClose={onClose}>
      <div className="modal-body env-modal">
        {!editing && (
          <div className="fld">
            <span className="seclabel">SOURCE</span>
            <div className="seg">
              <button
                className={`seg-btn ${!local ? 'active' : ''}`}
                title="a repository that already exists on a forge or git server"
                onClick={() => setLocal(false)}
              >
                existing, by URL
              </button>
              <button
                className={`seg-btn ${local ? 'active' : ''}`}
                title="a new, empty repository kept by gurt on this machine — publish it to a forge later"
                onClick={() => setLocal(true)}
              >
                new, local
              </button>
            </div>
          </div>
        )}
        <label className="fld">
          <span className="seclabel">NAME</span>
          <input
            className="input"
            autoFocus={!editing}
            placeholder="checkout-web"
            value={name}
            disabled={editing}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        {local ? (
          <div className="fld">
            <span className="seclabel">STORAGE</span>
            <div className="env-access-note">
              {editing
                ? 'kept by gurt on this machine, not on any forge yet — tasks clone it and "Merge into main" lands their work in it'
                : 'an empty repository with one initial commit, kept by gurt on this machine — no forge or credential needed'}
            </div>
            {editing && (
              <div className="changes-actions">
                <button className="btn btn-sm" onClick={() => setPublishing(true)}>
                  Publish to GitHub…
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="fld">
            <span className="seclabel">REPOSITORY URL</span>
            <input
              className="input mono"
              placeholder="https://github.com/acme/checkout-web"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <div className="env-access">
              <span className="seclabel">REPO ACCESS</span>
              <div className="env-access-chips" ref={credRef}>
                {linked ? (
                  <span className="chip-tag">
                    <Icon name="key" size={11} style={{ color: 'var(--yellow)' }} />
                    {linked.label}
                    <span className="chip-x" title="unlink" onClick={() => setCredentialId('')}>
                      ×
                    </span>
                  </span>
                ) : (
                  <span className="chip-dashed clickable" onClick={() => setCredMenu((o) => !o)}>
                    + credential
                  </span>
                )}
                {credMenu && (
                  <div className="menu pick-menu">
                    <div
                      className="menu-item"
                      onMouseDown={(e) => {
                        e.preventDefault()
                        setCredentialId('')
                        setCredMenu(false)
                      }}
                    >
                      auto (match by host)
                    </div>
                    {credentials.filter((c) => isGitKind(c.kind)).map((c) => (
                      <div
                        key={c.id}
                        className="menu-item"
                        onMouseDown={(e) => {
                          e.preventDefault()
                          setCredentialId(c.id)
                          setCredMenu(false)
                        }}
                      >
                        <Icon name="key" size={11} className="faint" />
                        {c.label} · {credentialKindLabel(c.kind)}
                      </div>
                    ))}
                  </div>
                )}
                {accessNote && <span className="env-access-note mono">{accessNote}</span>}
              </div>
            </div>
          </div>
        )}

        {error && <div className="error">{error}</div>}
      </div>
      <div className="modal-foot">
        {editing && (
          <button className="btn btn-danger-text" onClick={run(del)}>
            Delete
          </button>
        )}
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!valid} onClick={run(save)}>
          Save
        </button>
      </div>
      {publishing && initial && (
        <PublishRepoModal
          ws={ws}
          repo={initial}
          onClose={() => setPublishing(false)}
          onPublished={onClose}
        />
      )}
    </Modal>
  )
}

/**
 * Publish a local repo (docs/requirements-new-projects.md §6): one form that
 * creates the GitHub repository, pushes the history there, re-points every
 * clone.
 */
function PublishRepoModal({
  ws,
  repo,
  onClose,
  onPublished
}: {
  ws: string
  repo: RepoConfig
  onClose: () => void
  onPublished: () => void
}) {
  const [credentials, setCredentials] = useState<CredentialEntry[]>([])
  const [credentialId, setCredentialId] = useState('')
  const [remoteName, setRemoteName] = useState(repo.name)
  const [owner, setOwner] = useState('')
  const [priv, setPriv] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<PublishResult | null>(null)

  // Only a token can create a repository through the forge API, and only on a
  // forge gurt has a provider for — GitHub today.
  const usable = credentials.filter(
    (c) => c.kind === 'git-token' && c.hosts.some((h) => h.includes('github'))
  )
  useEffect(() => {
    window.gurt
      .getCredentials()
      .then((f) => {
        setCredentials(f.credentials)
        const first = f.credentials.find(
          (c) => c.kind === 'git-token' && c.hosts.some((h) => h.includes('github'))
        )
        if (first) setCredentialId((id) => id || first.id)
      })
      .catch(() => {})
  }, [])

  const publish = async () => {
    setError('')
    setBusy(true)
    try {
      setResult(
        await window.gurt.publishRepo(ws, repo.name, {
          credentialId,
          remoteName,
          owner,
          private: priv
        })
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (result)
    return (
      <Modal title="Published" width={500} onClose={onPublished}>
        <div className="modal-body env-modal">
          <div className="fld">
            <span className="seclabel">REPOSITORY</span>
            <span className="mono">{result.webUrl}</span>
          </div>
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button className="btn btn-primary" onClick={onPublished}>
            Done
          </button>
        </div>
      </Modal>
    )

  return (
    <Modal title={`Publish "${repo.name}"`} width={500} onClose={busy ? () => {} : onClose}>
      <div className="modal-body env-modal">
        <div className="fld">
          <span className="seclabel">GITHUB CREDENTIAL</span>
          {usable.length ? (
            <div className="seg">
              {usable.map((c) => (
                <button
                  key={c.id}
                  className={`seg-btn ${credentialId === c.id ? 'active' : ''}`}
                  onClick={() => setCredentialId(c.id)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          ) : (
            <div className="env-access-note">
              no GitHub token yet — add a git-token credential for github.com (🔑 in the sidebar)
            </div>
          )}
        </div>
        <label className="fld">
          <span className="seclabel">NAME ON GITHUB</span>
          <input className="input" value={remoteName} onChange={(e) => setRemoteName(e.target.value)} />
        </label>
        <label className="fld">
          <span className="seclabel">ORGANIZATION</span>
          <input
            className="input"
            placeholder="empty = the token's own account"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
          />
        </label>
        <div className="fld">
          <span className="seclabel">VISIBILITY</span>
          <div className="seg">
            <button className={`seg-btn ${priv ? 'active' : ''}`} onClick={() => setPriv(true)}>
              private
            </button>
            <button className={`seg-btn ${!priv ? 'active' : ''}`} onClick={() => setPriv(false)}>
              public
            </button>
          </div>
        </div>
        <div className="env-access-note">
          Every branch is pushed, every task&apos;s clone follows the new origin, and gurt&apos;s local
          copy is removed. Uncommitted work in the clones is untouched.
        </div>
        {error && <div className="error">{error}</div>}
      </div>
      <div className="modal-foot">
        <span className="spacer" />
        <button className="btn" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          disabled={busy || !credentialId || !remoteName.trim()}
          onClick={run(publish)}
        >
          {busy ? 'Publishing…' : 'Publish'}
        </button>
      </div>
    </Modal>
  )
}
