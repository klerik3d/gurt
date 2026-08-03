// Environment and repository labels. An env is normally named after the repo it
// serves, so the two labels read identically when they sit side by side — the
// leading icon is what tells them apart. `box` = env, `branch` = repo, the same
// marks the env/repository pickers use in the new-session sidebar.

import { Icon } from './icons'

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

/** The same pair unpilled, for the header pills and the footer — the chip around
 *  them already carries the frame, and both lay their children out with a gap. */
export function EnvRepoMarks({ env, repo }: { env: string; repo?: string }): JSX.Element {
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
    </>
  )
}
