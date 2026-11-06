import { BrowserWindow } from 'electron'

/** Send `channel` to every open window's renderer. */
export function broadcast(channel: string, ...args: unknown[]): void {
  // A window mid-close can still be listed while its webContents is already
  // destroyed; sending there throws (the background poll's usage.changed is
  // the common trigger).
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send(channel, ...args)
  }
}
