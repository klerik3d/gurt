import { useEffect, useState } from 'react'
import type { HotkeyMap } from '../../shared/hotkeys'
import { HOTKEY_DEFAULTS } from '../../shared/hotkeys'
import { logErr } from './log'

// Shared hotkeys cache, same shape as useAgents.ts: App's global keydown
// listener needs the live map on every keystroke, and the settings editor
// needs to push a fresh one the moment it saves a remap — one fetch shared
// across both, refreshHotkeys() re-broadcasts after a save.
let cache: HotkeyMap | null = null
const subscribers = new Set<(m: HotkeyMap) => void>()

function load(): void {
  window.gurt
    .getHotkeys()
    .then((m) => {
      cache = m
      subscribers.forEach((fn) => fn(m))
    })
    .catch(logErr('getHotkeys'))
}

/** Re-fetch hotkeys and notify every subscriber (call after saving a remap). */
export function refreshHotkeys(): void {
  load()
}

export function useHotkeys(): HotkeyMap {
  const [map, setMap] = useState<HotkeyMap>(cache ?? HOTKEY_DEFAULTS)
  useEffect(() => {
    subscribers.add(setMap)
    if (cache) setMap(cache)
    else load()
    return () => {
      subscribers.delete(setMap)
    }
  }, [])
  return map
}
