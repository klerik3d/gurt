// The two ways out of a session that was set up wrong: copy it into a corrected
// draft, or delete it outright. Both are reachable from every place a session is
// shown (sidebar row, draft/queued pane, chat header), so the confirmation
// wording and the follow-up navigation live here once instead of in each caller.
import { useRef, useState } from 'react'
import type { JSX } from 'react'
import type { SessionInfo } from '../../../shared/types'
import { alertDialog, confirmDialog } from '../dialog'
import { useOutsideClose } from '../hooks'
import { Icon } from './icons'

/** What either action needs to know about its target — a tree row carries this
 *  much, so the sidebar doesn't have to hold a snapshot to offer them. */
export type SessionTarget = Pick<SessionInfo, 'id' | 'title' | 'container' | 'state'>

/**
 * Confirm, then delete. Resolves true once the delete has been sent — callers
 * use that to step a selection off the row before it disappears (a cancelled
 * dialog must leave the selection exactly where it was).
 */
export async function deleteSession(s: SessionTarget): Promise<boolean> {
  // A session owns its container, so deleting it takes the container down —
  // say so, and say what survives: the clone and whatever is uncommitted in it.
  const warning =
    s.container && s.container.status !== 'stopped'
      ? `Delete session "${s.title}"? Its container goes down with it; the clone and any uncommitted changes stay.`
      : `Delete session "${s.title}"?`
  if (
    !(await confirmDialog(warning, {
      title: 'Delete session',
      confirmText: 'Delete',
      danger: true
    }))
  )
    return false
  window.gurt.sessionDelete(s.id).catch((e: unknown) => alertDialog(String(e)))
  return true
}

/** Copy into a draft of the same task and hand the copy to `onCreated` (which
 *  selects it — the copy exists to be corrected, so it should be on screen). */
export async function duplicateSession(
  id: string,
  onCreated?: (info: SessionInfo) => void
): Promise<void> {
  try {
    const copy = await window.gurt.sessionDuplicate(id)
    onCreated?.(copy)
  } catch (e) {
    await alertDialog(e instanceof Error ? e.message : String(e))
  }
}

/**
 * Confirm, then turn a launched session back into a draft with the same
 * configuration (`sessionRecreate`). Hands the new draft to `onCreated` — it
 * has a new id, and it exists to be corrected, so it should be on screen.
 * Resolves true once the draft exists (a cancelled dialog changes nothing).
 */
export async function recreateSession(
  s: SessionTarget,
  onCreated?: (info: SessionInfo) => void
): Promise<boolean> {
  if (
    !(await confirmDialog(
      `Recreate session "${s.title}" as a draft? Its conversation is discarded and any running turn is stopped` +
        (s.container ? ', and its container goes down' : '') +
        '. The configuration and first prompt stay, ready to edit and launch again; the clone and any uncommitted changes stay too.',
      { title: 'Recreate session', confirmText: 'Recreate', danger: true }
    ))
  )
    return false
  try {
    onCreated?.(await window.gurt.sessionRecreate(s.id))
    return true
  } catch (e) {
    await alertDialog(e instanceof Error ? e.message : String(e))
    return false
  }
}

/**
 * Overflow menu for a session pane's header — the only delete affordance a
 * *started* session has, since its pane is the chat. Behind a menu rather than a
 * bare button: one stray click next to "stop" should not end a running session,
 * and the confirmation is not the only thing that should stand in the way.
 */
export function SessionMenu({
  info,
  onSelect,
  onDeleted
}: {
  info: SessionTarget
  onSelect: (id: string) => void
  onDeleted: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(open, ref, () => setOpen(false))

  return (
    <div className="session-menu" ref={ref}>
      <button
        className={`icon-sq ${open ? 'active' : ''}`}
        title="Session actions"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="dots" size={15} />
      </button>
      {open && (
        <div className="menu session-menu-pop">
          <div
            className="menu-item"
            onMouseDown={(e) => {
              e.preventDefault()
              setOpen(false)
              void duplicateSession(info.id, (copy) => onSelect(copy.id))
            }}
          >
            <Icon name="copy" size={13} className="faint" />
            <span>Duplicate as draft</span>
          </div>
          {info.state !== 'draft' && (
            <div
              className="menu-item"
              onMouseDown={(e) => {
                e.preventDefault()
                setOpen(false)
                void recreateSession(info, (draft) => onSelect(draft.id))
              }}
            >
              <Icon name="history" size={13} className="faint" />
              <span>Recreate as draft…</span>
            </div>
          )}
          <div className="menu-sep" />
          <div
            className="menu-item danger"
            onMouseDown={(e) => {
              e.preventDefault()
              setOpen(false)
              void deleteSession(info).then((deleted) => deleted && onDeleted())
            }}
          >
            <Icon name="trash" size={13} className="faint" />
            <span>Delete session</span>
          </div>
        </div>
      )}
    </div>
  )
}
