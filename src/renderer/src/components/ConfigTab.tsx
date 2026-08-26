import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  AgentConfig,
  McpMode,
  SessionConfigOption,
  SessionInfo,
  SessionMode,
  SessionModes,
  SessionRole,
  SessionSnapshot,
  Tree
} from '../../../shared/types'
import { SESSION_ROLES, roleAllowsMultiRepo, sessionRole } from '../../../shared/types'
import type { SessionDraftPatch } from '../../../shared/api'
import type { McpEntry } from '../../../shared/mcp'
import { mcpHasModes, resolveMcpSelection } from '../../../shared/mcp'
import { agentOptionView } from '../../../shared/agentConfig'
import { agentKind, agentName, useAgents } from '../useAgents'
import { useMcpEntries } from '../useMcp'
import { NetworkPicker } from './Network'
import { useOutsideClose } from '../hooks'
import { alertDialog } from '../dialog'
import { Icon, Dot } from './icons'
import {
  AgentMark,
  AgentTag,
  EnvTag,
  McpTag,
  NET_INFO,
  NetTag,
  ROLE_INFO,
  RepoTag,
  RoleTag,
  agentIcon
} from './tags'
import { run } from '../async'

// Config tab (#1b/#2b): the session's whole configuration surface, moved here
// from the old New Session modal (git history) now that a session starts life
// as a bare draft instead of being configured up front. Fully editable while
// the session is a draft — every pick saves immediately via `sessionEditDraft`,
// there is no Save button — and read-only once it has queued or started, since
// most of this is fixed at that point (see `SessionInfo`/`SessionDraftPatch`).

/** Blanket permission-bypass modes (Claude's "bypassPermissions", Codex's
 *  "yolo") — hidden from the live mode picker, same as the composer's gear
 *  popup (Chat.tsx): gurt's own "auto" already maps to the safer accept-edits
 *  mode, and the agent may still report one as current without it being offered. */
const BLANKET_MODE_RE = /bypass|yolo/i
const isBlanketMode = (m: SessionMode): boolean => BLANKET_MODE_RE.test(`${m.id} ${m.name}`)

