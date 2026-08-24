// Auto-update wiring over electron-updater. Checks are user-initiated only
// (Command Palette → "Check for updates") — there is no background poll, so
// every terminal event below (not-available, error, downloaded) is a direct
// reply to something the user just did, and a dialog is the right way to
// answer it. No renderer plumbing needed.
import { app, BrowserWindow, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import { createLogger } from './log'

const log = createLogger('update')

function focusedWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

let initialized = false

/**
 * Wires electron-updater's event stream to log + dialog feedback. Safe to
 * call once at startup regardless of build type: it no-ops outside packaged
 * builds, since `autoUpdater.checkForUpdates()` throws without a packaged
 * app's update metadata and a dev run has no installer artifact to apply
 * anyway.
 *
 * `GURT_UPDATE_URL`, when set, overrides the feed baked into the build (the
 * GitHub Releases provider electron-builder infers from the repo) with a
 * `generic` provider pointing at that URL — see README's "Testing
 * auto-update locally" for the local static-server loop this exists for.
 */
export function initAutoUpdater(): void {
  if (initialized) return
  initialized = true
  if (!app.isPackaged) {
    log.info('update.skip', { reason: 'not packaged' })
    return
  }

  autoUpdater.logger = {
    info: (m: string) => log.info('update.log', { m }),
    warn: (m: string) => log.warn('update.log', { m }),
    error: (m: string) => log.error('update.log', { m }),
    // electron-updater's Logger type requires debug even though it never
    // calls it today — kept for interface compatibility, not because
    // anything currently exercises this branch.
    debug: (m: string) => log.debug('update.log', { m })
  }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  const feedUrl = process.env['GURT_UPDATE_URL']
  if (feedUrl) {
    log.info('update.feed-override', { url: feedUrl })
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl })
  }

  autoUpdater.on('update-not-available', () => {
    const win = focusedWindow()
    if (win) void dialog.showMessageBox(win, { message: `You're up to date (${app.getVersion()}).` })
  })

  autoUpdater.on('update-downloaded', (info) => {
    const win = focusedWindow()
    const respond = (r: { response: number }): void => {
      if (r.response === 0) autoUpdater.quitAndInstall()
    }
    if (win)
      void dialog
        .showMessageBox(win, {
          type: 'info',
          message: `gurt ${info.version} downloaded`,
          detail: 'Restart now to finish installing it.',
          buttons: ['Restart now', 'Later'],
          defaultId: 0,
          cancelId: 1
        })
        .then(respond)
    else respond({ response: 0 })
  })

  autoUpdater.on('error', (err) => {
    log.error('update.fail', { err })
    const win = focusedWindow()
    if (win)
      void dialog.showMessageBox(win, {
        type: 'error',
        message: 'Update check failed',
        detail: err instanceof Error ? err.message : String(err)
      })
  })
}

/** Manual check, wired to the Command Palette action. A no-op in dev (see
 *  `initAutoUpdater`) so the entry stays harmless while iterating locally
 *  without a packaged build. */
export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) {
    log.info('update.skip', { reason: 'not packaged', action: 'check' })
    return
  }
  // electron-updater picks its installer from how the app is currently
  // running, not from what was built: on Linux, without `APPIMAGE` in the
  // environment (set by the AppImage runtime itself) it assumes a deb/rpm
  // install and shells out to `sudo dpkg -i` — confirmed locally to actually
  // attempt that, with no GUI polkit agent it just invokes bare `sudo`,
  // which hangs or fails outside a terminal. deb is apt's to update, not
  // ours; only steer someone running the AppImage through electron-updater.
  if (process.platform === 'linux' && !process.env['APPIMAGE']) {
    log.info('update.skip', { reason: 'not running as AppImage' })
    const win = focusedWindow()
    if (win)
      void dialog.showMessageBox(win, {
        message: 'Auto-update is only available for the AppImage build.',
        detail: 'This is running from the .deb install — update it with your package manager.'
      })
    return
  }
  await autoUpdater.checkForUpdates()
}
