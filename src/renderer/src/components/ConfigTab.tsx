import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  BASE_ENV_NAME,
  REPO_MODES,
  USER_SESSION_ROLES,
  missingRepoReason,
  repoMode,
  roleForcesRead,
  sessionRole,
  type AgentConfig,
  type McpMode,
  type ReviewLoopConfig,
  type RepoConfig,
  type RepoMode,
  type SessionConfigOption,
  type SessionInfo,
  type SessionModes,
  type SessionRole,
  type SessionSnapshot,
  type Tree
} from '../../../shared/types'
import type { SessionDraftPatch } from '../../../shared/api'
import {
  LOCAL_MCP_NOTICE,
  isLocalMcpEntry,
  mcpHasModes,
  resolveMcpSelection,
  type McpEntry
} from '../../../shared/mcp'
import { resolveSkillSelection, type SkillEntry } from '../../../shared/skills'
import { REVIEW_ROUNDS, RUNG_LABEL } from '../../../shared/reviewBlock'
import { agentOptionView } from '../../../shared/agentConfig'
import { agentVocabulary, isBlanketMode } from '../../../shared/agentVocabulary'
import { agentDef } from '../../../shared/agents'
import { agentKind, agentName, useAgents } from '../useAgents'
import { useMcpEntries } from '../useMcp'
import { useSkillEntries } from '../useSkills'
import { useReviewBlock } from '../useReviewBlock'
import { NetworkPicker } from './Network'
import { ChoiceGroup } from './ChoiceGroup'
import { PickerField } from './PickerField'
import { useOutsideClose } from '../hooks'
import { alertDialog } from '../dialog'
import { AgentIcon, Icon, Dot, InfoDot } from './icons'
import {
  AgentMark,
  AgentTag,
  EnvTag,
  McpTag,
  NetTag,
  REPO_MODE_INFO,
  ROLE_INFO,
  RepoTag,
  RoleTag,
  SkillTag
} from './tags'
import { run } from '../async'

// Config tab (#1b/#2b): the session's whole configuration surface, moved here
// from the old New Session modal (git history) now that a session starts life
// as a bare draft instead of being configured up front. Fully editable while
// the session is a draft — every pick saves immediately via `sessionEditDraft`,
// there is no Save button — and read-only once it has queued or started, since
// most of this is fixed at that point (see `SessionInfo`/`SessionDraftPatch`).

/** Quiet select row: a field-styled button that opens a menu of options.
 *  `accessible` is for a menu of focusable buttons (not the mouse-only items
 *  of the older pickers): the row says it opens a popup and whether it is open,
 *  and focus comes back to it when the menu closes with focus still in it (a
 *  choice made, Escape) instead of vanishing with the item. */