/** Quiet select row: a field-styled button that opens a menu of options. */
function PickRow({
  open,
  onToggle,
  onClose,
  menu,
  children
}: {
  open: boolean
  onToggle: () => void
  onClose: () => void
  menu: ReactNode
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(open, ref, onClose)
  return (
    <div className="pick-wrap" ref={ref}>
      <button type="button" className="pick-row" onClick={onToggle}>
        {children}
        <Icon name="chevron" size={13} className="faint" style={{ flex: 'none' }} />
      </button>
      {open && <div className="menu pick-menu">{menu}</div>}
    </div>
  )
}

/**
 * One offered MCP server in the harness config: dot + name + description + menu.
 *
 * Three states for a built-in (off / read-only / full) and two for a registry
 * entry (off / on): gurt knows which of *its own* tools write and can hand the
 * agent a smaller set, and knows nothing about an upstream's, so offering
 * read-only there would claim an enforcement it does not have (§3.3). "on" is
 * recorded as `full` — one `McpSelection` shape for both sources.
 */
function McpRow({
  entry,
  mode,
  onChange
}: {
  entry: McpEntry
  mode: McpMode | undefined
  onChange: (mode: McpMode | null) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(open, ref, () => setOpen(false))
  const modes = mcpHasModes(entry)
  const on = mode != null
  const options = modes ? (['off', 'read-only', 'full'] as const) : (['off', 'on'] as const)
  const label = !on ? 'off' : modes ? mode : 'on'
  const pick = (m: (typeof options)[number]) => {
    setOpen(false)
    onChange(m === 'off' ? null : m === 'on' ? 'full' : m)
  }
  return (
    <div className="pick-wrap" ref={ref}>
      <button
        type="button"
        className="pick-row mcp-row"
        title={entry.description}
        onClick={() => setOpen((o) => !o)}
      >
        <Dot tone={on ? 'green' : 'outline'} size={7} />
        <span className={`mcp-name ${on ? '' : 'faint'}`}>{entry.label}</span>
        <span className="mcp-desc faint">{entry.description}</span>
        <span className="pick-meta">{label}</span>
        <Icon name="chevron" size={12} className="faint" style={{ flex: 'none' }} />
      </button>
      {open && (
        <div className="menu pick-menu">
          {options.map((m) => (
            <div
              key={m}
              className={`menu-item ${label === m ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(m)
              }}
            >
              {m}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** A selected id the workspace no longer offers. It stays on the list — and
 *  stays in the selection until the user says otherwise — because the draft
 *  still names it and a start would report it as unroutable, which is a thing
 *  to see here rather than in the session log. */
function McpMissingRow({ id, onRemove }: { id: string; onRemove: () => void }) {
  return (
    <div
      className="pick-row mcp-row"
      title={`"${id}" is selected but this workspace no longer offers it — it is not a built-in and not in the registry`}
    >
      <Dot tone="red" size={7} />
      <span className="mcp-name">{id}</span>
      <span className="mcp-desc faint">unavailable — not a built-in, not in the registry</span>
      <button type="button" className="btn-link" onClick={onRemove}>
        remove
      </button>
    </div>
  )
}

/** `https://github.com/acme/checkout-web.git` → `acme/checkout-web`. */
function shortRepoUrl(url: string): string {
  const cleaned = url.replace(/\.git$/, '').replace(/\/+$/, '')
  return /[:/]([^:/]+\/[^:/]+)$/.exec(cleaned)?.[1] ?? cleaned
}

export function ConfigTab({ tree, snapshot }: { tree: Tree | null; snapshot: SessionSnapshot }) {
  if (snapshot.info.state === 'draft' && tree) return <DraftConfig tree={tree} info={snapshot.info} />
  return <LiveConfig snapshot={snapshot} />
}

function DraftConfig({ tree, info }: { tree: Tree; info: SessionInfo }) {
  const agents = useAgents()
  const mcpOffered = useMcpEntries(info.workspace)
  const role = sessionRole(info)
  const repos = info.repos
  const mcp = info.mcp ?? []
  const network = info.network ?? { internal: false }
  const autoAllow = info.autoAllow ?? true
  const configValues = info.configValues ?? {}
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null)
  const [harnessOpen, setHarnessOpen] = useState(false)
  const [picker, setPicker] = useState<'env' | 'repo' | 'client' | 'role' | null>(null)
  const [error, setError] = useState('')

  const wsData = tree.workspaces.find((w) => w.name === info.workspace)
  const envs = wsData?.envs ?? []
  const allRepos = wsData?.repos ?? []
  const agentList = Object.entries(agents).map(([id, a]) => ({ id, label: a.label, kind: a.kind }))

  // Load the chosen agent's cached config surface so the model/effort/command
  // controls can be offered before the container is up.
  useEffect(() => {
    if (!info.agent) {
      setAgentConfig(null)
      return
    }
    let live = true
    window.gurt
      .getAgentConfig(info.agent)
      .then((c) => live && setAgentConfig(c))
      .catch(() => live && setAgentConfig(null))
    return () => {
      live = false
    }
  }, [info.agent])

  const patch = (p: SessionDraftPatch): void => {
    window.gurt
      .sessionEditDraft(info.id, p)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  // Picking a (different) env re-seeds the session repo from that env's default.
  const pickEnv = (name: string) => {
    const def = envs.find((e) => e.name === name)?.repo
    patch({ env: name, repos: def ? [def] : [] })
    setPicker(null)
  }

  // Only a researcher may hold several repos, so leaving that role drops the
  // extras rather than letting an invalid pair reach the IPC boundary.
  const pickRole = (next: SessionRole) => {
    const p: SessionDraftPatch = { role: next }
    if (!roleAllowsMultiRepo(next) && repos.length > 1) p.repos = repos.slice(0, 1)
    patch(p)
    setPicker(null)
  }

  // Multi-select for a researcher, plain single pick for the roles that work in
  // exactly one clone.
  const toggleRepo = (name: string) => {
    const next = repos.includes(name)
      ? repos.filter((n) => n !== name)
      : roleAllowsMultiRepo(role)
        ? [...repos, name]
        : [name]
    patch({ repos: next })
  }

  const mcpMode = (id: string): McpMode | undefined => mcp.find((m) => m.id === id)?.mode
  const setMcpMode = (id: string, mode: McpMode | null): void => {
    const next =
      mode == null
        ? mcp.filter((m) => m.id !== id)
        : mcp.some((m) => m.id === id)
          ? mcp.map((m) => (m.id === id ? { id, mode } : m))
          : [...mcp, { id, mode }]
    patch({ mcp: next })
  }
  const mcpOrphans = mcp.filter((sel) => !mcpOffered.some((e) => e.id === sel.id))

  const setConfig = (opt: SessionConfigOption, value: string | boolean) =>
    patch({ configValues: { ...configValues, [opt.id]: value } })
  const optionView = agentOptionView(agentKind(agents, info.agent))
  const effective = (opt: SessionConfigOption): string | boolean =>
    optionView.activeValue({ ...opt, currentValue: configValues[opt.id] ?? opt.currentValue })
  const cfgOptions = (agentConfig?.configOptions ?? []).filter((o) => o.category !== 'mode')
  const cfgLabel = (o: SessionConfigOption) =>
    o.category === 'model' ? 'MODEL' : o.category === 'thought_level' ? 'EFFORT' : o.name.toUpperCase()
  const selectedDescription = (opt: SessionConfigOption): string | undefined =>
    opt.options?.find((o) => o.value === effective(opt))?.description ?? undefined
  const selectedName = (opt: SessionConfigOption): string | undefined =>
    optionView.selectOptions(opt).find((o) => o.value === effective(opt))?.name

  const mcpCount = mcp.length
  const modelOpt = cfgOptions.find((o) => o.category === 'model')
  const effortOpt = cfgOptions.find((o) => o.category === 'thought_level')
  const harnessSummary = [
    modelOpt && selectedName(modelOpt),
    effortOpt && selectedName(effortOpt),
    autoAllow ? 'auto' : 'manual',
    `${mcpCount} mcp`,
    network.internal ? NET_INFO.internal.label : null
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="ns-body">
      {/* role — what the session is for. It comes before the repository picker
          because it governs it (docs/requirements-session-roles.md). */}
      <div className="ns-section">
        <span className="seclabel">ROLE</span>
        <PickRow
          open={picker === 'role'}
          onToggle={() => setPicker(picker === 'role' ? null : 'role')}
          onClose={() => setPicker(null)}
          menu={SESSION_ROLES.map((r) => (
            <div
              key={r}
              className={`menu-item ${r === role ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                pickRole(r)
              }}
            >
              <Icon name={ROLE_INFO[r].icon} size={12} className="faint" />
              {ROLE_INFO[r].label}
            </div>
          ))}
        >
          <Icon name={ROLE_INFO[role].icon} size={14} className="dim" style={{ flex: 'none' }} />
          <span className="pick-value strong">{ROLE_INFO[role].label}</span>
          <span className="spacer" />
        </PickRow>
        <div className="hc-note">{ROLE_INFO[role].hint}</div>
      </div>

      {/* environment */}
      <div className="ns-section">
        <span className="seclabel">ENVIRONMENT</span>
        <PickRow
          open={picker === 'env'}
          onToggle={() => setPicker(picker === 'env' ? null : 'env')}
          onClose={() => setPicker(null)}
          menu={
            envs.length ? (
              envs.map((e) => (
                <div
                  key={e.name}
                  className={`menu-item ${e.name === info.env ? 'active' : ''}`}
                  onMouseDown={(ev) => {
                    ev.preventDefault()
                    pickEnv(e.name)
                  }}
                >
                  <Icon name="box" size={13} className="dim" />
                  {e.name}
                  {e.repo && <span className="menu-meta mono">{e.repo}</span>}
                </div>
              ))
            ) : (
              <div className="menu-empty">no environments — add one in Settings → Environments</div>
            )
          }
        >
          <Icon name="box" size={14} className="dim" style={{ flex: 'none' }} />
          <span className="pick-value strong">{info.env || 'pick an environment'}</span>
          <span className="spacer" />
        </PickRow>

        {/* session repositories — seeded from the env's default, changeable
            here. Multi-select for a researcher only. */}
        <span className="seclabel">REPOSITORY</span>
        <PickRow
          open={picker === 'repo'}
          onToggle={() => setPicker(picker === 'repo' ? null : 'repo')}
          onClose={() => setPicker(null)}
          menu={
            allRepos.length ? (
              allRepos.map((r) => {
                const active = repos.includes(r.name)
                return (
                  <div
                    key={r.name}
                    className={`menu-item ${active ? 'active' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      toggleRepo(r.name)
                    }}
                  >
                    <Icon name="branch" size={11} className="faint" />
                    {r.name}
                    <span className="menu-meta mono">{shortRepoUrl(r.url)}</span>
                  </div>
                )
              })
            ) : (
              <div className="menu-empty">no repositories — add one in Settings</div>
            )
          }
        >
          {repos.length ? (
            repos.map((name) => {
              const cfg = allRepos.find((r) => r.name === name)
              return (
                <span className="chip-tag" key={name}>
                  <Icon name="branch" size={11} className="faint" />
                  {cfg ? shortRepoUrl(cfg.url) : name}
                </span>
              )
            })
          ) : (
            <span className="chip-dashed">no repository</span>
          )}
          <span className="spacer" />
        </PickRow>
        {!repos.length && (
          <div className="hc-note">no repository — Run/Queue disabled until you pick one</div>
        )}
        {repos.length > 1 && <div className="hc-note">{repos.length} repos — mounted read-only</div>}
      </div>

      {/* agent */}
      <div className="ns-section">
        <span className="seclabel">AGENT</span>
        <PickRow
          open={picker === 'client'}
          onToggle={() => setPicker(picker === 'client' ? null : 'client')}
          onClose={() => setPicker(null)}
          menu={
            agentList.length ? (
              agentList.map((a) => (
                <div
                  key={a.id}
                  className={`menu-item ${a.id === info.agent ? 'active' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    patch({ agent: a.id })
                    setPicker(null)
                  }}
                >
                  <Dot tone="green" size={7} />
                  <Icon name={agentIcon(a.kind)} size={12} className="faint" />
                  {a.label}
                </div>
              ))
            ) : (
              <div className="menu-empty">no clients — add one in Settings → Clients</div>
            )
          }
        >
          <span className="pick-value">Client</span>
          <span className="spacer" />
          {info.agent && <Dot tone="green" size={7} />}
          <span className="pick-meta">
            {info.agent ? (
              <AgentMark kind={agentKind(agents, info.agent)} name={agentName(agents, info.agent)} />
            ) : (
              'none'
            )}
          </span>
        </PickRow>

        <div className={`hc ${harnessOpen ? 'open' : ''}`}>
          <button type="button" className="pick-row hc-head" onClick={() => setHarnessOpen((o) => !o)}>
            <Icon
              name="chevron"
              size={13}
              className="faint"
              style={{ flex: 'none', transform: harnessOpen ? undefined : 'rotate(-90deg)' }}
            />
            <span className="pick-value">Harness config</span>
            <span className="spacer" />
            <span className="pick-meta">{harnessSummary}</span>
          </button>
          {harnessOpen && (
            <div className="hc-body">
              {cfgOptions.map((opt) =>
                opt.type === 'select' ? (
                  <div key={opt.id} className="hc-block">
                    <span className="seclabel">{cfgLabel(opt)}</span>
                    <div className="chip-row">
                      {optionView.selectOptions(opt).map((o) => (
                        <button
                          key={o.value}
                          type="button"
                          className={`chip-btn ${effective(opt) === o.value ? 'on' : ''}`}
                          title={o.description ?? undefined}
                          onClick={() => setConfig(opt, o.value)}
                        >
                          {o.name}
                        </button>
                      ))}
                    </div>
                    {selectedDescription(opt) && (
                      <div className="hc-note">{selectedDescription(opt)}</div>
                    )}
                  </div>
                ) : (
                  <div key={opt.id} className="hc-block">
                    <span className="seclabel">{cfgLabel(opt)}</span>
                    <div className="chip-row">
                      <button
                        type="button"
                        className={`chip-btn ${effective(opt) === true ? 'on' : ''}`}
                        onClick={() => setConfig(opt, true)}
                      >
                        on
                      </button>
                      <button
                        type="button"
                        className={`chip-btn ${effective(opt) === false ? 'on' : ''}`}
                        onClick={() => setConfig(opt, false)}
                      >
                        off
                      </button>
                    </div>
                  </div>
                )
              )}
              <div className="hc-block">
                <span className="seclabel">MODE</span>
                <div className="chip-row">
                  <button
                    className={`chip-btn ${autoAllow ? 'on' : ''}`}
                    onClick={() => patch({ autoAllow: true })}
                    title="allow tool calls automatically"
                  >
                    auto
                  </button>
                  <button
                    className={`chip-btn ${!autoAllow ? 'on' : ''}`}
                    onClick={() => patch({ autoAllow: false })}
                    title="confirm each tool call"
                  >
                    manual
                  </button>
                </div>
              </div>
              {(mcpOffered.length > 0 || mcpOrphans.length > 0) && (
                <div className="hc-block">
                  <span className="seclabel">MCP SERVERS</span>
                  {mcpOffered.map((entry) => (
                    <McpRow
                      key={entry.id}
                      entry={entry}
                      mode={mcpMode(entry.id)}
                      onChange={(mode) => setMcpMode(entry.id, mode)}
                    />
                  ))}
                  {mcpOrphans.map((sel) => (
                    <McpMissingRow key={sel.id} id={sel.id} onRemove={() => setMcpMode(sel.id, null)} />
                  ))}
                </div>
              )}
              <NetworkPicker network={network} onChange={(next) => patch({ network: next })} />
              <div className="hc-block">
                <span className="seclabel">SKILLS</span>
                <div className="hc-stub">Skills, hooks, tool policy — coming later</div>
              </div>
              <div className="hc-foot">
                <span className="spacer" />
                <button
                  className="btn btn-sm"
                  onClick={() => patch({ autoAllow: true, mcp: [], network: { internal: false } })}
                >
                  Reset
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {error && <div className="error">{error}</div>}
    </div>
  )
}

/** Read-only once a session has queued or started — see `SessionDraftPatch`
 *  (main only accepts an edit while `state === 'draft'`). A started session
 *  still accepts a handful of live knobs through ACP itself (model, effort,
 *  mode), shown editable below the frozen summary. */
function LiveConfig({ snapshot }: { snapshot: SessionSnapshot }) {
  const { info } = snapshot
  const agents = useAgents()
  const mcpOffered = useMcpEntries(info.workspace)
  const mcp = resolveMcpSelection(info.mcp, mcpOffered)
  return (
    <div className="ns-body">
      <div className="draft-settings">
        <RoleTag role={sessionRole(info)} />
        {info.env ? <EnvTag name={info.env} /> : <span className="tag">no env</span>}
        {info.repos.length ? (
          info.repos.map((r) => <RepoTag key={r} name={r} />)
        ) : (
          <RepoTag name="no repo" />
        )}
        {info.agent ? (
          <AgentTag kind={agentKind(agents, info.agent)} name={agentName(agents, info.agent)} />
        ) : (
          <span className="tag">no agent</span>
        )}
        <span className="tag">{info.autoAllow === false ? 'manual' : 'auto'}</span>
        {mcp.map((r) => (
          <McpTag key={r.selection.id} {...r} />
        ))}
        <NetTag network={info.network} />
      </div>
      <div className="hc-note">
        role, environment, repository, MCP and network are fixed once a session leaves draft —
        duplicate it to change them and start over
      </div>
      {info.state === 'started' && (
        <LiveHarness
          sessionId={info.id}
          agentKind={agentKind(agents, info.agent)}
          modes={snapshot.modes}
          configOptions={snapshot.configOptions ?? []}
        />
      )}
    </div>
  )
}

/** The live model/effort/mode chips a started session still accepts, via the
 *  same ACP calls the composer's gear popup makes (Chat.tsx) — surfaced here
 *  too now that the config tab is where a session's settings live. */
function LiveHarness({
  sessionId,
  agentKind: kind,
  modes,
  configOptions
}: {
  sessionId: string
  agentKind?: string | undefined
  modes?: SessionModes | undefined
  configOptions: SessionConfigOption[]
}) {
  const setMode = (id: string) =>
    window.gurt.sessionSetMode(sessionId, id).catch((e: unknown) => alertDialog(String(e)))
  const setConfig = (opt: SessionConfigOption, value: string | boolean) =>
    window.gurt.sessionSetConfigOption(sessionId, opt.id, value).catch((e: unknown) => alertDialog(String(e)))
  const cfg = configOptions.filter((o) => o.category !== 'mode')
  const view = agentOptionView(kind)
  const sectionTitle = (o: SessionConfigOption) =>
    o.category === 'model' ? 'MODEL' : o.category === 'thought_level' ? 'EFFORT' : o.name.toUpperCase()
  const liveModes = modes ? modes.availableModes.filter((m) => !isBlanketMode(m)) : []
  if (cfg.length === 0 && liveModes.length === 0) return null

  return (
    <div className="hc-body">
      {cfg.map((opt) =>
        opt.type === 'select' ? (
          <div key={opt.id} className="hc-block">
            <span className="seclabel">{sectionTitle(opt)}</span>
            <div className="chip-row">
              {view.selectOptions(opt).map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={`chip-btn ${o.value === view.activeValue(opt) ? 'on' : ''}`}
                  title={o.description ?? undefined}
                  onClick={run(() => setConfig(opt, o.value))}
                >
                  {o.name}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div key={opt.id} className="hc-block">
            <span className="seclabel">{sectionTitle(opt)}</span>
            <div className="chip-row">
              <button
                type="button"
                className={`chip-btn ${opt.currentValue === true ? 'on' : ''}`}
                onClick={run(() => setConfig(opt, true))}
              >
                on
              </button>
              <button
                type="button"
                className={`chip-btn ${opt.currentValue === false ? 'on' : ''}`}
                onClick={run(() => setConfig(opt, false))}
              >
                off
              </button>
            </div>
          </div>
        )
      )}
      {liveModes.length > 0 && modes && (
        <div className="hc-block">
          <span className="seclabel">MODE</span>
          <div className="chip-row">
            {liveModes.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`chip-btn ${m.id === modes.currentModeId ? 'on' : ''}`}
                onClick={run(() => setMode(m.id))}
              >
                {m.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
