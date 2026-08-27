// Global keyboard shortcuts + user overrides — shared between main (persists
// the override file) and renderer (the App-level listener, the settings UI).

/** One combination: `code` is a `KeyboardEvent.code` (layout-independent —
 *  `Backquote` stays the physical key left of "1" on any layout), `mod` is
 *  either metaKey or ctrlKey (gurt treats them as the same modifier, the way
 *  most cross-platform apps do — ⌘ on macOS, Ctrl elsewhere). */
export interface HotkeyBinding {
  code: string
  mod: boolean
  shift: boolean
  alt: boolean
}

export type HotkeyActionId =
  | 'palette'
  | 'newSession'
  | 'newTask'
  | 'workspaceNext'
  | 'workspacePrev'

export interface HotkeyDef {
  id: HotkeyActionId
  label: string
  hint: string
}

/** Nav order in the settings list — also the order actions are checked in,
 *  though no default combination collides so that only matters for a user's
 *  own remap. */
export const HOTKEY_DEFS: HotkeyDef[] = [
  { id: 'palette', label: 'Command palette', hint: 'open the command palette' },
  { id: 'newSession', label: 'New session', hint: 'start a new session draft in the current task' },
  { id: 'newTask', label: 'New task', hint: 'create a new task in the current workspace' },
  { id: 'workspaceNext', label: 'Next workspace', hint: 'cycle to the next workspace' },
  { id: 'workspacePrev', label: 'Previous workspace', hint: 'cycle to the previous workspace' }
]

export const HOTKEY_DEFAULTS: Record<HotkeyActionId, HotkeyBinding> = {
  palette: { code: 'KeyK', mod: true, shift: false, alt: false },
  newSession: { code: 'KeyN', mod: true, shift: false, alt: false },
  newTask: { code: 'KeyN', mod: true, shift: true, alt: false },
  workspaceNext: { code: 'Backquote', mod: true, shift: false, alt: false },
  workspacePrev: { code: 'Backquote', mod: true, shift: true, alt: false }
}

export type HotkeyMap = Record<HotkeyActionId, HotkeyBinding>

function isBinding(v: unknown): v is HotkeyBinding {
  if (!v || typeof v !== 'object') return false
  const b = v as Record<string, unknown>
  return (
    typeof b['code'] === 'string' &&
    !!b['code'] &&
    typeof b['mod'] === 'boolean' &&
    typeof b['shift'] === 'boolean' &&
    typeof b['alt'] === 'boolean'
  )
}

/** The IPC boundary is untrusted input, not `HotkeyMap` — walks the known
 *  actions and keeps each one's stored binding only if it is shaped right,
 *  falling back to `fallback`'s (the currently-persisted map, by default the
 *  built-in defaults) otherwise. A garbage or partial payload degrades to
 *  "leave that binding as it was", never to losing every other action's
 *  remap over one bad field. */
export function sanitizeHotkeys(
  raw: unknown,
  fallback: HotkeyMap = HOTKEY_DEFAULTS
): HotkeyMap {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<HotkeyActionId, unknown>>
  const out = {} as HotkeyMap
  for (const def of HOTKEY_DEFS) {
    const v = r[def.id]
    out[def.id] = isBinding(v) ? { code: v.code, mod: v.mod, shift: v.shift, alt: v.alt } : fallback[def.id]
  }
  return out
}

/** Same combination, modifiers and physical key alike. */
export function bindingEquals(a: HotkeyBinding, b: HotkeyBinding): boolean {
  return a.code === b.code && a.mod === b.mod && a.shift === b.shift && a.alt === b.alt
}

/** Every other action currently bound to the same combination — the set a
 *  remap would collide with. */
export function conflictsFor(
  id: HotkeyActionId,
  binding: HotkeyBinding,
  map: HotkeyMap
): HotkeyActionId[] {
  return HOTKEY_DEFS.filter((d) => d.id !== id && bindingEquals(map[d.id], binding)).map((d) => d.id)
}

const CODE_LABEL: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'Space',
  Enter: '↵',
  Escape: 'Esc',
  Tab: 'Tab',
  Backspace: '⌫',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→'
}

/** A `KeyboardEvent.code` in the way the rest of the UI already writes key
 *  names (`⌘K`, `⌘⇧N`): `KeyK` → `K`, `Digit1` → `1`, `F5` → `F5`, anything
 *  else falls back to the code itself so an unmapped key still shows
 *  something instead of nothing. */
export function codeLabel(code: string): string {
  if (CODE_LABEL[code]) return CODE_LABEL[code]
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  return code
}

/** `⌘⇧N`-style display string, the app's existing convention for a
 *  combination (see the composer, the command palette, the sidebar's "new
 *  task" tooltip). */
export function bindingLabel(b: HotkeyBinding): string {
  return `${b.mod ? '⌘' : ''}${b.alt ? '⌥' : ''}${b.shift ? '⇧' : ''}${codeLabel(b.code)}`
}

/** True when a live keydown event matches a stored binding — `code`
 *  (layout-independent), `mod` (either metaKey or ctrlKey, gurt's one
 *  cross-platform modifier), `shift` and `alt` exactly. */
export function bindingMatchesEvent(
  b: HotkeyBinding,
  e: { code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }
): boolean {
  return (
    e.code === b.code &&
    (e.metaKey || e.ctrlKey) === b.mod &&
    e.shiftKey === b.shift &&
    e.altKey === b.alt
  )
}

/** A captured keydown, as a binding — used while recording a remap. `mod`
 *  requires at least one of meta/ctrl to be held; a bare letter or a bare
 *  modifier key is not a usable binding (see `isRecordable`). */
export function bindingFromEvent(e: {
  code: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}): HotkeyBinding {
  return { code: e.code, mod: e.metaKey || e.ctrlKey, shift: e.shiftKey, alt: e.altKey }
}

/** Modifier-only keydowns (`ShiftLeft`, `MetaRight`, …) never land as a
 *  binding on their own — recording waits for the next non-modifier key. */
const MODIFIER_CODES = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'CapsLock'
])

export function isRecordable(code: string): boolean {
  return !MODIFIER_CODES.has(code)
}
