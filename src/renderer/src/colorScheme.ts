import { useSyncExternalStore } from 'react'
import type { ColorScheme } from '../../shared/appearance'

// The colour scheme in effect, as main resolves it from Settings → Appearance
// (main/appearance.ts). Mirrored onto `<html data-theme>`, which styles.css
// themes itself off; the hooks below are for the parts that take colours
// from JavaScript — the terminal and the code editor.

export type { ColorScheme }

let current: ColorScheme = window.gurt.colorScheme
const listeners = new Set<(scheme: ColorScheme) => void>()

function apply(): void {
  document.documentElement.dataset['theme'] = current
}

/** Call once, before the first render. */
export function initColorScheme(): void {
  apply()
  window.gurt.onColorScheme((next) => {
    if (next === current) return
    current = next
    apply()
    for (const cb of listeners) cb(next)
  })
}

export function colorScheme(): ColorScheme {
  return current
}

export function onColorSchemeChange(cb: (scheme: ColorScheme) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(onColorSchemeChange, colorScheme)
}
