import { useEffect, useState } from 'react'
import type { HotkeyActionId, HotkeyBinding, HotkeyMap } from '../../../../shared/hotkeys'
import {
  HOTKEY_DEFAULTS,
  HOTKEY_DEFS,
  bindingEquals,
  bindingFromEvent,
  bindingLabel,
  conflictsFor,
  isRecordable,
  modKeyLabel
} from '../../../../shared/hotkeys'
import { refreshHotkeys, useHotkeys } from '../../useHotkeys'
import { run } from '../../async'

// ---- Hotkeys — remap the global keyboard shortcuts, tracking conflicts ----

/** Set while a row waits for the user's next keypress instead of a typed
 *  value — Escape cancels, a bare modifier is ignored, anything else becomes
 *  the candidate binding. */
interface Recording {
  id: HotkeyActionId
}

/** A captured binding that already belongs to another action — surfaced
 *  instead of silently overwriting it, since two actions on the same
 *  combination would both fire and there would be no way to tell which one
 *  the keypress meant. */
interface PendingConflict {
  id: HotkeyActionId
  binding: HotkeyBinding
  withIds: HotkeyActionId[]
}

export function HotkeysSection() {
  const map = useHotkeys()
  const [recording, setRecording] = useState<Recording | null>(null)
  const [pending, setPending] = useState<PendingConflict | null>(null)
  const [hint, setHint] = useState('')
  const [error, setError] = useState('')

  const save = async (next: HotkeyMap) => {
    setError('')
    try {
      await window.gurt.setHotkeys(next)
      refreshHotkeys()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Captures the very next keydown while a row is recording — preventDefault
  // and stopPropagation keep it from also reaching App's own hotkey listener
  // (which would otherwise fire whatever the *old* binding for that key does)
  // or landing in some focused text field behind the modal-less settings page.
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.code === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setRecording(null)
        setHint('')
        return
      }
      if (!isRecordable(e.code)) return // a bare modifier — keep waiting
      const binding = bindingFromEvent(e)
      if (!binding.mod) {
        setHint(`hold ${modKeyLabel()} while pressing a key`)
        return
      }
      const id = recording.id
      const withIds = conflictsFor(id, binding, map)
      setRecording(null)
      setHint('')
      if (withIds.length === 0) {
        void save({ ...map, [id]: binding })
      } else {
        setPending({ id, binding, withIds })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, map])

  const startRecording = (id: HotkeyActionId) => {
    setPending(null)
    setHint('')
    setError('')
    setRecording({ id })
  }

  // The only way to accept a conflicting combination: give the other side
  // back what this action is giving up, so every action stays bound to
  // something and the map never ends up with two actions sharing one
  // combination (§ the invariant `conflictsFor` relies on to only ever find
  // one owner).
  const swap = async () => {
    if (!pending || pending.withIds.length !== 1) return
    const [other] = pending.withIds
    if (!other) return
    const displaced = map[pending.id]
    await save({ ...map, [pending.id]: pending.binding, [other]: displaced })
    setPending(null)
  }

  return (
    <>
      <div className="set-head">
        <div className="set-title-wrap">
          <span className="set-title">Hotkeys</span>
          <span className="set-count mono">applies across every workspace</span>
        </div>
      </div>
      <div className="set-list">
        {HOTKEY_DEFS.map((def) => {
          const binding = map[def.id]
          const isRecording = recording?.id === def.id
          const conflict = pending?.id === def.id ? pending : null
          const isDefault = bindingEquals(binding, HOTKEY_DEFAULTS[def.id])
          return (
            <div key={def.id}>
              <div className="set-row">
                <span className="set-row-label">{def.label}</span>
                <span className="set-row-url">{def.hint}</span>
                {isRecording ? (
                  <span className="kbd hotkey-recording">{hint || 'press a key…'}</span>
                ) : (
                  <span className="kbd">{bindingLabel(binding)}</span>
                )}
                {!isDefault && !isRecording && (
                  <button
                    className="btn-link"
                    title="reset to default"
                    onClick={run(() => save({ ...map, [def.id]: HOTKEY_DEFAULTS[def.id] }))}
                  >
                    reset
                  </button>
                )}
                <button
                  className="btn-link"
                  onClick={() => (isRecording ? setRecording(null) : startRecording(def.id))}
                >
                  {isRecording ? 'cancel' : 'change'}
                </button>
              </div>
              {conflict && (
                <div className="hc-note hc-warn hotkey-conflict">
                  {bindingLabel(conflict.binding)} is already{' '}
                  {conflict.withIds.length === 1 ? 'used by' : 'used by multiple actions:'}{' '}
                  {conflict.withIds
                    .map((id) => HOTKEY_DEFS.find((d) => d.id === id)?.label ?? id)
                    .join(', ')}
                  .
                  {conflict.withIds.length === 1 ? (
                    <>
                      {' '}
                      <button className="btn-link" onClick={run(swap)}>
                        swap
                      </button>
                    </>
                  ) : null}{' '}
                  <button className="btn-link" onClick={() => setPending(null)}>
                    cancel
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      {error && <div className="error">{error}</div>}
    </>
  )
}
