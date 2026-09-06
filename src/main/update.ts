// Auto-update wiring over electron-updater. Two entry points share one event
// stream: a silent background poll (every minute, from initAutoUpdater) and
// the user-initiated Command Palette check. Only the manual path answers with
// dialogs — the poll's terminal events (not-available, error) are nothing the
// user asked about, so they only reach the log. A downloaded update is
// surfaced through the `update-ready` push (the sidebar's "update" button),
// never a dialog, whichever path fetched it.
import { app, BrowserWindow, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import { createLogger } from './log'

const log = createLogger('update')

const CHECK_INTERVAL_MS = 60_000

function focusedWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

// Same guard as ipc.ts's broadcast (not imported from there: ipc.ts already
// imports this module): a window mid-close can still be listed while its
// webContents is destroyed, and sending there throws.
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send(channel, payload)
  }
}

let initialized = false
/** True while a Command Palette check is in flight — gates the dialogs. */
let manualCheck = false
/** Version of the downloaded-and-ready update; null until one lands. */
let readyVersion: string | null = null
/** The background poll; cleared once an update is downloaded. */
let timer: ReturnType<typeof setInterval> | null = null

/** On Linux, electron-updater can only apply updates to the AppImage build:
 *  it picks its installer from how the app is currently *running* (the
 *  AppImage runtime sets `APPIMAGE`), and without it assumes a deb/rpm
 *  install and shells out to `sudo dpkg -i` — confirmed locally to actually
 *  attempt that, with no GUI polkit agent it just invokes bare `sudo`, which
 *  hangs or fails outside a terminal. deb is apt's to update, not ours. */
function updatable(): boolean {
  if (!app.isPackaged) return false
  if (process.platform === 'linux' && !process.env['APPIMAGE']) return false
  return true
}

/**
 * Wires electron-updater's event stream and starts the background poll (one
 * check right away, then every minute, until an update is downloaded). Safe
 * to call once at startup regardless of build type: it no-ops outside
 * packaged builds, since `autoUpdater.checkForUpdates()` throws without a
 * packaged app's update metadata and a dev run has no installer artifact to
 * apply anyway.
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
    if (!manualCheck) return
    const win = focusedWindow()
    if (win) void dialog.showMessageBox(win, { message: `You're up to date (${app.getVersion()}).` })
  })

  autoUpdater.on('update-downloaded', (info) => {
    log.info('update.ready', { version: info.version })
    readyVersion = info.version
    if (timer) clearInterval(timer)
    timer = null
    broadcast('update-ready', { version: info.version })
  })

  autoUpdater.on('error', (err) => {
    log.error('update.fail', { err })
    if (!manualCheck) return
    const win = focusedWindow()
    if (win)
      void dialog.showMessageBox(win, {
        type: 'error',
        message: 'Update check failed',
        detail: err instanceof Error ? err.message : String(err)
      })
  })

  if (!updatable()) {
    log.info('update.skip', { reason: 'not running as AppImage' })
    return
  }
  const poll = (): void => {
    if (readyVersion) return
    // electron-updater already dedups an in-flight check; errors surface via
    // the 'error' handler above, so a failed poll only reaches the log.
    autoUpdater.checkForUpdates().catch(() => undefined)
  }
  timer = setInterval(poll, CHECK_INTERVAL_MS)
  poll()
}

/** Manual check, wired to the Command Palette action. A no-op in dev (see
 *  `initAutoUpdater`) so the entry stays harmless while iterating locally
 *  without a packaged build. Unlike the poll it answers with dialogs. */
export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) {
    log.info('update.skip', { reason: 'not packaged', action: 'check' })
    return
  }
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
  manualCheck = true
  try {
    await autoUpdater.checkForUpdates()
  } finally {
    manualCheck = false
  }
}

/** Downloaded-and-ready update, if any — the pull behind the sidebar button
 *  for a window that opened after the `update-ready` push fired. */
export function updateStatus(): { version: string } | null {
  return readyVersion ? { version: readyVersion } : null
}

/** Restart into the downloaded update (the sidebar button's click). */
export function installUpdate(): void {
  if (!readyVersion) return
  autoUpdater.quitAndInstall()
}
