// The macOS app menu — the bold, top-left item, which reads "Electron" (its
// own product name) until something sets it. Replaces it with "Gurt" and an
// "About Gurt" item that opens a custom dialog instead of the OS's bare About
// panel, so the build info the panel would otherwise omit (commit, build
// date, Electron/Chromium/Node/V8) is there and copyable in one click — same
// shape as VS Code's About dialog.
import { app, BrowserWindow, clipboard, dialog, Menu, type MenuItemConstructorOptions } from 'electron'
import os from 'node:os'
import type { HotkeyMap } from '../shared/hotkeys'
import { bindingToAccelerator } from '../shared/hotkeys'

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

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send(channel, ...args)
  }
}

/** Accelerator items for the workspace-cycle hotkeys, appended to the Window
 *  menu — the same place Safari/Xcode-style apps put "Select Next/Previous
 *  Tab".
 *
 * macOS reserves ⌘`/⌘⇧` system-wide for "cycle through this app's windows" —
 * AppKit's key window handling claims it before it ever becomes a DOM keydown
 * in the renderer, so App.tsx's own listener can never see it (a well-known
 * Electron gotcha: github.com/electron/electron/issues/1978). Registering it
 * as this app's own menu accelerator instead reclaims it — Electron's menu
 * layer takes priority over the OS default.
 *
 * These items must stay *visible*: a `visible: false` `MenuItem` is what the
 * first version of this fix used, and it never worked — AppKit excludes
 * hidden `NSMenuItem`s from key-equivalent matching entirely (they don't
 * just fail to show, they don't fire), so the combination silently fell back
 * to the OS's own no-op window cycle. Showing two extra Window-menu entries
 * is a small, well-precedented cost for an accelerator that actually fires.
 *
 * Built from the live hotkey map rather than hardcoded to `` ` ``, so a remap
 * in Settings → Hotkeys follows: if the user moves `workspaceNext` off the
 * combination macOS reserves, this stops hijacking that combination too. */
function workspaceCycleItems(hotkeys: HotkeyMap): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []
  for (const [dir, label, binding] of [
    [1, 'Next Workspace', hotkeys.workspaceNext],
    [-1, 'Previous Workspace', hotkeys.workspacePrev]
  ] as const) {
    // The capture UI in Settings never saves a binding without `mod` — this
    // guards a hand-edited hotkeys.json from registering a bare-letter
    // accelerator that would swallow ordinary typing app-wide.
    if (!binding.mod) continue
    items.push({
      label,
      accelerator: bindingToAccelerator(binding),
      click: () => broadcast('hotkey-cycle-workspace', dir)
    })
  }
  return items
}

/** Sets the macOS app menu; a no-op elsewhere, since the app-named menu at
 *  the top left is a mac-only convention (Windows/Linux keep Electron's
 *  default menu, and their Ctrl+`/Ctrl+Shift+` are not OS-reserved — the
 *  renderer's own keydown listener already catches them there). Also renames
 *  the app itself — the role-based items below (`quit`, `hide`, …) render as
 *  "Quit " + `app.name`, so the label has to change, not just this menu's
 *  title, or they'd still read "Electron".
 *
 *  Re-run whenever the hotkey map changes (main/ipc.ts's `setHotkeys`) —
 *  rebuilding the whole template is the only way to change a live menu's
 *  accelerators, and it's cheap enough to not need finer-grained diffing. */
export function initAppMenu(hotkeys: HotkeyMap): void {
  if (process.platform !== 'darwin') return
  app.setName('Gurt')
  const cycleItems = workspaceCycleItems(hotkeys)
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
    {
      // `role: 'windowMenu'` normally fills in its own submenu (Minimize,
      // Zoom, a separator, Bring All to Front); providing one explicitly
      // replaces that default, so it's spelled out here to keep those same
      // items and add the workspace-cycle entries after them.
      role: 'windowMenu',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
        ...(cycleItems.length ? [{ type: 'separator' } as const, ...cycleItems] : [])
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
