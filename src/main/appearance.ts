// Applies Settings → Appearance to the window. Main resolves the theme to the
// scheme in effect and hands that to the renderer (sync at preload, then
// `color-scheme` events), rather than leaving it to the page's
// `prefers-color-scheme`: `nativeTheme.themeSource` does not reach that media
// query on Linux. `themeSource` is still set — it is what resolves `system`
// to the OS's setting, and what native menus and dialogs follow.
import { BrowserWindow, ipcMain, nativeTheme } from 'electron'
import {
  APPEARANCE_DEFAULT,
  TEXT_SIZE_ZOOM,
  WINDOW_BACKGROUND,
  type Appearance,
  type ColorScheme
} from '../shared/appearance'
import { broadcast } from './broadcast'
import { getAppearance } from './store'

let current: Appearance = APPEARANCE_DEFAULT

function scheme(): ColorScheme {
  if (current.theme !== 'system') return current.theme
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/** The colour a window shows before its first paint. */
export function windowBackground(): string {
  return WINDOW_BACKGROUND[scheme()]
}

function windowZoom(): number {
  return TEXT_SIZE_ZOOM[current.textSize]
}

/** Hook a new window up to the text size. Chromium remembers a zoom level per
 *  origin across launches and applies it on load, over
 *  `webPreferences.zoomFactor` — so a size changed while the app was closed
 *  (or the View menu's zoom keys, last session) would otherwise win. Usually
 *  the remembered level already is this one, and the set is a no-op. */
export function attachAppearance(win: BrowserWindow): void {
  win.webContents.on('dom-ready', () => win.webContents.setZoomFactor(windowZoom()))
}

/** Open windows, minus one mid-close (see broadcast.ts). */
const liveWindows = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && !w.webContents.isDestroyed())

function syncWindows(): void {
  for (const win of liveWindows()) win.setBackgroundColor(windowBackground())
  broadcast('color-scheme', scheme())
}

/** Apply to the native theme and every open window — on boot, and live on
 *  each save from Settings. */
export function applyAppearance(appearance: Appearance): void {
  current = appearance
  nativeTheme.themeSource = appearance.theme
  for (const win of liveWindows()) win.webContents.setZoomFactor(windowZoom())
  syncWindows()
}

/** Load the stored appearance before the first window is created, so it
 *  opens in the right scheme and size instead of flashing the default. */
export async function initAppearance(): Promise<void> {
  ipcMain.on('appearance:scheme', (e) => {
    e.returnValue = scheme()
  })
  // Under `system`, the OS flipping its scheme reaches here.
  nativeTheme.on('updated', syncWindows)
  // A failed read still pins the default theme, rather than leaving
  // `themeSource` at Electron's own `system` default; the error propagates
  // to the caller's log.
  let stored = APPEARANCE_DEFAULT
  try {
    stored = await getAppearance()
  } finally {
    applyAppearance(stored)
  }
}
