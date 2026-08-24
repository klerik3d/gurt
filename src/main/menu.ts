// The macOS app menu — the bold, top-left item, which reads "Electron" (its
// own product name) until something sets it. Replaces it with "Gurt" and an
// "About Gurt" item that opens a custom dialog instead of the OS's bare About
// panel, so the build info the panel would otherwise omit (commit, build
// date, Electron/Chromium/Node/V8) is there and copyable in one click — same
// shape as VS Code's About dialog.
import { app, clipboard, dialog, Menu, type MenuItemConstructorOptions } from 'electron'
import os from 'node:os'

/** Coarse "when was this" wording — same rounding as the renderer's
 *  `relativeTime` (src/renderer/src/time.ts), duplicated because that file
 *  sits outside tsconfig.node.json's include set (renderer-only otherwise). */
function relativeTime(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

function aboutLines(): string[] {
  return [
    `Version: ${app.getVersion()} (${process.arch})`,
    `Commit: ${__GURT_COMMIT__}`,
    `Date: ${__GURT_BUILD_DATE__} (${relativeTime(__GURT_BUILD_DATE__)})`,
    `Electron: ${process.versions.electron}`,
    `Chromium: ${process.versions.chrome}`,
    `Node.js: ${process.versions.node}`,
    `V8: ${process.versions.v8}`,
    `OS: ${os.type()} ${os.release()}`
  ]
}

function showAbout(): void {
  const detail = aboutLines().join('\n')
  // Plain `dialog.showMessageBoxSync` (no owner window): the app menu that
  // triggers this isn't tied to any one window either.
  const button = dialog.showMessageBoxSync({
    type: 'info',
    title: 'About Gurt',
    message: 'Gurt',
    detail,
    buttons: ['Copy', 'Close'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  })
  if (button === 0) clipboard.writeText(`Gurt\n${detail}`)
}

/** Sets the macOS app menu; a no-op elsewhere, since the app-named menu at
 *  the top left is a mac-only convention (Windows/Linux keep Electron's
 *  default menu). Also renames the app itself — the role-based items below
 *  (`quit`, `hide`, …) render as "Quit " + `app.name`, so the label has to
 *  change, not just this menu's title, or they'd still read "Electron". */
export function initAppMenu(): void {
  if (process.platform !== 'darwin') return
  app.setName('Gurt')
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Gurt',
      submenu: [
        { label: 'About Gurt', click: showAbout },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
