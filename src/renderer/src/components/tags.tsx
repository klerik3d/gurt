// Environment and repository labels. An env is normally named after the repo it
// serves, so the two labels read identically when they sit side by side — the
// leading icon is what tells them apart. `box` = env, `branch` = repo, the same
// marks the env/repository pickers use in the new-session sidebar.

import { Icon, type IconName } from './icons'

/** kind (an `AgentDef.id`) → glyph. Unmatched/custom kinds fall back to a
 *  generic mark rather than breaking — agents.json can outlive this map. */
const AGENT_ICONS: Record<string, IconName> = {
  'claude-code': 'agent-claude',
  codex: 'agent-codex',
  opencode: 'agent-opencode'
}

export const agentIcon = (kind?: string): IconName => (kind && AGENT_ICONS[kind]) || 'agent-generic'

export function EnvTag({ name }: { name: string }): JSX.Element {
  return (
    <span className="tag tag-ico" title={`environment ${name}`}>
      <Icon name="box" size={10} />
      {name}
    </span>
  )
}

export function RepoTag({ name, title }: { name: string; title?: string }): JSX.Element {
  return (
    <span className="tag tag-ico" title={title ?? `repository ${name}`}>
      <Icon name="branch" size={10} />
      {name}
    </span>
  )
}

/** Agent-kind tag — same pill as `EnvTag`/`RepoTag`, marked with the kind's glyph. */
export function AgentTag({
  kind,
  name,
  title
}: {
  kind?: string
  name: string
  title?: string
}): JSX.Element {
  return (
    <span className="tag tag-ico" title={title ?? name}>
      <Icon name={agentIcon(kind)} size={10} />
      {name}
    </span>
  )
}

/** Unpilled agent mark for inline mentions (chat header, session list, palette). */
export function AgentMark({ kind, name }: { kind?: string; name: string }): JSX.Element {
  return (
    <span className="agent-mark">
      <Icon name={agentIcon(kind)} size={11} className="faint" />
      {name}
    </span>
  )
}

/** The same pair unpilled, for the header pills and the footer — the chip around
 *  them already carries the frame, and both lay their children out with a gap.
 *  `task`, when given alongside `repo`, appends the task's branch name — every
 *  clone's task branch is named `gurt/<task>` (see `branchFor` in changes.ts). */
export function EnvRepoMarks({
  env,
  repo,
  task
}: {
  env: string
  repo?: string
  task?: string
}): JSX.Element {
  return (
    <>
      <Icon name="box" size={11} className="faint" />
      {env}
      {repo && (
        <>
          <Icon name="branch" size={11} className="faint" />
          {repo}
        </>
      )}
      {repo && task && <span className="dim">gurt/{task}</span>}
    </>
  )
}
