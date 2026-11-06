import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { EnvConfig, RepoConfig, Tree } from '../../../../shared/types'
import { BASE_ENV_NAME, DEFAULT_BASE_IMAGE } from '../../../../shared/types'
import type { EnvImageStatus } from '../../../../shared/api'
import { formatEnvLines, parseEnvLines, validateEnvConfig } from '../../../../shared/envConfig'
import { useOutsideClose } from '../../hooks'
import { confirmDialog } from '../../dialog'
import { Icon } from '../icons'
import { Modal } from '../Modal'
import { run } from '../../async'
import { stripProtocol } from './shared'

// ---- Environments (#4a) — the workspace's env definitions ----

export function EnvironmentsSection({ tree, ws }: { tree: Tree | null; ws: string | null }) {
  const [editing, setEditing] = useState<EnvConfig | null>(null)
  const [adding, setAdding] = useState(false)
  const [operatorError, setOperatorError] = useState('')
  const [baseImage, setBaseImage] = useState(DEFAULT_BASE_IMAGE)
  const [baseDraft, setBaseDraft] = useState(DEFAULT_BASE_IMAGE)
  const [statuses, setStatuses] = useState<Record<string, EnvImageStatus>>({})
  const [building, setBuilding] = useState<Set<string>>(new Set())
  const [buildLogs, setBuildLogs] = useState<Record<string, string[]>>({})
  const [buildErrors, setBuildErrors] = useState<Record<string, string>>({})
  const wsData = tree?.workspaces.find((w) => w.name === ws)
  const envs = wsData?.envs ?? []
  const repos = wsData?.repos ?? []

  useEffect(() => {
    void window.gurt.getBaseImage().then((v) => {
      setBaseImage(v)
      setBaseDraft(v)
    })
  }, [])

  const setDefault = (env: string | undefined): Promise<void> =>
    window.gurt
      .setDefaultEnv(ws ?? '', env)
      .then(() => setOperatorError(''))
      .catch((e: unknown) => setOperatorError(e instanceof Error ? e.message : String(e)))

  // These maps are keyed by env *name*, which is only unique within one
  // workspace — switching workspaces must drop them, and a reply that raced
  // the switch must not land under the new workspace's same-named env.
  const wsRef = useRef(ws)
  useEffect(() => {
    wsRef.current = ws
    setStatuses({})
    setBuildLogs({})
    setBuildErrors({})
  }, [ws])

  // Memoized on `ws` alone — the only thing it closes over — so the effect
  // below can name it as a dependency instead of suppressing it.
  const loadStatus = useCallback(
    (env: string) => {
      if (!ws) return
      window.gurt
        .envImageStatus(ws, env)
        .then((s) => {
          if (wsRef.current === ws) setStatuses((prev) => ({ ...prev, [env]: s }))
        })
        .catch(() => {})
    },
    [ws]
  )

  // Badges load lazily when the section opens; refreshed per-env after a build.
  // `envNames` is a joined string, not the array: the env list is rebuilt on
  // every render, and only its *contents* should re-trigger the load.
  const envNames = envs.map((e) => e.name).join('\n')
  useEffect(() => {
    for (const name of envNames ? envNames.split('\n') : []) loadStatus(name)
  }, [envNames, loadStatus])

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
        {/* The base image: one app-level setting, the default of every new
            session. Not editable per workspace; replace it here. */}
        <div className="set-row" title="the image new sessions run on unless an env is picked">
          <span className="set-row-label">{BASE_ENV_NAME}</span>
          <input
            className="input mono"
            style={{ flex: 1 }}
            value={baseDraft}
            spellCheck={false}
            onChange={(ev) => setBaseDraft(ev.target.value)}
            placeholder={DEFAULT_BASE_IMAGE}
          />
          <button
            className="btn-link"
            disabled={baseDraft.trim() === baseImage}
            onClick={() =>
              void window.gurt
                .setBaseImage(baseDraft)
                .then(() => window.gurt.getBaseImage())
                .then((v) => {
                  setBaseImage(v)
                  setBaseDraft(v)
                  setOperatorError('')
                })
                .catch((e: unknown) => setOperatorError(e instanceof Error ? e.message : String(e)))
            }
          >
            save
          </button>
          {baseImage !== DEFAULT_BASE_IMAGE && (
            <button
              className="btn-link"
              onClick={() =>
                void window.gurt
                  .setBaseImage(undefined)
                  .then(() => {
                    setBaseImage(DEFAULT_BASE_IMAGE)
                    setBaseDraft(DEFAULT_BASE_IMAGE)
                  })
                  .catch((e: unknown) =>
                    setOperatorError(e instanceof Error ? e.message : String(e))
                  )
              }
            >
              reset
            </button>
          )}
          {!wsData?.defaultEnv && <span className="tag tag-green">default</span>}
          {wsData?.defaultEnv && ws && (
            <button
              className="btn-link"
              onClick={() => void setDefault(undefined)}
            >
              make default
            </button>
          )}
        </div>
        {operatorError && <div className="error">{operatorError}</div>}
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
                    : e.image
                      ? ` · ${e.image}`
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
                {wsData?.defaultEnv === e.name ? (
                  <span className="tag tag-green">default</span>
                ) : (
                  <button className="btn-link" onClick={() => void setDefault(e.name)}>
                    make default
                  </button>
                )}
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

// ---- Edit environment popup (#4b) — name, default repo, image or Dockerfile, scripts ----

function EnvModal({
  ws,
  repos,
  initial,
  onClose
}: {
  ws: string
  repos: RepoConfig[]
  initial?: EnvConfig | undefined
  onClose: () => void
}) {
  const editing = !!initial
  const [name, setName] = useState(initial?.name ?? '')
  const [repo, setRepo] = useState<string | null>(initial?.repo ?? null)
  const [repoMenu, setRepoMenu] = useState(false)
  const [error, setError] = useState('')
  const repoRef = useRef<HTMLDivElement>(null)
  useOutsideClose(repoMenu, repoRef, () => setRepoMenu(false))

  // The source: an image to run, or a Dockerfile gurt builds. Exactly one.
  const [source, setSource] = useState<'image' | 'dockerfile'>(
    initial?.dockerfile ? 'dockerfile' : 'image'
  )
  const [image, setImage] = useState(initial?.image ?? '')
  const [dockerfile, setDockerfile] = useState(initial?.dockerfile ?? '')
  const [dockerfilePath, setDockerfilePath] = useState(initial?.dockerfilePath ?? '')
  const [buildContext, setBuildContext] = useState(initial?.build?.context ?? '')
  const [buildArgs, setBuildArgs] = useState(formatEnvLines(initial?.build?.args))
  const [buildTarget, setBuildTarget] = useState(initial?.build?.target ?? '')
  const [dockerfileCandidates, setDockerfileCandidates] = useState<
    { path: string; content: string }[] | null
  >(null)
  const [dockerfileMenu, setDockerfileMenu] = useState(false)
  const [detectingDockerfiles, setDetectingDockerfiles] = useState(false)
  const [dockerfileMsg, setDockerfileMsg] = useState('')
  const dockerfileRef = useRef<HTMLDivElement>(null)
  useOutsideClose(dockerfileMenu, dockerfileRef, () => setDockerfileMenu(false))

  const [envText, setEnvText] = useState(formatEnvLines(initial?.env))
  const [setup, setSetup] = useState(initial?.setup ?? '')
  const [start, setStart] = useState(initial?.start ?? '')

  const envVars = parseEnvLines(envText)
  const argVars = parseEnvLines(buildArgs)
  const build: NonNullable<EnvConfig['build']> = {
    ...(buildContext.trim() ? { context: buildContext.trim() } : {}),
    ...('vars' in argVars && Object.keys(argVars.vars).length ? { args: argVars.vars } : {}),
    ...(buildTarget.trim() ? { target: buildTarget.trim() } : {})
  }
  // Built by spread rather than by writing `undefined`: this is the record that
  // gets saved, and a key carrying nothing would be stored as one.
  const draft: EnvConfig = {
    name: name.trim(),
    ...(source === 'image'
      ? { image: image.trim() }
      : {
          dockerfile,
          ...(dockerfilePath ? { dockerfilePath } : {}),
          ...(Object.keys(build).length ? { build } : {})
        }),
    ...('vars' in envVars && Object.keys(envVars.vars).length ? { env: envVars.vars } : {}),
    ...(setup.trim() ? { setup } : {}),
    ...(start.trim() ? { start } : {}),
    ...(repo ? { repo } : {})
  }
  const cfgError =
    ('error' in envVars ? `environment: ${envVars.error}` : null) ??
    ('error' in argVars ? `build args: ${argVars.error}` : null) ??
    validateEnvConfig(draft)
  const valid = !!name.trim() && cfgError === null
  const repoUrl = repo ? repos.find((r) => r.name === repo)?.url : undefined

  const detectDockerfiles = async () => {
    if (!repo) return
    setDockerfileMsg('')
    setDetectingDockerfiles(true)
    try {
      const found = await window.gurt.discoverDockerfiles(ws, repo)
      setDockerfileCandidates(found)
      const [single] = found
      if (found.length === 0) setDockerfileMsg('no Dockerfile found in repo')
      else if (single && found.length === 1) {
        setDockerfilePath(single.path)
        setDockerfile(single.content)
        setDockerfileMsg(`loaded ${single.path}`)
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
            <span className="seclabel">SOURCE</span>
          </div>
          <div className="seg">
            <button
              type="button"
              className={`seg-btn ${source === 'image' ? 'active' : ''}`}
              onClick={() => setSource('image')}
            >
              Image
            </button>
            <button
              type="button"
              className={`seg-btn ${source === 'dockerfile' ? 'active' : ''}`}
              onClick={() => setSource('dockerfile')}
            >
              Dockerfile
            </button>
          </div>
        </div>

        {source === 'image' && (
          <label className="fld">
            <span className="seclabel">IMAGE</span>
            <input
              className="input mono"
              placeholder="node:22-trixie"
              value={image}
              onChange={(e) => setImage(e.target.value)}
            />
            <span className="fld-hint">
              pulled when it is not on this machine; a Debian/Ubuntu (glibc) image — Alpine is not
              supported
            </span>
          </label>
        )}

        {source === 'dockerfile' && (
          <div className="fld">
            <div className="fld-head">
              <span className="seclabel">DOCKERFILE</span>
              <span className="fld-hint mono">
                {dockerfile
                  ? dockerfilePath
                    ? `from ${dockerfilePath}`
                    : 'custom'
                  : 'required'}
              </span>
              <span className="spacer" />
              <button
                className="btn-link mono"
                disabled={!repoUrl || detectingDockerfiles}
                title={!repoUrl ? 'set a default repository first' : undefined}
                onClick={run(detectDockerfiles)}
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
              placeholder={'FROM node:22\nWORKDIR /app\nCOPY . .\nRUN npm ci'}
            />
            {dockerfileMsg && <div className="fld-hint mono">{dockerfileMsg}</div>}
            <div className="fld-hint">
              gurt builds this Dockerfile in a temporary snapshot of the repo at HEAD; the image
              is cached and reused until the Dockerfile, the build options, or the repo's
              committed content change.
            </div>
            <details>
              <summary className="fld-hint mono">advanced — build context, args, target</summary>
              <label className="fld">
                <span className="seclabel">CONTEXT</span>
                <input
                  className="input mono"
                  placeholder=". (repo root)"
                  value={buildContext}
                  onChange={(e) => setBuildContext(e.target.value)}
                />
                <span className="fld-hint">relative to the repo root, inside it</span>
              </label>
              <div className="fld">
                <span className="seclabel">BUILD ARGS</span>
                <CodeEditor
                  value={buildArgs}
                  onChange={setBuildArgs}
                  placeholder={'NODE_VERSION=22'}
                />
                <span className="fld-hint">KEY=VALUE per line</span>
              </div>
              <label className="fld">
                <span className="seclabel">TARGET</span>
                <input
                  className="input mono"
                  value={buildTarget}
                  onChange={(e) => setBuildTarget(e.target.value)}
                />
              </label>
            </details>
          </div>
        )}

        <div className="fld">
          <span className="seclabel">ENVIRONMENT</span>
          <CodeEditor value={envText} onChange={setEnvText} placeholder={'KEY=VALUE'} />
          <span className="fld-hint">container environment variables, KEY=VALUE per line</span>
        </div>

        <div className="fld">
          <span className="seclabel">SETUP SCRIPT</span>
          <CodeEditor value={setup} onChange={setSetup} placeholder={'npm ci'} />
          <span className="fld-hint">
            runs once when the container is created, in the repo, with network access; skipped for
            read-only roles
          </span>
        </div>

        <div className="fld">
          <span className="seclabel">START SCRIPT</span>
          <CodeEditor value={start} onChange={setStart} placeholder={'service postgresql start'} />
          <span className="fld-hint">runs every time the container starts</span>
        </div>

        {cfgError && <div className="fld-hint mono">⚠ {cfgError}</div>}
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
