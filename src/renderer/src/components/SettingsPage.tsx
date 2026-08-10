import { useEffect, useRef, useState } from 'react'
import type { AgentInstance, AgentsFile, EnvConfig, RepoConfig, Tree } from '../../../shared/types'
import type { EnvImageStatus } from '../../../shared/api'
import { parseEnvDevcontainer, validateEnvConfig } from '../../../shared/envConfig'
import type { CredentialEntry, CredentialKind } from '../../../shared/credentials'
import {
  CREDENTIAL_KINDS,
  agentCredentials,
  credentialKindLabel,
  isGitKind,
  resolveForRepo
} from '../../../shared/credentials'
import { canonicalRepoId } from '../../../shared/repoId'
import type { NotificationPrefs, NotificationType } from '../../../shared/notifications'
import { AGENT_DEFS, agentDef } from '../../../shared/agents'
import { refreshAgents } from '../useAgents'
import { useOutsideClose } from '../hooks'
import { alertDialog, confirmDialog } from '../dialog'
import { Icon, Dot } from './icons'
import { AgentTag, agentIcon } from './tags'
import { Modal } from './Modal'

export type SettingsSection =
  | 'general'
  | 'environments'
  | 'repos'
  | 'clients'
  | 'credentials'
  | 'notifications'

/** Vendor tag shown beside each provider in the combobox (#4c). */
const PROVIDER_VENDOR: Record<string, string> = {
  'claude-code': 'Anthropic',
  codex: 'OpenAI',
  opencode: 'local'
}

export function SettingsPage({
  tree,
  ws,
  section,
  onSection
}: {
  tree: Tree | null
  ws: string | null
  section: SettingsSection
  onSection: (s: SettingsSection) => void
}) {
  return (
    <div className="settings">
      <div className="set-nav">
        <div className="set-nav-head">Settings</div>
        <div className="set-nav-list">
          <div className="set-nav-item disabled" title="coming later">
            General
          </div>
          <div className="set-nav-sep" />
          {(['environments', 'repos', 'clients', 'credentials', 'notifications'] as const).map((s) => (
            <div
              key={s}
              className={`set-nav-item ${section === s ? 'active' : ''}`}
              onClick={() => onSection(s)}
            >
              {s[0].toUpperCase() + s.slice(1)}
            </div>
          ))}
        </div>
      </div>
      <div className="set-content">
        {section === 'environments' && <EnvironmentsSection tree={tree} ws={ws} />}
        {section === 'repos' && <ReposSection tree={tree} ws={ws} />}
        {section === 'clients' && <ClientsSection />}
        {section === 'credentials' && <CredentialsSection />}
        {section === 'notifications' && <NotificationsSection />}
        {section === 'general' && <div className="placeholder">general settings — coming soon</div>}
      </div>
    </div>
  )
}

