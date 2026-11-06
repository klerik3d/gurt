import { useCallback, useEffect, useState } from 'react'
import type { Tree } from '../../../../shared/types'
import type { SkillEntry } from '../../../../shared/skills'
import { skillNameProblem, skillTemplate, validateSkillDoc } from '../../../../shared/skills'
import { confirmDialog } from '../../dialog'
import { Modal } from '../Modal'
import { run } from '../../async'

/**
 * The workspace's skill registry (docs/requirements-skills.md §7).
 *
 * Modelled on `McpServersSection`, and different in one place: the "enabled by
 * default" toggle lives on the *row*, not in the editor, because it is a
 * property of the workspace (`defaultSkills`) rather than of the skill — the
 * same reason `AgentAccessSection` puts "set default" beside each client
 * instead of inside the client's form.
 */
export function SkillsSection({ tree, ws }: { tree: Tree | null; ws: string | null }) {
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const [editing, setEditing] = useState<SkillEntry | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const defaults = new Set(tree?.workspaces.find((w) => w.name === ws)?.defaultSkills ?? [])

  const refresh = useCallback(() => {
    if (!ws) {
      setSkills([])
      return
    }
    window.gurt
      .getSkills(ws)
      .then(setSkills)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [ws])

  // Every registry write announces itself on tree.changed (ipc.ts), the same
  // signal the repo/env/MCP lists ride.
  useEffect(() => {
    refresh()
    return window.gurt.onTreeChanged(refresh)
  }, [refresh])

  const toggleDefault = async (name: string) => {
    if (!ws) return
    setError('')
    const next = defaults.has(name)
      ? [...defaults].filter((n) => n !== name)
      : [...defaults, name]
    try {
      await window.gurt.setDefaultSkills(ws, next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      <div className="set-head">
        <div className="set-title-wrap">
          <span className="set-title">Skills</span>
          <span className="set-count mono">
            {skills.length} skill{skills.length === 1 ? '' : 's'}
            {ws ? ` · ${ws}` : ''}
          </span>
        </div>
        <span className="spacer" />
        <button className="btn btn-primary" disabled={!ws} onClick={() => setAdding(true)}>
          + Add
        </button>
      </div>
      <div className="set-list">
        {skills.map((k) => (
          <div key={k.name} className="set-row">
            <span className="set-row-label mono">{k.name}</span>
            <span
              className="set-row-url"
              // `.set-row-url` wins the cascade over `.error`, so the colour is
              // set here rather than by stacking the two classes.
              style={k.problem ? { color: 'var(--red)' } : undefined}
              title={k.problem ?? k.description}
            >
              {k.problem ?? k.description}
            </span>
            {k.files.length > 0 && (
              <span className="mono faint" title={k.files.join('\n')}>
                +{k.files.length} file{k.files.length === 1 ? '' : 's'}
              </span>
            )}
            <span className="spacer" />
            <button
              type="button"
              className={`btn-link ${defaults.has(k.name) ? 'active' : ''}`}
              disabled={!ws}
              title="switch this skill on in every new draft of this workspace"
              onClick={() => void toggleDefault(k.name)}
            >
              {defaults.has(k.name) ? 'default ✓' : 'enable by default'}
            </button>
            <button className="btn-link" onClick={() => setEditing(k)}>
              edit
            </button>
          </div>
        ))}
        {skills.length === 0 && (
          <div className="tp-dashed">
            no skills yet — add one to offer it to this workspace&apos;s sessions
          </div>
        )}
        <div className="set-sub">
          Stored under ~/.gurt/{ws || '<workspace>'}/skills and mounted read-only into a
          session&apos;s container. A repository&apos;s own .claude/skills is the repository&apos;s
          — gurt neither lists nor disables those.
        </div>
        {error && <div className="error">{error}</div>}
      </div>
      {(editing || adding) && ws && (
        <SkillModal
          key={editing?.name ?? '__new'}
          ws={ws}
          taken={skills.filter((k) => k.name !== editing?.name).map((k) => k.name)}
          initial={editing ?? undefined}
          onClose={() => {
            setEditing(null)
            setAdding(false)
            refresh()
          }}
        />
      )}
    </>
  )
}

/** Name + `SKILL.md`. The document is validated as it is typed — with the same
 *  function the store runs at save, so the verdict previewed here is the
 *  verdict that decides — and the supporting files found beside it are listed
 *  read-only, so a skill whose body points at `references/x.md` shows whether
 *  that file actually travels with it. */
function SkillModal({
  ws,
  taken,
  initial,
  onClose
}: {
  ws: string
  /** The other skills' names — uniqueness is previewed here and enforced in the
   *  store. */
  taken: string[]
  initial?: SkillEntry | undefined
  onClose: () => void
}) {
  const editing = !!initial
  const [name, setName] = useState(initial?.name ?? '')
  const [doc, setDoc] = useState('')
  const [loaded, setLoaded] = useState(!editing)
  const [error, setError] = useState('')

  // An existing skill's body is fetched on open rather than carried in the
  // list: `getSkills` is read on every tree.changed by two other surfaces, and
  // whole documents have no business in that payload.
  useEffect(() => {
    if (!initial) {
      setDoc(skillTemplate(''))
      return
    }
    let live = true
    window.gurt
      .getSkillDoc(ws, initial.name)
      .then((text) => {
        if (!live) return
        setDoc(text)
        setLoaded(true)
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [ws, initial])

  const clean = name.trim()
  const nameProblem = skillNameProblem(clean, taken)
  // Only once the document is the user's: an editor still fetching would
  // otherwise flash the template's mismatched name as an error.
  const docProblem = loaded && !nameProblem ? validateSkillDoc(clean, doc).error : undefined
  const invalid = nameProblem ?? docProblem

  const save = async () => {
    setError('')
    try {
      await (editing
        ? window.gurt.updateSkill(ws, clean, doc)
        : window.gurt.addSkill(ws, clean, doc))
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const del = async () => {
    setError('')
    // Asked before the confirm, not after: the store refuses this delete, so a
    // dialog offering to go ahead anyway would be offering something that
    // cannot happen (docs/requirements-skills.md §7).
    const used = await window.gurt.skillUsedBy(ws, initial!.name).catch(() => [] as string[])
    if (used.length) {
      setError(
        `selected by session(s) in scope(s): ${used.join(', ')} — unselect it there first`
      )
      return
    }
    if (
      !(await confirmDialog(
        `Delete skill "${initial!.name}"? Its directory and every supporting file in it go with it.`,
        { title: 'Delete skill', confirmText: 'Delete', danger: true }
      ))
    )
      return
    try {
      await window.gurt.removeSkill(ws, initial!.name)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal title={editing ? 'Edit skill' : 'New skill'} width={620} onClose={onClose}>
      <div className="modal-body env-modal">
        <label className="fld">
          <span className="seclabel">NAME</span>
          <input
            className="input mono"
            placeholder="review-checklist"
            value={name}
            // Immutable once saved: the name is the directory, and it is what
            // every session's selection stores.
            disabled={editing}
            onChange={(e) => {
              const next = e.target.value
              // Keep the template's frontmatter in step while it is still the
              // template — otherwise a fresh form is invalid the moment the
              // first character is typed, which reads as the editor being broken.
              setDoc((prev) => (prev === skillTemplate(name) ? skillTemplate(next) : prev))
              setName(next)
            }}
          />
          <span className="fld-hint">
            {editing
              ? 'fixed — a session selects a skill by name; add a new one to rename'
              : 'lowercase letters, digits and single hyphens; it is the directory name and the frontmatter `name`'}
          </span>
        </label>

        <div className="fld">
          <span className="seclabel">SKILL.md</span>
          <textarea
            className="input mono snippet-input"
            rows={18}
            spellCheck={false}
            value={doc}
            onChange={(e) => setDoc(e.target.value)}
          />
          <span className="fld-hint">
            YAML frontmatter (`name`, `description`) over the markdown body. The description is all
            the agent reads until it decides to open the body — write it as a trigger, not a title.
          </span>
        </div>

        {!!initial?.files.length && (
          <div className="fld">
            <span className="seclabel">SUPPORTING FILES</span>
            <span className="fld-hint mono">{initial.files.join('  ·  ')}</span>
            <span className="fld-hint">
              Found beside SKILL.md and mounted with it. Add or remove them in the directory itself
              — this editor writes SKILL.md and nothing else.
            </span>
          </div>
        )}

        {(error || invalid) && <div className="error">{error || invalid}</div>}
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
        <button className="btn btn-primary" disabled={!!invalid || !loaded} onClick={run(save)}>
          Save
        </button>
      </div>
    </Modal>
  )
}