function PickRow({
  open,
  onToggle,
  onClose,
  menu,
  accessible,
  children
}: {
  open: boolean
  onToggle: () => void
  onClose: () => void
  menu: ReactNode
  accessible?: boolean
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const row = useRef<HTMLButtonElement>(null)
  useOutsideClose(open, ref, onClose)
  const wasOpen = useRef(false)
  useEffect(() => {
    // Focus lost with the closed menu's item: it sits on <body> now.
    if (accessible && wasOpen.current && !open && document.activeElement === document.body) row.current?.focus()
    wasOpen.current = open
  }, [open, accessible])
  return (
    <div className="pick-wrap" ref={ref}>
      <button
        type="button"
        className="pick-row"
        ref={row}
        onClick={onToggle}
        {...(accessible ? { 'aria-haspopup': true, 'aria-expanded': open } : {})}
      >
        {children}
        <Icon name="chevron" size={13} className="faint icon-fixed" />
      </button>
      {open && <div className="menu pick-menu">{menu}</div>}
    </div>
  )
}

/** A picked MCP server, listed under the field. Picked is on; removing is off.
 *  A built-in with enforcement levels keeps its read-only/full switch — gurt
 *  knows which of *its own* tools write — while a registry entry has no such
 *  switch, because gurt knows nothing about an upstream's tools (§3.3). */
function McpSelectedRow({
  id,
  entry,
  mode,
  onChange
}: {
  id: string
  entry: McpEntry | undefined
  mode: McpMode | undefined
  onChange: (mode: McpMode | null) => void
}) {
  // An id the workspace no longer offers stays listed, and stays in the
  // selection until the user removes it: a start would report it unroutable,
  // which is a thing to see here rather than in the session log.
  const missing = !entry
  // Selecting this runs a process on the user's machine, so the field says so
  // where the choice is made (docs/requirements-mcp-stdio.md §2).
  const local = !!entry && entry.source === 'registry' && isLocalMcpEntry(entry.entry)
  return (
    <div className="sel-row-wrap">
      <div
        className="sel-row"
        title={
          missing
            ? `"${id}" is selected but this workspace no longer offers it — it is not a built-in and not in the registry`
            : entry.description
        }
      >
        <Dot tone={missing ? 'red' : 'green'} size={7} />
        <span className="mcp-name">{entry?.label ?? id}</span>
        <span className="mcp-desc faint">
          {missing ? 'unavailable — not a built-in, not in the registry' : entry.description}
        </span>
        {entry && mcpHasModes(entry) && (
          <div className="chip-row icon-fixed">
            {(['read-only', 'full'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={`chip-btn ${mode === m ? 'on' : ''}`}
                onClick={() => onChange(m)}
              >
                {m}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className="chip-x"
          title="remove"
          aria-label={`remove ${entry?.label ?? id}`}
          onClick={() => onChange(null)}
        >
          ×
        </button>
      </div>
      {local && <div className="mcp-local-note">{LOCAL_MCP_NOTICE}</div>}
    </div>
  )
}

/** A picked skill, listed under the field. A skill whose `SKILL.md` does not
 *  parse is still selectable: it says what is wrong instead of what it does,
 *  and Settings is where it gets fixed. A selected skill the workspace no
 *  longer holds stays listed (and selected) until removed, because a start
 *  would report it as not mounted. */
function SkillSelectedRow({
  name,
  entry,
  onRemove
}: {
  name: string
  entry: SkillEntry | undefined
  onRemove: () => void
}) {
  const missing = !entry
  const text = missing ? "unavailable — not in this workspace's skills" : (entry.problem ?? entry.description)
  return (
    <div className="sel-row-wrap">
      <div
        className="sel-row"
        title={
          missing
            ? `"${name}" is selected but this workspace no longer offers it — it is not in the skill registry`
            : text
        }
      >
        <Dot tone={missing || entry.problem ? 'red' : 'green'} size={7} />
        <span className="mcp-name">{name}</span>
        <span className="mcp-desc faint">{text}</span>
        <button
          type="button"
          className="chip-x"
          title="remove"
          aria-label={`remove ${name}`}
          onClick={() => onRemove()}
        >
          ×
        </button>
      </div>
    </div>
  )
}

/** `https://github.com/acme/checkout-web.git` → `acme/checkout-web`. */
function shortRepoUrl(url: string): string {
  const cleaned = url.replace(/\.git$/, '').replace(/\/+$/, '')
  return /[:/]([^:/]+\/[^:/]+)$/.exec(cleaned)?.[1] ?? cleaned
}

/** How a repo reads in a chip: a local repo's url is a storage path nobody
 *  needs to see, so it goes by its name (docs/requirements-new-projects.md §2). */
const repoChipLabel = (r: RepoConfig): string => (r.local ? r.name : shortRepoUrl(r.url))

/** One agent option as chips — model, effort, a toggle — the same block for
 *  the session's own picks and for the Review block's reviewer. `values` are
 *  the picks over what the agent reports; `kind` decides how the kind presents
 *  its options (`AgentOptionView`). */
function OptionBlock({
  opt,
  values,
  kind,
  onPick
}: {
  opt: SessionConfigOption
  values: Record<string, string | boolean>
  kind: string | undefined
  onPick: (opt: SessionConfigOption, value: string | boolean) => void
}) {
  const view = agentOptionView(kind)
  const effective = view.activeValue({ ...opt, currentValue: values[opt.id] ?? opt.currentValue })
  const label =
    opt.category === 'model' ? 'MODEL' : opt.category === 'thought_level' ? 'EFFORT' : opt.name.toUpperCase()
  if (opt.type === 'select') {
    // The picked option's description rides the label's info dot, not a note
    // row — the hint is a hover away and the block stays one line of chips.
    const description = opt.options?.find((o) => o.value === effective)?.description ?? undefined
    return (
      <div className="hc-block">
        <div className="seclabel-row">
          <span className="seclabel">{label}</span>
          {description && <InfoDot text={description} />}
        </div>
        <div className="chip-row">
          {view.selectOptions(opt).map((o) => (
            <button
              key={o.value}
              type="button"
              className={`chip-btn ${effective === o.value ? 'on' : ''}`}
              title={o.description ?? undefined}
              onClick={() => onPick(opt, o.value)}
            >
              {o.name}
            </button>
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className="hc-block">
      <div className="seclabel-row">
        <span className="seclabel">{label}</span>
        {opt.description && <InfoDot text={opt.description} />}
      </div>
      <div className="chip-row">
        <button
          type="button"
          className={`chip-btn ${effective === true ? 'on' : ''}`}
          onClick={() => onPick(opt, true)}
        >
          on
        </button>
        <button
          type="button"
          className={`chip-btn ${effective === false ? 'on' : ''}`}
          onClick={() => onPick(opt, false)}
        >
          off
        </button>
      </div>
    </div>
  )
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
  // Only for a record that predates the setting: a draft created now always
  // carries one (App.tsx), and it is internal. Absent reads as open everywhere
  // downstream (proxy/manager.ts), so an old draft keeps the mode it has been
  // running under instead of changing under it.
  const network = info.network ?? { internal: false }
  const autoAllow = info.autoAllow ?? true
  const configValues = info.configValues ?? {}
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null)
  /** Global masking config; null until it loads. `ready` is what makes the
   *  chip usable at all (docs/requirements-pii-mask.md §5.2). */
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [picker, setPicker] = useState<'env' | 'client' | 'role' | null>(null)
  const [error, setError] = useState('')
  const [reviewerMenu, setReviewerMenu] = useState(false)
  const rv = useReviewBlock(tree, info)

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

  const latest = useRef(info)
  latest.current = info
  const patch = (p: SessionDraftPatch): void => {
    window.gurt
      .sessionEditDraft(info.id, p)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  // --- the Review block (docs/requirements-review-loop.md §3) --------------
  // An executor's alone. Prefilled from the anchor repo's defaults — the first
  // `write` repo, which builds the session's image — by `useReviewBlock` in the
  // session pane, whichever tab is showing; a user who switched it off
  // (`reviewOff`) or edited it is not overruled by a later pick.
  const isExecutor = role === 'executor'
  const review = isExecutor ? info.review : undefined
  const patchReview = (next: Partial<ReviewLoopConfig>): void => {
    if (review) patch({ review: { ...review, ...next } })
  }
  const pickReviewer = (id: string): void => {
    // The new reviewer reports its own options: the old picks do not carry.
    patchReview({ agent: id, configValues: undefined })
    setReviewerMenu(false)
  }
  const setLoop = (on: boolean): void => {
    // Off is a choice even when there is no block to drop: the anchor's
    // `review.enabled` default must not prefill one afterwards.
    if (on) {
      if (!review) patch({ review: rv.seed() })
    } else if (review || !info.reviewOff) patch({ review: null })
  }
  const reviewerKind = agentKind(agents, review?.agent)
  const reviewerOptions = (rv.reviewerConfig?.configOptions ?? []).filter((o) => o.category !== 'mode')
  const rungs = rv.ladder
  const rungShown = review ? (rungs.includes(review.whenClean) ? review.whenClean : undefined) : undefined

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

  // Picking a (different) env re-seeds the session repo from that env's
  // default while the draft holds at most one — a hand-built list of several
  // is the user's, and an env pick never throws it away.
  const pickEnv = (name: string) => {
    // A proactive agent's template keeps its repos whatever env it runs on:
    // they are context it reads, not the clone an env is built from.
    if (role === 'proactive' || repos.length > 1) {
      patch({ env: name })
      setPicker(null)
      return
    }
    // The base image claims no repo — it exists for whatever repo is picked, a
    // freshly created one most of all — so picking it keeps the selection.
    if (name === BASE_ENV_NAME) {
      patch({ env: name })
      setPicker(null)
      return
    }
    const def = envs.find((e) => e.name === name)?.repo
    // The repo it replaces hands over its mode, so swapping the env of a
    // `write` draft keeps it writable.
    const [prev] = repos
    patch({
      env: name,
      repos: def ? [def] : [],
      ...(def && prev ? { repoModes: { [def]: repoMode(info, prev) } } : {})
    })
    setPicker(null)
  }

  // The role decides the tool set alone — it never touches the repos, their
  // modes or the env (docs/requirements-repo-mounts.md §4).
  const pickRole = (next: SessionRole) => {
    patch({ role: next })
    setPicker(null)
  }

  // Always multi-select: any session may hold any number of repos. A new pick
  // takes the default mode; the host fills it in.
  // Add and remove, not a toggle: both are idempotent, so a second click on
  // × before the snapshot lands cannot put the repo back.
  const setRepoPicked = (name: string, picked: boolean): void => {
    if (repos.includes(name) === picked) return
    patch({ repos: picked ? [...repos, name] : repos.filter((n) => n !== name) })
  }
  const setMode = (name: string, mode: RepoMode) => patch({ repoModes: { [name]: mode } })
  const repoGap = missingRepoReason(info)

  // A new local repo, made right here and picked at once — and, being new, it
  // has no env, so a draft with no env yet gets the base image. It is a workspace repo from then
  // on, offered to every later session like any other.
  // Resolves to whether it worked, so the field keeps the typed name on failure.
  // Resolves to whether the new repo ended up picked, so the field keeps the
  // typed name when it did not.
  const createRepo = async (typed: string): Promise<boolean> => {
    const name = typed.trim()
    if (!name) return false
    try {
      const created = await window.gurt.createLocalRepo(info.workspace, name)
      const now = latest.current
      await window.gurt.sessionEditDraft(info.id, {
        repos: now.repos.includes(created.name) ? now.repos : [...now.repos, created.name],
        ...(now.env ? {} : { env: BASE_ENV_NAME })
      })
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    }
  }

  const mcpMode = (id: string): McpMode | undefined => mcp.find((m) => m.id === id)?.mode
  const setMcpMode = (id: string, mode: McpMode | null): void => {
    patch({
      mcp:
        mode == null
          ? mcp.filter((m) => m.id !== id)
          : mcp.some((m) => m.id === id)
            ? mcp.map((m) => (m.id === id ? { id, mode } : m))
            : [...mcp, { id, mode }]
    })
  }

  // The `mcpHasModes` rule again: gurt does not claim what it cannot deliver.
  // A kind whose pinned CLI reads no skills directory (`AgentManifest.skillsDir` is
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

  const setConfig = (opt: SessionConfigOption, value: string | boolean) =>
    patch({ configValues: { ...configValues, [opt.id]: value } })
  const cfgOptions = (agentConfig?.configOptions ?? []).filter((o) => o.category !== 'mode')

  // MODEL/EFFORT are pulled out of `cfgOptions` into the always-visible
  // BEHAVIOR section below; whatever else an agent reports (rare) stays in
  // the collapsed panel with MCP and the rest.
  const behaviorOptions = cfgOptions.filter((o) => o.category === 'model' || o.category === 'thought_level')
  const advancedOptions = cfgOptions.filter((o) => o.category !== 'model' && o.category !== 'thought_level')
  const configBlock = (opt: SessionConfigOption): ReactNode => (
    <OptionBlock
      key={opt.id}
      opt={opt}
      values={configValues}
      kind={agentKind(agents, info.agent)}
      onPick={setConfig}
    />
  )

  return (
    <div className="ns-body">
      {/* role + agent, env + repo — packed two-up instead of four full-width
          rows. Role still leads (it governs the repository picker,
          docs/requirements-session-roles.md), and each field's explanation
          lives behind the label's info dot rather than a note row. */}
      <div className="cfg-grid">
        <div className="cfg-cell">
          <div className="seclabel-row">
            <span className="seclabel">ROLE</span>
            <InfoDot text={ROLE_INFO[role].hint} />
          </div>
          {!USER_SESSION_ROLES.includes(role) ? (
            // A proactive agent's template is that role for good: the agent
            // exists to copy it into runs (docs/design-proactive-agents.md §2).
            // So is a loop's reviewer: only the loop creates one
            // (docs/requirements-review-loop.md §4).
            <button type="button" className="pick-row" disabled aria-disabled="true">
              <Icon name={ROLE_INFO[role].icon} size={14} className="dim icon-fixed" />
              <span className="pick-value strong">{ROLE_INFO[role].label}</span>
              <span className="spacer" />
            </button>
          ) : (
          <PickRow
            open={picker === 'role'}
            onToggle={() => setPicker(picker === 'role' ? null : 'role')}
            onClose={() => setPicker(null)}
            menu={USER_SESSION_ROLES.map((r) => (
              <div
                key={r}
                className={`menu-item ${r === role ? 'active' : ''}`}
                title={ROLE_INFO[r].hint}
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
            <Icon name={ROLE_INFO[role].icon} size={14} className="dim icon-fixed" />
            <span className="pick-value strong">{ROLE_INFO[role].label}</span>
            <span className="spacer" />
          </PickRow>
          )}
        </div>

        {/* agent — which client/harness runs the session */}
        <div className="cfg-cell">
          <div className="seclabel-row">
            <span className="seclabel">AGENT</span>
          </div>
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
                    <AgentIcon kind={a.kind} size={12} className="faint" />
                    {a.label}
                  </div>
                ))
              ) : (
                <div className="menu-empty">no clients — add one in Settings → Clients</div>
              )
            }
          >
            {info.agent ? (
              <>
                <Dot tone="green" size={7} />
                <span className="pick-value strong">
                  <AgentMark kind={agentKind(agents, info.agent)} name={agentName(agents, info.agent)} />
                </span>
              </>
            ) : (
              <span className="pick-value faint">pick a client</span>
            )}
            <span className="spacer" />
          </PickRow>
        </div>

        <div className="cfg-cell">
          <div className="seclabel-row">
            <span className="seclabel">ENVIRONMENT</span>
          </div>
          <PickRow
            open={picker === 'env'}
            onToggle={() => setPicker(picker === 'env' ? null : 'env')}
            onClose={() => setPicker(null)}
            menu={
              <>
                {/* The base image: always startable, runs any repo — a new one
                    with no env of its own included. */}
                <div
                  className={`menu-item ${info.env === BASE_ENV_NAME ? 'active' : ''}`}
                  title="the base image (Settings → Environments)"
                  onMouseDown={(ev) => {
                    ev.preventDefault()
                    pickEnv(BASE_ENV_NAME)
                  }}
                >
                  <Icon name="box" size={13} className="dim icon-fixed" />
                  {BASE_ENV_NAME}
                  <span className="menu-meta mono">base image</span>
                </div>
                {envs.length ? (
                  envs.map((e) => (
                    <div
                      key={e.name}
                      className={`menu-item ${e.name === info.env ? 'active' : ''}`}
                      onMouseDown={(ev) => {
                        ev.preventDefault()
                        pickEnv(e.name)
                      }}
                    >
                      <Icon name="box" size={13} className="dim icon-fixed" />
                      {e.name}
                      {e.repo && <span className="menu-meta mono">{e.repo}</span>}
                    </div>
                  ))
                ) : null}
              </>
            }
          >
            <Icon name="box" size={14} className="dim icon-fixed" />
            <span className="pick-value strong">{info.env || 'pick an environment'}</span>
            <span className="spacer" />
          </PickRow>
        </div>

        {/* session repositories — seeded from the env's default, changeable
            here, any number of them, each with its own mount mode
            (docs/requirements-repo-mounts.md §6). The notes stay visible
            rather than moving behind the info dot: they block Run/Queue.
            Same field as MCP and skills — only what an item is differs. */}
        <PickerField
          label="REPOSITORIES"
          info="each repository is mounted the way its row says: write — read-write, holds the clone exclusively; read with a lock — read-only, the tree does not move while this session runs; read — read-only, blocks nobody"
          icon="branch"
          placeholder={repos.length ? 'add another repository' : 'pick a repository'}
          items={allRepos.map((r) => ({
            id: r.name,
            label: r.name,
            meta: r.local ? 'local' : shortRepoUrl(r.url)
          }))}
          selected={repos}
          onPick={(name) => setRepoPicked(name, true)}
          emptyText="no repositories yet — type a name to create a local one"
          create={{
            label: (name) => `new local repository "${name}"`,
            title:
              'a repository kept by gurt on this machine — no forge needed; publish it later from Settings → Repos',
            onCreate: createRepo
          }}
          // One row per picked repo: its name, its mode, its remove. A
          // proactive run's repos are always read — the control says so
          // instead of offering a choice.
          renderSelected={(name) => {
            const cfg = allRepos.find((r) => r.name === name)
            const mode = repoMode(info, name)
            return (
              <div className="repo-mode-row" key={name}>
                <div className="repo-mode-head">
                  <Icon name="branch" size={11} className="faint icon-fixed" />
                  <span className="repo-mode-name">{cfg ? repoChipLabel(cfg) : name}</span>
                  <span className="spacer" />
                  <button
          type="button"
          className="chip-x"
          title="remove"
          aria-label={`remove ${name}`}
          onClick={() => setRepoPicked(name, false)}
        >
          ×
        </button>
                </div>
                <div className="repo-mode-seg" role="radiogroup" aria-label={`${name} mount mode`}>
                  {REPO_MODES.map((m) => (
                    <button
                      type="button"
                      key={m}
                      role="radio"
                      data-mode={m}
                      aria-checked={mode === m}
                      className={`chip-btn ${mode === m ? 'on' : ''}`}
                      title={REPO_MODE_INFO[m].hint}
                      disabled={roleForcesRead(role)}
                      onClick={() => mode !== m && setMode(name, m)}
                    >
                      {REPO_MODE_INFO[m].locked && <Icon name="lock" size={10} className="icon-fixed" />}
                      {REPO_MODE_INFO[m].label}
                    </button>
                  ))}
                </div>
              </div>
            )
          }}
          footer={
            <>
              {repoGap && (
                <div className="hc-note">
                  {repos.length
                    ? 'no repository mounted for write — an executor cannot Run/Queue until one is'
                    : 'no repository — Run/Queue disabled until you pick one'}
                </div>
              )}
              {role === 'proactive' && (
                <div className="hc-note">optional — repos are read-only context for each run</div>
              )}
            </>
          }
        />

        <PickerField
          label="MCP"
          info="servers the agent may call. Picked means on, not picked means off. A built-in can be limited to read-only; a registry entry is all or nothing — gurt cannot tell which of an upstream's tools write."
          icon="plug"
          placeholder={mcp.length ? 'add another server' : 'pick an MCP server'}
          items={mcpOffered.map((e) => ({
            id: e.id,
            label: e.label,
            meta: e.description,
            title: e.description,
            warning: e.source === 'registry' && isLocalMcpEntry(e.entry) ? LOCAL_MCP_NOTICE : undefined
          }))}
          selected={mcp.map((m) => m.id)}
          onPick={(id) => setMcpMode(id, 'full')}
          emptyText="no MCP servers in this workspace — add one in Settings → MCP"
          renderSelected={(id) => {
            const entry = mcpOffered.find((e) => e.id === id)
            return (
              <McpSelectedRow
                key={id}
                id={id}
                entry={entry}
                mode={mcpMode(id)}
                onChange={(mode) => setMcpMode(id, mode)}
              />
            )
          }}
        />

        <PickerField
          label="SKILLS"
          info="skill directories mounted for the agent. Picked means on, not picked means off. A skill in the repository's own .claude/skills is the repo's and is not listed here."
          icon="sliders"
          placeholder={
            skillsUnsupported
              ? 'not supported by this agent'
              : skills.length
                ? 'add another skill'
                : 'pick a skill'
          }
          items={skillsOffered.map((e) => ({
            id: e.name,
            label: e.name,
            meta: e.problem ?? e.description,
            title: e.problem ?? e.description
          }))}
          selected={skills.map((k) => k.name)}
          onPick={(name) => setSkill(name, true)}
          emptyText="no skills in this workspace — add one in Settings → Skills"
          disabled={skillsUnsupported}
          renderSelected={(name) => (
            <SkillSelectedRow
              key={name}
              name={name}
              entry={skillsOffered.find((e) => e.name === name)}
              onRemove={() => setSkill(name, false)}
            />
          )}
          footer={
            skillsUnsupported ? (
              <div className="hc-note">
                {draftAgentDef?.label} does not support skills — nothing would be mounted.
                {skills.length ? ' Your selection is kept and applies if you pick an agent that does.' : ''}
              </div>
            ) : null
          }
        />
      </div>

      {/* behavior — the fields changed most often (model/effort) plus the
          auto/manual safety toggle, always visible rather than a click away.
          No "BEHAVIOR" umbrella label: it rendered identically to the block
          labels under it and read as noise, and MODEL/EFFORT/MODE say enough
          on their own. */}
      <div className="ns-section">
        {behaviorOptions.map(configBlock)}
        <div className="hc-block">
          <div className="seclabel-row">
            <span className="seclabel">MODE</span>
            <InfoDot text="auto lets the agent's tool calls run without asking; manual stops to confirm each one." />
          </div>
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

      {/* network — a capability boundary like MODE, not tuning, so it stays
          out of the collapsed panel. (Same umbrella-label removal as above:
          "PERMISSIONS" duplicated the block labels' style for no information.) */}
      <div className="ns-section">
        <NetworkPicker network={network} onChange={(next) => patch({ network: next })} />
      </div>

      {/* review loop — an executor's alone (docs/requirements-review-loop.md §3):
          the standing approval for the reviewer sessions and for what a clean
          result ships. Frozen when the session starts, so it lives here and
          not in the live knobs; never part of an agent's request. */}
      {isExecutor && (
        <div className="ns-section review-block">
          <div className="hc-block">
            <div className="seclabel-row">
              <span className="seclabel">REVIEW LOOP</span>
              <InfoDot text="after the executor finishes, gurt runs the repo's check and has a read-only reviewer on another agent or model read the change; the executor fixes what it agrees with, for up to the rounds below. On a clean review gurt does what “when clean” says. Fixed when the session starts." />
            </div>
            <ChoiceGroup
              label="review loop"
              choices={[
                { value: false, text: 'off' },
                { value: true, text: 'on' }
              ]}
              value={!!review}
              onPick={setLoop}
            />
          </div>
          {review && (
            <>
              <div className="hc-block">
                <div className="seclabel-row">
                  <span className="seclabel">REVIEWER</span>
                  <InfoDot text="another agent than the executor by default — a reviewer from the same family tends to favour its own output. Only agents that receive gurt's tools can review." />
                </div>
                <PickRow
                  open={reviewerMenu}
                  onToggle={() => setReviewerMenu((o) => !o)}
                  onClose={() => setReviewerMenu(false)}
                  accessible
                  menu={
                    rv.candidates.length ? (
                      rv.candidates.map((id) => (
                        <button
                          key={id}
                          type="button"
                          className={`menu-item ${id === review.agent ? 'active' : ''}`}
                          aria-pressed={id === review.agent}
                          onClick={() => pickReviewer(id)}
                        >
                          <Dot tone="green" size={7} />
                          <AgentIcon kind={agents[id]?.kind} size={12} className="faint" />
                          {agents[id]?.label ?? id}
                        </button>
                      ))
                    ) : (
                      <div className="menu-empty">no agent can review — add one in Settings → Clients</div>
                    )
                  }
                >
                  {review.agent ? (
                    <>
                      <Dot tone={agents[review.agent] && !deniedAgents.includes(review.agent) ? 'green' : 'red'} size={7} />
                      <span className="pick-value strong">
                        <AgentMark kind={reviewerKind} name={agentName(agents, review.agent)} />
                      </span>
                    </>
                  ) : (
                    <span className="pick-value faint">pick a reviewer</span>
                  )}
                  <span className="spacer" />
                </PickRow>
              </div>
              {reviewerOptions.map((opt) => (
                <OptionBlock
                  key={opt.id}
                  opt={opt}
                  values={review.configValues ?? {}}
                  kind={reviewerKind}
                  onPick={(o, value) => patchReview({ configValues: { ...(review.configValues ?? {}), [o.id]: value } })}
                />
              ))}
              <div className="hc-block">
                <div className="seclabel-row">
                  <span className="seclabel">ROUNDS</span>
                  <InfoDot text="reviewers the loop may start — each reads the work fresh. If the last one still asks for changes, the loop ends and shows what is open." />
                </div>
                <ChoiceGroup
                  label="review rounds"
                  dataKey="rounds"
                  choices={REVIEW_ROUNDS.map((n) => ({ value: n, text: n }))}
                  value={review.maxRounds}
                  onPick={(n) => patchReview({ maxRounds: n })}
                />
              </div>
              <div className="hc-block">
                <div className="seclabel-row">
                  <span className="seclabel">WHEN CLEAN</span>
                  <InfoDot text="what gurt does after an approving review and a green check. Each step includes the ones before it. Nothing is ever merged on a forge; a review that is not clean commits nothing." />
                </div>
                <ChoiceGroup
                  label="when clean"
                  dataKey="rung"
                  choices={rungs.map((r) => ({ value: r, text: RUNG_LABEL[r] }))}
                  value={rungShown}
                  onPick={(r) => patchReview({ whenClean: r })}
                />
                {review.whenClean === 'pr' && rungs.includes('pr') && (
                  <label className="rv-check">
                    <input
                      type="checkbox"
                      checked={review.draftPr}
                      onChange={(e) => patchReview({ draftPr: e.target.checked })}
                    />
                    <span>open the PR as a draft</span>
                  </label>
                )}
                {review.whenClean !== 'notify' && (
                  <label className="rv-check" title="The loop waits until you approve the reviewed changes in the Diff view; any later change drops the approval">
                    <input
                      type="checkbox"
                      data-testid="rv-manual-approval"
                      checked={review.manualApproval === true}
                      onChange={(e) => patchReview({ manualApproval: e.target.checked })}
                    />
                    <span>wait for my approval in the Diff view before shipping</span>
                  </label>
                )}
                {rv.writeRepos.length === 0 && (
                  <div className="hc-note">no repository mounted for write yet — the steps offered depend on it</div>
                )}
                {rv.writeRepos.length > 0 && !rungs.includes('push') && !rungs.includes('merge') && rv.writeRepos.length > 1 && (
                  <div className="hc-note">repositories on a forge and local ones together can be committed, not shipped further</div>
                )}
              </div>
              {rv.writeRepos.length > 0 && rv.checkless.length > 0 && (
                <div className="hc-note hc-warn" data-testid="review-checkless">
                  no check configured for {rv.checkless.join(', ')} — the check is skipped: no tests run before review
                  (set one in Settings → Repos)
                </div>
              )}
              {rv.problem && (
                <div className="hc-note hc-warn" data-testid="review-problem">
                  {rv.problem} — Run is disabled until this is fixed
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* advanced — everything left: rare agent-reported options and
          reset. Same fold shape as the network
          section above — an inline subfold label, not a full-width button —
          and the opened content sits flat in the section, no card around it. */}
      <div className="ns-section">
        <div className="hc-block">
          <div className="seclabel-row">
            <button type="button" className="subfold" onClick={() => setAdvancedOpen((o) => !o)}>
              <Icon
                name="chevron"
                size={11}
                className={`icon-fixed ${advancedOpen ? '' : 'chev-closed'}`}
              />
              advanced
            </button>
          </div>
        </div>
        {advancedOpen && (
          <>
            {advancedOptions.map(configBlock)}
            <div className="hc-foot">
              <span className="spacer" />
              <button
                className="btn btn-sm"
                onClick={() =>
                  patch({ autoAllow: true, mcp: [], skills: [], network: { internal: true } })
                }
              >
                Reset
              </button>
            </div>
          </>
        )}
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
        <InfoDot text="role, environment, repository, MCP, skills and network are fixed once a session leaves draft — duplicate it to change them and start over" />
      </div>
      {skillsUnsupported && skills.length > 0 && (
        <div className="hc-note">
          {liveAgentDef?.label} does not support skills — the {skills.length} selected{' '}
          {skills.length === 1 ? 'skill was' : 'skills were'} not mounted
        </div>
      )}
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
  // Blanket bypass modes are hidden, same as the composer's gear popup
  // (Chat.tsx) — see `isBlanketMode`.
  const modeWords = agentVocabulary(kind).modes
  const liveModes = modes ? modes.availableModes.filter((m) => !isBlanketMode(m, modeWords)) : []
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