/** `https://github.com/acme/x.git` → `github.com/acme/x`. */
function stripProtocol(url: string): string {
  return url.replace(/^[a-z+]+:\/\//, '').replace(/^git@/, '').replace(/\.git$/, '')
}

// ---- Environments (#4a) — the workspace's env definitions ----

function EnvironmentsSection({ tree, ws }: { tree: Tree | null; ws: string | null }) {
  const [editing, setEditing] = useState<EnvConfig | null>(null)
  const [adding, setAdding] = useState(false)
  const [statuses, setStatuses] = useState<Record<string, EnvImageStatus>>({})
  const [building, setBuilding] = useState<Set<string>>(new Set())
  const [buildLogs, setBuildLogs] = useState<Record<string, string[]>>({})
  const [buildErrors, setBuildErrors] = useState<Record<string, string>>({})
  const wsData = tree?.workspaces.find((w) => w.name === ws)
  const envs = wsData?.envs ?? []
  const repos = wsData?.repos ?? []

  const loadStatus = (env: string) => {
    if (!ws) return
    window.gurt
      .envImageStatus(ws, env)
      .then((s) => setStatuses((prev) => ({ ...prev, [env]: s })))
      .catch(() => {})
  }

  // Badges load lazily when the section opens; refreshed per-env after a build.
  const envNames = envs.map((e) => e.name).join('\n')
  useEffect(() => {
    for (const name of envNames ? envNames.split('\n') : []) loadStatus(name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, envNames])

  // Build-log tail: main streams `provision.log` with key `env-build:<ws>/<env>`.
  useEffect(() => {
    if (!ws) return
    const prefix = `env-build:${ws}/`
    return window.gurt.onProvisionLog(({ key, line }) => {
      if (!key.startsWith(prefix)) return
      const env = key.slice(prefix.length)
      setBuildLogs((prev) => ({ ...prev, [env]: [...(prev[env] ?? []).slice(-20), line] }))
    })
  }, [ws])

  const build = async (env: string) => {
    if (!ws) return
    setBuilding((prev) => new Set(prev).add(env))
    setBuildLogs((prev) => ({ ...prev, [env]: [] }))
    setBuildErrors((prev) => ({ ...prev, [env]: '' }))
    try {
      await window.gurt.envBuildImage(ws, env)
      setBuildLogs((prev) => ({ ...prev, [env]: [] }))
    } catch (e) {
      setBuildErrors((prev) => ({
        ...prev,
        [env]: e instanceof Error ? e.message : String(e)
      }))
    } finally {
      setBuilding((prev) => {
        const next = new Set(prev)
        next.delete(env)
        return next
      })
      loadStatus(env)
    }
  }

  return (
    <>
      <div className="set-head">
        <div className="set-title-wrap">
          <span className="set-title">Environments</span>
          <span className="set-count mono">
            {envs.length} env{envs.length === 1 ? '' : 's'}
            {ws ? ` · ${ws}` : ''}
          </span>
        </div>
        <span className="spacer" />
        <button className="btn btn-primary" disabled={!ws} onClick={() => setAdding(true)}>
          + New environment
        </button>
      </div>
      <div className="set-list">
        {envs.map((e) => {
          const st = statuses[e.name]
          const isBuilding = building.has(e.name)
          const tail = buildLogs[e.name] ?? []
          const buildError = buildErrors[e.name]
          return (
            <div key={e.name}>
              <div className="set-row">
                <span className="set-row-label">{e.name}</span>
                <span className="set-row-url mono">
                  {e.repo ? e.repo : 'no default repo'}
                  {e.dockerfile
                    ? ` · Dockerfile${e.dockerfilePath ? `: ${e.dockerfilePath}` : ''}`
                    : ''}
                </span>
                {st?.state === 'exists' && (
                  <span className="tag tag-green">image ✓ {st.tag}</span>
                )}
                {st?.state === 'missing' && <span className="tag tag-red">image ✗ {st.tag}</span>}
                {st?.state === 'no-repo' && (
                  <span className="env-image-hint mono">no repo to build from</span>
                )}
                {st?.state === 'invalid' && (
                  <span className="env-image-hint mono">invalid config</span>
                )}
                {(st?.state === 'missing' || st?.state === 'exists') &&
                  (isBuilding ? (
                    <span className="env-building mono">building…</span>
                  ) : (
                    <button className="btn-link" onClick={() => void build(e.name)}>
                      build
                    </button>
                  ))}
                <button className="btn-link" onClick={() => setEditing(e)}>
                  edit
                </button>
              </div>
              {(isBuilding || buildError) && (tail.length > 0 || buildError) && (
                <div className="env-build-log mono">
                  {tail.slice(-5).map((l, i) => (
                    <div key={i}>{l}</div>
                  ))}
                  {buildError && <div className="error">{buildError}</div>}
                </div>
              )}
            </div>
          )
        })}
        {envs.length === 0 && (
          <div className="tp-dashed">no environments yet — add one to run sessions</div>
        )}
      </div>
      {(editing || adding) && ws && (
        <EnvModal
          key={editing?.name ?? '__new'}
          ws={ws}
          repos={repos}
          initial={editing ?? undefined}
          onClose={() => {
            setEditing(null)
            setAdding(false)
            // The config may have changed — recompute the badges.
            for (const e of envs) loadStatus(e.name)
          }}
        />
      )}
    </>
  )
}

// ---- Edit environment popup (#4b) — name, default repo, devcontainer ----

function EnvModal({
  ws,
  repos,
  initial,
  onClose
}: {
  ws: string
  repos: RepoConfig[]
  initial?: EnvConfig
  onClose: () => void
}) {
  const editing = !!initial
  const [name, setName] = useState(initial?.name ?? '')
  const [repo, setRepo] = useState<string | null>(initial?.repo ?? null)
  const [devcontainer, setDevcontainer] = useState(initial?.devcontainer ?? '')
  const [repoMenu, setRepoMenu] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [discoverMsg, setDiscoverMsg] = useState('')
  const [error, setError] = useState('')
  const repoRef = useRef<HTMLDivElement>(null)
  useOutsideClose(repoMenu, repoRef, () => setRepoMenu(false))

  const [dockerfile, setDockerfile] = useState(initial?.dockerfile ?? '')
  const [dockerfilePath, setDockerfilePath] = useState(initial?.dockerfilePath ?? '')
  const [dockerfileCandidates, setDockerfileCandidates] = useState<
    { path: string; content: string }[] | null
  >(null)
  const [dockerfileMenu, setDockerfileMenu] = useState(false)
  const [detectingDockerfiles, setDetectingDockerfiles] = useState(false)
  const [dockerfileMsg, setDockerfileMsg] = useState('')
  const dockerfileRef = useRef<HTMLDivElement>(null)
  useOutsideClose(dockerfileMenu, dockerfileRef, () => setDockerfileMenu(false))

  // The devcontainer is the single runtime description; the Dockerfile section
  // exists only while the (parseable) config carries a `build` section.
  const hasBuild = !!parseEnvDevcontainer(devcontainer).build
  const draft: EnvConfig = {
    name: name.trim(),
    devcontainer,
    dockerfile: hasBuild && dockerfile ? dockerfile : undefined,
    dockerfilePath: hasBuild && dockerfile ? dockerfilePath || undefined : undefined,
    repo: repo ?? undefined
  }
  const cfgError = validateEnvConfig(draft)
  const valid = !!name.trim() && cfgError === null
  const repoUrl = repo ? repos.find((r) => r.name === repo)?.url : undefined

  const discover = async () => {
    if (!repo) return
    setDiscoverMsg('')
    setDiscovering(true)
    try {
      const found = await window.gurt.discoverDevcontainer(ws, repo)
      if (found) {
        setDevcontainer(found.content)
        if (found.dockerfile) {
          setDockerfile(found.dockerfile.content)
          setDockerfilePath(found.dockerfile.path)
          setDiscoverMsg(`loaded ${found.path} + ${found.dockerfile.path}`)
        } else {
          setDiscoverMsg(`loaded ${found.path}`)
        }
      } else {
        setDiscoverMsg('no devcontainer.json found in repo')
      }
    } catch (e) {
      setDiscoverMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setDiscovering(false)
    }
  }

  const detectDockerfiles = async () => {
    if (!repo) return
    setDockerfileMsg('')
    setDetectingDockerfiles(true)
    try {
      const found = await window.gurt.discoverDockerfiles(ws, repo)
      setDockerfileCandidates(found)
      if (found.length === 0) setDockerfileMsg('no Dockerfile found in repo')
      else if (found.length === 1) {
        setDockerfilePath(found[0].path)
        setDockerfile(found[0].content)
        setDockerfileMsg(`loaded ${found[0].path}`)
      } else {
        setDockerfileMsg(`${found.length} candidates — pick one below`)
      }
    } catch (e) {
      setDockerfileMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setDetectingDockerfiles(false)
    }
  }

  const save = async () => {
    setError('')
    try {
      await (editing ? window.gurt.updateEnv(ws, draft) : window.gurt.addEnv(ws, draft))
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const del = async () => {
    if (
      !(await confirmDialog(`Delete environment "${initial!.name}"?`, {
        title: 'Delete environment',
        confirmText: 'Delete',
        danger: true
      }))
    )
      return
    try {
      await window.gurt.removeEnv(ws, initial!.name)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal title={editing ? 'Edit environment' : 'New environment'} width={500} onClose={onClose}>
      <div className="modal-body env-modal">
        <label className="fld">
          <span className="seclabel">NAME</span>
          <input
            className="input"
            autoFocus={!editing}
            placeholder="web-app"
            value={name}
            disabled={editing}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div className="fld">
          <span className="seclabel">DEFAULT REPOSITORY</span>
          <div className="pick-wrap" ref={repoRef}>
            <button type="button" className="pick-row" onClick={() => setRepoMenu((o) => !o)}>
              <span className={`pick-value ${repo ? '' : 'faint'}`}>
                {repo ?? 'no repository'}
              </span>
              {repoUrl && <span className="pick-meta mono">{stripProtocol(repoUrl)}</span>}
              <span className="spacer" />
              <Icon name="chevron" size={12} className="faint" style={{ flex: 'none' }} />
            </button>
            {repoMenu && (
              <div className="menu pick-menu">
                <div
                  className={`menu-item ${repo == null ? 'active' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    setRepo(null)
                    setRepoMenu(false)
                  }}
                >
                  no repository
                </div>
                {repos.map((r) => (
                  <div
                    key={r.name}
                    className={`menu-item ${r.name === repo ? 'active' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      setRepo(r.name)
                      setRepoMenu(false)
                    }}
                  >
                    <Icon name="branch" size={11} className="faint" />
                    {r.name}
                    <span className="menu-meta mono">{stripProtocol(r.url)}</span>
                  </div>
                ))}
                {repos.length === 0 && (
                  <div className="menu-empty">no repos — add one in Settings → Repos</div>
                )}
              </div>
            )}
          </div>
          <span className="fld-hint">seeds the repo of new sessions on this env; changeable per session</span>
        </div>

        <div className="fld">
          <div className="fld-head">
            <span className="seclabel">DEVCONTAINER</span>
            <span className="fld-hint mono">{devcontainer.trim() ? '' : 'required'}</span>
            <span className="spacer" />
            <button
              className="btn-link mono"
              disabled={!repoUrl || discovering}
              title={!repoUrl ? 'set a default repository first' : undefined}
              onClick={discover}
            >
              {discovering ? 'detecting…' : '⤢ detect from repo'}
            </button>
          </div>
          <JsonEditor value={devcontainer} onChange={setDevcontainer} />
          {discoverMsg && <div className="fld-hint mono">{discoverMsg}</div>}
        </div>

        {hasBuild && (
          <div className="fld">
            <div className="fld-head">
              <span className="seclabel">DOCKERFILE</span>
              <span className="fld-hint mono">
                {dockerfile
                  ? dockerfilePath
                    ? `from ${dockerfilePath}`
                    : 'custom'
                  : 'required by the build section'}
              </span>
              <span className="spacer" />
              <button
                className="btn-link mono"
                disabled={!repoUrl || detectingDockerfiles}
                title={!repoUrl ? 'set a default repository first' : undefined}
                onClick={detectDockerfiles}
              >
                {detectingDockerfiles ? 'detecting…' : '⤢ detect Dockerfiles in repo'}
              </button>
            </div>
            {dockerfileCandidates && dockerfileCandidates.length > 1 && (
              <div className="pick-wrap" ref={dockerfileRef}>
                <button
                  type="button"
                  className="pick-row"
                  onClick={() => setDockerfileMenu((o) => !o)}
                >
                  <span className={`pick-value mono ${dockerfilePath ? '' : 'faint'}`}>
                    {dockerfilePath || 'choose a Dockerfile'}
                  </span>
                  <span className="spacer" />
                  <Icon name="chevron" size={12} className="faint" style={{ flex: 'none' }} />
                </button>
                {dockerfileMenu && (
                  <div className="menu pick-menu">
                    {dockerfileCandidates.map((c) => (
                      <div
                        key={c.path}
                        className={`menu-item ${c.path === dockerfilePath ? 'active' : ''}`}
                        onMouseDown={(e) => {
                          e.preventDefault()
                          setDockerfilePath(c.path)
                          setDockerfile(c.content)
                          setDockerfileMsg(`loaded ${c.path}`)
                          setDockerfileMenu(false)
                        }}
                      >
                        {c.path}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <CodeEditor
              value={dockerfile}
              onChange={setDockerfile}
              placeholder={'FROM node:20\nWORKDIR /app\nCOPY . .\nRUN npm ci'}
            />
            {dockerfileMsg && <div className="fld-hint mono">{dockerfileMsg}</div>}
            <div className="fld-hint">
              gurt builds this Dockerfile in a temporary snapshot of the repo at HEAD (build
              context = repo root); the image is cached and reused until the Dockerfile, the
              build args, or the repo's committed content change.
            </div>
          </div>
        )}

        {cfgError && <div className="fld-hint mono">⚠ {cfgError}</div>}
        {error && <div className="error">{error}</div>}
      </div>
      <div className="modal-foot">
        {editing && (
          <button className="btn btn-danger-text" onClick={del}>
            Delete
          </button>
        )}
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!valid} onClick={save}>
          Save
        </button>
      </div>
    </Modal>
  )
}

// ---- Repos — the workspace's repo identities (url + credential) ----

function ReposSection({ tree, ws }: { tree: Tree | null; ws: string | null }) {
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
            <span className="set-row-url mono">{stripProtocol(r.url)}</span>
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
  initial?: RepoConfig
  onClose: () => void
}) {
  const editing = !!initial
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

  const valid = name.trim() && url.trim()
  const draft: RepoConfig = {
    name: name.trim(),
    url: url.trim(),
    credentialId: credentialId || undefined
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
      await (editing ? window.gurt.updateRepo(ws, draft) : window.gurt.addRepo(ws, draft))
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const del = async () => {
    if (
      !(await confirmDialog(`Delete repo "${initial!.name}"?`, {
        title: 'Delete repo',
        confirmText: 'Delete',
        danger: true
      }))
    )
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

        {error && <div className="error">{error}</div>}
      </div>
      <div className="modal-foot">
        {editing && (
          <button className="btn btn-danger-text" onClick={del}>
            Delete
          </button>
        )}
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!valid} onClick={save}>
          Save
        </button>
      </div>
    </Modal>
  )
}

/** Line-numbered code editor with an optional highlight overlay behind a
 *  transparent textarea — plain text when `highlight` is omitted. */
function CodeEditor({
  value,
  onChange,
  highlight,
  placeholder
}: {
  value: string
  onChange: (v: string) => void
  highlight?: (src: string) => JSX.Element[]
  placeholder?: string
}) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const hlRef = useRef<HTMLPreElement>(null)
  const gutRef = useRef<HTMLDivElement>(null)
  const lines = value ? value.split('\n').length : 1

  const sync = () => {
    const ta = taRef.current
    if (!ta) return
    if (hlRef.current) {
      hlRef.current.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`
    }
    if (gutRef.current) gutRef.current.style.transform = `translateY(${-ta.scrollTop}px)`
  }

  return (
    <div className="jsoned">
      <div className="jsoned-gutter">
        <div ref={gutRef} className="jsoned-gutter-inner mono">
          {Array.from({ length: lines }, (_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
      </div>
      <div className="jsoned-area">
        <pre ref={hlRef} className="jsoned-hl mono" aria-hidden>
          {highlight ? highlight(value) : value}
          {'\n'}
        </pre>
        <textarea
          ref={taRef}
          className="jsoned-input mono"
          spellCheck={false}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={sync}
        />
      </div>
    </div>
  )
}

/** JSON-flavored `CodeEditor` — devcontainer.json inline overrides. */
function JsonEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <CodeEditor
      value={value}
      onChange={onChange}
      highlight={highlightJson}
      placeholder='{ "image": "mcr.microsoft.com/devcontainers/base:ubuntu" }'
    />
  )
}

/** Tokenized JSON for the editor overlay: keys accent, strings teal, punctuation faint. */
function highlightJson(src: string): JSX.Element[] {
  const out: JSX.Element[] = []
  const re =
    /("(?:[^"\\]|\\.)*")(\s*:)|("(?:[^"\\]|\\.)*")|(\btrue\b|\bfalse\b|\bnull\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],:])/g
  let last = 0
  let k = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    if (m.index > last) out.push(<span key={k++}>{src.slice(last, m.index)}</span>)
    if (m[1] != null) {
      out.push(
        <span key={k++} className="j-key">
          {m[1]}
        </span>,
        <span key={k++} className="j-punc">
          {m[2]}
        </span>
      )
    } else if (m[3] != null)
      out.push(
        <span key={k++} className="j-str">
          {m[3]}
        </span>
      )
    else if (m[4] != null)
      out.push(
        <span key={k++} className="j-lit">
          {m[4]}
        </span>
      )
    else if (m[5] != null)
      out.push(
        <span key={k++} className="j-num">
          {m[5]}
        </span>
      )
    else
      out.push(
        <span key={k++} className="j-punc">
          {m[6]}
        </span>
      )
    last = re.lastIndex
  }
  if (last < src.length) out.push(<span key={k++}>{src.slice(last)}</span>)
  return out
}

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

function ClientsSection() {
  const [agents, setAgents] = useState<AgentsFile | null>(null)
  const [credentials, setCredentials] = useState<CredentialEntry[]>([])
  const [open, setOpen] = useState<string | null>(null)
  /** Draft of the expanded card, editable without touching the saved file. */
  const [draft, setDraft] = useState<AgentInstance | null>(null)
  const [draftEnv, setDraftEnv] = useState('')
  const [error, setError] = useState('')

  const load = () => {
    window.gurt.getAgents().then(setAgents).catch((e) => setError(String(e)))
    window.gurt.getCredentials().then((f) => setCredentials(f.credentials)).catch(() => {})
  }
  useEffect(load, [])

  const tokens = agentCredentials(credentials)
  const entries = Object.entries(agents ?? {})

  const expand = (id: string, inst: AgentInstance) => {
    setOpen(id)
    setDraft({ ...inst })
    setDraftEnv(envToText(inst.env))
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
    const inst: AgentInstance = { kind: 'claude-code', label: '' }
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
    const inst: AgentInstance = { ...draft, env: textToEnv(draftEnv) }
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
                      placeholder="claude · personal"
                      value={draft.label}
                      onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                    />
                  </label>
                  <ProviderCombo
                    value={draft.kind}
                    onPick={(kind) => setDraft({ ...draft, kind })}
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
                      placeholder="ANTHROPIC_BASE_URL=http://host.docker.internal:1234"
                      value={draftEnv}
                      onChange={(e) => setDraftEnv(e.target.value)}
                    />
                  </label>
                  {error && <div className="error">{error}</div>}
                  <div className="set-card-foot">
                    <span className="spacer" />
                    <button className="btn" onClick={collapse}>
                      Cancel
                    </button>
                    <button className="btn btn-primary" onClick={save}>
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
    </>
  )
}

/** Provider combobox with search (#4c): field row → filterable menu of AGENT_DEFS. */
function ProviderCombo({ value, onPick }: { value: string; onPick: (kind: string) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(open, ref, () => setOpen(false))

  const cur = agentDef(value)
  const q = query.trim().toLowerCase()
  const filtered = AGENT_DEFS.filter(
    (d) =>
      !q ||
      d.label.toLowerCase().includes(q) ||
      (PROVIDER_VENDOR[d.id] ?? '').toLowerCase().includes(q)
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
          <Icon name={agentIcon(value)} size={13} className="faint" style={{ flex: 'none' }} />
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
                  if (e.key === 'Enter' && filtered.length) {
                    onPick(filtered[0].id)
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
                <Icon name={agentIcon(d.id)} size={13} className="faint" />
                <span className={d.id === value ? 'strong' : undefined}>{d.label}</span>
                <span className="menu-meta mono">{PROVIDER_VENDOR[d.id] ?? ''}</span>
              </div>
            ))}
            {filtered.length === 0 && <div className="menu-empty">no matching providers</div>}
          </div>
        )}
      </div>
    </div>
  )
}

/** Agent-token picker for a client's CREDENTIAL field. */
function CredentialPick({
  tokens,
  value,
  onPick
}: {
  tokens: CredentialEntry[]
  value: string | undefined
  onPick: (id: string | undefined) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(open, ref, () => setOpen(false))
  const cur = tokens.find((t) => t.id === value)
  return (
    <div className="pick-wrap" ref={ref}>
      <button type="button" className="pick-row" onClick={() => setOpen((o) => !o)}>
        <span className={`pick-value mono ${cur ? '' : 'faint'}`}>
          {cur ? cur.label : 'none — adapter reports its own auth error'}
        </span>
        {cur && <span className="tag">oauth</span>}
        <span className="spacer" />
        <Icon name="chevron" size={12} className="faint" style={{ flex: 'none' }} />
      </button>
      {open && (
        <div className="menu pick-menu">
          <div
            className="menu-item"
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(undefined)
              setOpen(false)
            }}
          >
            none — adapter reports its own auth error
          </div>
          {tokens.map((t) => (
            <div
              key={t.id}
              className={`menu-item ${t.id === value ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                onPick(t.id)
                setOpen(false)
              }}
            >
              <Icon name="key" size={11} className="faint" />
              {t.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---- Notifications — per-type on/off matrix (§4.4) ----

const NOTIFICATION_COPY: Record<NotificationType, { label: string; hint: string }> = {
  awaiting: { label: 'Awaiting', hint: 'needs your input — a permission request is pending' },
  proposal: { label: 'Proposal', hint: 'changes are ready to review' },
  error: { label: 'Error', hint: 'a session or its container failed' },
  'turn-ended': { label: 'Turn ended', hint: 'turn finished, nothing to review' }
}

const NOTIFICATION_ORDER: NotificationType[] = ['awaiting', 'proposal', 'error', 'turn-ended']

function NotificationsSection() {
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    window.gurt.getNotificationPrefs().then(setPrefs).catch((e) => setError(String(e)))
  }, [])

  const toggle = async (type: NotificationType, key: 'inApp' | 'external') => {
    if (!prefs) return
    const prior = prefs
    const next: NotificationPrefs = { ...prefs, [type]: { ...prefs[type], [key]: !prefs[type][key] } }
    setPrefs(next)
    setError('')
    try {
      await window.gurt.setNotificationPrefs(next)
    } catch (e) {
      setPrefs(prior)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      <div className="set-head">
        <div className="set-title-wrap">
          <span className="set-title">Notifications</span>
          <span className="set-count mono">applies across every workspace</span>
        </div>
      </div>
      <div className="set-list notif-prefs">
        <div className="notif-prefs-row notif-prefs-head">
          <span className="seclabel">TYPE</span>
          <span className="seclabel">IN-APP</span>
          <span className="seclabel">
            EXTERNAL <span className="fld-hint">— stub — not sent anywhere yet</span>
          </span>
        </div>
        {NOTIFICATION_ORDER.map((type) => {
          const p = prefs?.[type]
          const copy = NOTIFICATION_COPY[type]
          return (
            <div key={type} className="notif-prefs-row">
              <span className="set-row-label">
                {copy.label}
                <div className="fld-hint">{copy.hint}</div>
              </span>
              <button
                className={`chip-btn ${p?.inApp ? 'on' : ''}`}
                disabled={!prefs}
                onClick={() => toggle(type, 'inApp')}
              >
                {p?.inApp ? 'on' : 'off'}
              </button>
              <button
                className={`chip-btn ${p?.external ? 'on' : ''}`}
                disabled={!prefs}
                onClick={() => toggle(type, 'external')}
              >
                {p?.external ? 'on' : 'off'}
              </button>
            </div>
          )
        })}
      </div>
      {error && <div className="error">{error}</div>}
    </>
  )
}

// ---- Credentials (#4d) ----

const hostsToText = (hosts: string[]) => hosts.join(', ')
const textToHosts = (text: string) => text.split(',').map((h) => h.trim()).filter(Boolean)

/** Preview of an entry's secret-ish field for the collapsed row. `data.secret`
 *  is already masked server-side (getCredentials() never serves plaintext) —
 *  used as-is. `keyPath` is not secret-flagged and still masked here, purely
 *  for display brevity. */
function maskedPreview(c: CredentialEntry): string {
  if (c.data.secret) return c.data.secret
  if (c.data.keyPath) {
    const tail = c.data.keyPath.length > 8 ? c.data.keyPath.slice(-4) : ''
    return `••••••${tail}`
  }
  return c.kind === 'git-host' ? 'ambient host auth' : '—'
}

const KIND_TAG: Record<CredentialKind, string> = {
  'git-token': 'token',
  'git-ssh-key': 'ssh',
  'git-app': 'app',
  'git-host': 'host',
  'agent-token': 'agent'
}

function CredentialsSection() {
  const [entries, setEntries] = useState<CredentialEntry[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [draft, setDraft] = useState<CredentialEntry | null>(null)
  const [draftHosts, setDraftHosts] = useState('')
  const [plaintext, setPlaintext] = useState(false)
  const [error, setError] = useState('')
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
      .catch((e) => setError(String(e)))
  }, [])

  const expand = (c: CredentialEntry) => {
    setOpen(c.id)
    // Secret fields open empty — the served value is only ever a mask, and an
    // empty field on save means "keep what's stored" (main's sentinel
    // resolution). The mask shows up as the input's placeholder instead.
    const data = { ...c.data }
    for (const f of kindDef(c.kind).fields) if (f.secret) data[f.key] = ''
    setDraft({ ...c, data })
    setDraftHosts(hostsToText(c.hosts))
    setError('')
  }

  const collapse = () => {
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
      const missing = kindDef(draft.kind).fields.find(
        (f) => f.secret && !(draft.data[f.key] ?? '').trim()
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

  const remove = async (c: CredentialEntry) => {
    setError('')
    // Block deleting an entry a repo still links to (§9).
    const used = await window.gurt.credentialUsedBy(c.id).catch(() => [])
    if (used.length) {
      setError(`linked by ${used.join(', ')} — unlink it (repo / client settings) first`)
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

  const count = (entries ?? []).filter((c) => c.label.trim()).length
  const kindDef = (kind: CredentialKind) => CREDENTIAL_KINDS.find((k) => k.kind === kind)!

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
        {(entries ?? []).map((c) => {
          if (open !== c.id) {
            if (!c.label.trim()) return null
            return (
              <div key={c.id} className="set-row clickable" onClick={() => expand(c)}>
                <Icon name="key" size={13} className="faint" style={{ flex: 'none' }} />
                <span className="cred-name mono">{c.label}</span>
                <span className="cred-tag">
                  <span className="tag">{KIND_TAG[c.kind]}</span>
                </span>
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
                  <span className="tag">{KIND_TAG[draft?.kind ?? c.kind]}</span>
                </span>
                <span className="cred-preview mono">{maskedPreview(c)}</span>
                <Icon name="chevron" size={12} className="faint" />
              </div>
              {draft && def && (
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
                  <div className="fld-hint">
                    {def.hint}
                    {!def.implemented && ' — stored, runtime not wired yet'}
                  </div>
                  {def.fields.map((f) => (
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
                  {draft.kind === 'git-token' && draft.data.gitEmail && (
                    <div className="fld-hint">
                      verified identity: {draft.data.gitName} &lt;{draft.data.gitEmail}&gt;
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
                    <button className="btn-danger-text" onClick={() => remove(c)}>
                      Delete
                    </button>
                    <span className="spacer" />
                    <button className="btn" onClick={collapse}>
                      Cancel
                    </button>
                    <button className="btn btn-primary" onClick={save}>
                      Save
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
        {count === 0 && open === null && <div className="tp-dashed">no credentials yet</div>}
      </div>
    </>
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
