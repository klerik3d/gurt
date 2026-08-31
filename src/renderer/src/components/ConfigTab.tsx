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
import { LOCAL_MCP_NOTICE, isLocalMcpEntry, mcpHasModes, resolveMcpSelection } from '../../../shared/mcp'
import type { SkillEntry } from '../../../shared/skills'
import { resolveSkillSelection } from '../../../shared/skills'
import { agentOptionView } from '../../../shared/agentConfig'
import { agentDef } from '../../../shared/agents'
import { agentKind, agentName, useAgents } from '../useAgents'
import { useMcpEntries } from '../useMcp'
import { useSkillEntries } from '../useSkills'
import { NetworkPicker } from './Network'
import { useOutsideClose } from '../hooks'
import { alertDialog } from '../dialog'
import { Icon, Dot } from './icons'
import {
  AgentMark,
  AgentTag,
  EnvTag,
  McpTag,
  NetTag,
  ROLE_INFO,
  RepoTag,
  RoleTag,
  SkillTag,
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
  // Selecting this runs a process on the user's machine, so the picker says so
  // where the choice is made — not only in Settings, and not only as a tooltip
  // (docs/requirements-mcp-stdio.md §2).
  const local = entry.source === 'registry' && isLocalMcpEntry(entry.entry)
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
      {local && <div className="mcp-local-note">{LOCAL_MCP_NOTICE}</div>}
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

/**
 * One offered skill in the harness config: dot + name + description + menu.
 *
 * Two states, off and on. A skill has no `read-only`/`full` twin to
 * `McpRow`'s — gurt hands the agent files, and there is no half of a file to
 * grant (docs/requirements-skills.md §7). A skill whose `SKILL.md` does not
 * parse is still listed and still selectable: it says what is wrong instead of
 * what it does, and Settings is where it gets fixed.
 */
function SkillRow({
  entry,
  on,
  onChange
}: {
  entry: SkillEntry
  on: boolean
  onChange: (on: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(open, ref, () => setOpen(false))
  const label = on ? 'on' : 'off'
  return (
    <div className="pick-wrap" ref={ref}>
      <button
        type="button"
        className="pick-row mcp-row"
        title={entry.problem ?? entry.description}
        onClick={() => setOpen((o) => !o)}
      >
        <Dot tone={entry.problem ? 'red' : on ? 'green' : 'outline'} size={7} />
        <span className={`mcp-name ${on ? '' : 'faint'}`}>{entry.name}</span>
        <span className="mcp-desc faint">{entry.problem ?? entry.description}</span>
        <span className="pick-meta">{label}</span>
        <Icon name="chevron" size={12} className="faint" style={{ flex: 'none' }} />
      </button>
      {open && (
        <div className="menu pick-menu">
          {(['off', 'on'] as const).map((m) => (
            <div
              key={m}
              className={`menu-item ${label === m ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                setOpen(false)
                onChange(m === 'on')
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

/** A selected skill the workspace no longer holds. It stays on the list — and
 *  stays in the selection until the user says otherwise — because the draft
 *  still names it and a start would report it as not mounted, which is a thing
 *  to see here rather than in the session log. */
function SkillMissingRow({ name, onRemove }: { name: string; onRemove: () => void }) {
  return (
    <div
      className="pick-row mcp-row"
      title={`"${name}" is selected but this workspace no longer offers it — it is not in the skill registry`}
    >
      <Dot tone="red" size={7} />
      <span className="mcp-name">{name}</span>
      <span className="mcp-desc faint">unavailable — not in this workspace&apos;s skills</span>
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
  const skillsOffered = useSkillEntries(info.workspace)
  const role = sessionRole(info)
  const repos = info.repos
  const mcp = info.mcp ?? []
  const skills = info.skills ?? []
  const network = info.network ?? { internal: false }
  const autoAllow = info.autoAllow ?? true
  const configValues = info.configValues ?? {}
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [picker, setPicker] = useState<'env' | 'repo' | 'client' | 'role' | null>(null)
  const [error, setError] = useState('')

  const wsData = tree.workspaces.find((w) => w.name === info.workspace)
  const envs = wsData?.envs ?? []
  const allRepos = wsData?.repos ?? []
  const deniedAgents = wsData?.deniedAgents ?? []
  const agentList = Object.entries(agents)
    .filter(([id]) => !deniedAgents.includes(id))
    .map(([id, a]) => ({ id, label: a.label, kind: a.kind }))

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

  // A bare draft (App.tsx) names no agent up front — fill in the workspace's
  // default the first time one is offered, so the picker doesn't sit empty for
  // no reason. Never overrides an explicit pick, and never offers a denied one.
  useEffect(() => {
    if (info.agent || !wsData?.defaultAgent) return
    if (deniedAgents.includes(wsData.defaultAgent)) return
    patch({ agent: wsData.defaultAgent })
    // patch is a fresh closure every render; only the id it would set matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.agent, wsData?.defaultAgent])

  // The workspace's default-on skills, seeded exactly once — `info.skills` is
  // absent only on a draft nobody has touched, so a user who turns them all off
  // gets `[]` and is not re-seeded (docs/requirements-skills.md §4.2). Seeded
  // here rather than at create time so the draft *shows* what it will mount
  // before Run is pressed. Names that no longer resolve come along and render
  // as error rows, which is the same thing the picker does for any other stale
  // selection.
  useEffect(() => {
    if (info.skills !== undefined || !wsData?.defaultSkills?.length) return
    patch({ skills: wsData.defaultSkills.map((name) => ({ name })) })
    // patch is a fresh closure every render; only the names it would set matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.skills, wsData?.defaultSkills?.join('\u0000')])

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

  // The `mcpHasModes` rule again: gurt does not claim what it cannot deliver.
  // A kind whose pinned CLI reads no skills directory (`AgentDef.skillsDir` is
  // null, agents.ts) gets a plain statement instead of pickers. The stored
  // selection is left exactly as it is — absent/[] semantics included — so
  // switching to a supporting agent and back loses nothing.
  const draftAgentDef = agentDef(agentKind(agents, info.agent) ?? '')
  const skillsUnsupported = !!draftAgentDef && draftAgentDef.skillsDir === null

  const setSkill = (name: string, on: boolean): void =>
    patch({
      skills: on
        ? skills.some((k) => k.name === name)
          ? skills
          : [...skills, { name }]
        : skills.filter((k) => k.name !== name)
    })
  const skillOrphans = skills.filter((sel) => !skillsOffered.some((e) => e.name === sel.name))

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

  // MODEL/EFFORT are pulled out of `cfgOptions` into the always-visible
  // BEHAVIOR section below; whatever else an agent reports (rare) stays in
  // the collapsed panel with MCP and the rest.
  const behaviorOptions = cfgOptions.filter((o) => o.category === 'model' || o.category === 'thought_level')
  const advancedOptions = cfgOptions.filter((o) => o.category !== 'model' && o.category !== 'thought_level')
  const advancedSummary =
    [
      mcp.length ? `${mcp.length} mcp` : '',
      // An unsupported agent's count would read as "these are active" — say
      // the honest thing in the same number of characters.
      skillsUnsupported ? 'no skills' : skills.length ? `${skills.length} skills` : ''
    ]
      .filter(Boolean)
      .join(' · ') || 'no mcp, no skills'

  const configBlock = (opt: SessionConfigOption): ReactNode =>
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
        {selectedDescription(opt) && <div className="hc-note">{selectedDescription(opt)}</div>}
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

      {/* env + repo: what the session runs against. Grouped as a pair — each
          keeps its own label, a subtle rule marks the split between them —
          rather than under one shared heading, since "workspace" already
          names the envs/repos' parent in this codebase and would be
          confusing reused here. */}
      <div className="ns-section">
        <div className="ns-subsection">
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
        </div>

        {/* session repositories — seeded from the env's default, changeable
            here. Multi-select for a researcher only. */}
        <div className="ns-subsection">
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
      </div>

      {/* agent — which client/harness runs the session */}
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
      </div>

      {/* behavior — the fields changed most often (model/effort) plus the
          auto/manual safety toggle, always visible rather than a click away. */}
      <div className="ns-section">
        <span className="seclabel">BEHAVIOR</span>
        {behaviorOptions.map(configBlock)}
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
      </div>

      {/* permissions — network is a capability boundary like MODE, not tuning,
          so it stays out of the collapsed panel too. */}
      <div className="ns-section">
        <span className="seclabel">PERMISSIONS</span>
        <NetworkPicker network={network} onChange={(next) => patch({ network: next })} />
      </div>

      {/* advanced — everything left: rare agent-reported options, MCP
          servers, the skills stub, and reset. */}
      <div className="ns-section">
        <div className={`hc ${advancedOpen ? 'open' : ''}`}>
          <button type="button" className="pick-row hc-head" onClick={() => setAdvancedOpen((o) => !o)}>
            <Icon
              name="chevron"
              size={13}
              className="faint"
              style={{ flex: 'none', transform: advancedOpen ? undefined : 'rotate(-90deg)' }}
            />
            <span className="pick-value">Advanced</span>
            <span className="spacer" />
            <span className="pick-meta">{advancedSummary}</span>
          </button>
          {advancedOpen && (
            <div className="hc-body">
              {advancedOptions.map(configBlock)}
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
              <div className="hc-block">
                <span className="seclabel">SKILLS</span>
                {skillsUnsupported ? (
                  <div className="hc-note">
                    {draftAgentDef?.label} does not support skills — nothing would be mounted.
                    {skills.length
                      ? ' Your selection is kept and applies if you pick an agent that does.'
                      : ''}
                  </div>
                ) : (
                  <>
                    {skillsOffered.map((entry) => (
                      <SkillRow
                        key={entry.name}
                        entry={entry}
                        on={skills.some((k) => k.name === entry.name)}
                        onChange={(on) => setSkill(entry.name, on)}
                      />
                    ))}
                    {skillOrphans.map((sel) => (
                      <SkillMissingRow
                        key={sel.name}
                        name={sel.name}
                        onRemove={() => setSkill(sel.name, false)}
                      />
                    ))}
                    {!skillsOffered.length && !skillOrphans.length && (
                      <div className="hc-note">
                        no skills in this workspace — add one in Settings &rarr; Skills. A skill in
                        the repository&apos;s own .claude/skills is the repo&apos;s and is not listed
                        here.
                      </div>
                    )}
                  </>
                )}
              </div>
              <div className="hc-foot">
                <span className="spacer" />
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    patch({ autoAllow: true, mcp: [], skills: [], network: { internal: false } })
                  }
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
  const skillsOffered = useSkillEntries(info.workspace)
  const mcp = resolveMcpSelection(info.mcp, mcpOffered)
  const skills = resolveSkillSelection(info.skills, skillsOffered)
  // Same honesty as the draft picker: a kind whose pinned CLI reads no skills
  // directory got no mount (containers.ts), so its selection must not appear
  // as active tags — the note below says what happened to it instead.
  const liveAgentDef = agentDef(agentKind(agents, info.agent) ?? '')
  const skillsUnsupported = !!liveAgentDef && liveAgentDef.skillsDir === null
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
        {/* Read-only, like everything else here, and for a reason of its own:
            the files are already bind-mounted into a running container, so
            there is nothing a picker could change (docs/requirements-skills.md
            §2). Not rendered at all for an agent that cannot see them — a tag
            here says "mounted", and for that kind nothing was. */}
        {!skillsUnsupported &&
          skills.map((r) => <SkillTag key={r.selection.name} {...r} />)}
        <NetTag network={info.network} />
      </div>
      {skillsUnsupported && skills.length > 0 && (
        <div className="hc-note">
          {liveAgentDef?.label} does not support skills — the {skills.length} selected{' '}
          {skills.length === 1 ? 'skill was' : 'skills were'} not mounted
        </div>
      )}
      <div className="hc-note">
        role, environment, repository, MCP, skills and network are fixed once a session leaves
        draft — duplicate it to change them and start over
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
