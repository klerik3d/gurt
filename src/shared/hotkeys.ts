// Global keyboard shortcuts + user overrides — shared between main (persists
// the override file) and renderer (the App-level listener, the settings UI).

/** True in a macOS renderer, false everywhere else (including main, and Node
 *  generally, which either has no `navigator` or a bare `Node.js/xx` one) —
 *  the one thing that differs between platforms is how `mod`/`alt` are
 *  *drawn* (⌘/⌥ vs Ctrl/Alt); matching and the Electron accelerator
 *  (`CmdOrCtrl`, see `bindingToAccelerator`) are already the same on every
 *  OS. Read live rather than cached at module load so tests can swap
 *  `navigator` between assertions (see scripts/hotkeys.test.mjs). */
function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac/.test(navigator.platform ?? navigator.userAgent ?? '')
}

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
  | 'gotoDashboard'
  | 'gotoTasks'
  | 'gotoSettings'

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
  { id: 'workspacePrev', label: 'Previous workspace', hint: 'cycle to the previous workspace' },
  { id: 'gotoDashboard', label: 'Go to dashboard', hint: 'open the dashboard' },
  { id: 'gotoTasks', label: 'Go to tasks', hint: 'open tasks & sessions, focusing the list' },
  { id: 'gotoSettings', label: 'Go to settings', hint: 'open settings' }
]

export const HOTKEY_DEFAULTS: Record<HotkeyActionId, HotkeyBinding> = {
  palette: { code: 'KeyK', mod: true, shift: false, alt: false },
  newSession: { code: 'KeyN', mod: true, shift: false, alt: false },
  newTask: { code: 'KeyN', mod: true, shift: true, alt: false },
  workspaceNext: { code: 'Backquote', mod: true, shift: false, alt: false },
  workspacePrev: { code: 'Backquote', mod: true, shift: true, alt: false },
  gotoDashboard: { code: 'Digit1', mod: true, shift: false, alt: false },
  gotoTasks: { code: 'Digit2', mod: true, shift: false, alt: false },
  gotoSettings: { code: 'Digit0', mod: true, shift: false, alt: false }
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

/** `⌘⇧N`-style display string on macOS, `Ctrl+Shift+N` elsewhere — the app's
 *  existing convention for a combination (see the composer, the command
 *  palette, the sidebar's "new task" tooltip). */
export function bindingLabel(b: HotkeyBinding): string {
  if (isMac()) return `${b.mod ? '⌘' : ''}${b.alt ? '⌥' : ''}${b.shift ? '⇧' : ''}${codeLabel(b.code)}`
  const parts: string[] = []
  if (b.mod) parts.push('Ctrl')
  if (b.alt) parts.push('Alt')
  if (b.shift) parts.push('Shift')
  parts.push(codeLabel(b.code))
  return parts.join('+')
}

/** Everything in `bindingLabel` except the modifier — what a corner badge
 *  shows once the user is already holding it down (App's activity-bar
 *  hint: hold ⌘/Ctrl, see which key finishes each icon's shortcut). */
export function bindingRestLabel(b: HotkeyBinding): string {
  if (isMac()) return `${b.alt ? '⌥' : ''}${b.shift ? '⇧' : ''}${codeLabel(b.code)}`
  const parts: string[] = []
  if (b.alt) parts.push('Alt')
  if (b.shift) parts.push('Shift')
  parts.push(codeLabel(b.code))
  return parts.join('+')
}

/** `hold ⌘` on macOS, `hold Ctrl` elsewhere — the modifier-prompt half of the
 *  Settings → Hotkeys recording hint. */
export function modKeyLabel(): string {
  return isMac() ? '⌘' : 'Ctrl'
}

/** `KeyboardEvent.code` → the key name Electron's `accelerator` strings use
 *  (`Menu.buildFromTemplate`) — a different vocabulary from `CODE_LABEL`'s
 *  display glyphs (`Return` not `↵`, `Up` not `↑`, and symbol keys spelled
 *  with their literal character). */
const ACCELERATOR_KEY: Record<string, string> = {
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
  Enter: 'Return',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'Backspace',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right'
}

/** `HotkeyBinding` → an Electron `accelerator` string (`CmdOrCtrl+\``,
 *  `CmdOrCtrl+Shift+N`, …). Only ever needed by main, and only for the
 *  handful of combinations macOS reserves for itself (window cycling on
 *  Cmd+`/Cmd+Shift+`) and would otherwise consume before a DOM keydown in
 *  the renderer ever saw it — see `main/menu.ts`. Every other binding is
 *  matched purely in the renderer via `bindingMatchesEvent` and never
 *  reaches this. */
export function bindingToAccelerator(b: HotkeyBinding): string {
  const parts: string[] = []
  if (b.mod) parts.push('CmdOrCtrl')
  if (b.alt) parts.push('Alt')
  if (b.shift) parts.push('Shift')
  const key =
    ACCELERATOR_KEY[b.code] ??
    (b.code.startsWith('Key')
      ? b.code.slice(3)
      : b.code.startsWith('Digit')
        ? b.code.slice(5)
        : b.code)
  parts.push(key)
  return parts.join('+')
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
