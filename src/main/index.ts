import { app, BrowserWindow, dialog, nativeImage, shell } from 'electron'
import path from 'node:path'
import { registerIpc } from './ipc'
import { loadSecrets, migrateAgentSecrets } from './credentials'
import { createLogger, flushSync, logDir, logLevel } from './log'
import { dockerVersion } from './provision'
import { gurtRoot } from './store'

const log = createLogger('app')

// Bundled app icon; on macOS the dock icon is set at runtime (the packaged
// .icns route only exists once we ship a real bundle).
const iconPath = path.join(__dirname, '../../resources/icon.png')

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'gurt',
    icon: iconPath,
    backgroundColor: '#100f0d',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Centered in the 44px title bar (lights are 12px tall).
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Any link the renderer wants to open in a new window (target="_blank",
  // window.open) goes to the OS browser instead of a second app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Same for in-place navigation (a plain <a href> click): only the app's
  // own page may load in this window, everything else goes to the browser.
  const isAppUrl = (url: string): boolean =>
    process.env.ELECTRON_RENDERER_URL
      ? url.startsWith(process.env.ELECTRON_RENDERER_URL)
      : url.startsWith('file://')
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    shell.openExternal(url)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

/** First record of every run: what this build is, and what it is running on.
 *  Docker is probed best-effort — its absence is the single most common cause
 *  of a session that never starts, and it belongs in the banner, not a guess. */
async function logStartBanner(): Promise<void> {
  log.info('app.start', {
    gurt: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    docker: (await dockerVersion()) ?? 'unavailable',
    root: gurtRoot,
    logs: logDir(),
    level: logLevel
  })
}

app.whenReady().then(async () => {
  void logStartBanner()
  if (process.platform === 'darwin') {
    const icon = nativeImage.createFromPath(iconPath)
    if (!icon.isEmpty()) app.dock?.setIcon(icon)
  }
  // Arm value-based log redaction before anything can spawn a process holding a
  // token, then lift any inline agent secrets into the credential store — both
  // before the IPC surface (and thus getAgents) serves the renderer.
  await loadSecrets().catch((e) => log.error('internal.fail', { site: 'credential-load', err: e }))
  await migrateAgentSecrets().catch((e) => log.error('internal.fail', { site: 'agent-secret-migrate', err: e }))
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  log.info('app.quit')
  flushSync()
})

/**
 * Crash popup, replacing Electron's default dialog (which registering our
 * uncaughtException handler suppresses). "Send Report to Developer" is a stub:
 * nothing is collected or sent anywhere yet — the click is followed by a
 * one-second beat and the exit. When an upload endpoint exists, that beat is
 * where the log gets packed and sent, under the hood, behind this same button.
 */
function showCrashDialog(): void {
  // dialog is unusable before `ready` — the record and the exit still happen.
  if (!app.isReady()) return
  try {
    dialog.showMessageBoxSync({
      type: 'error',
      title: 'gurt',
      message: 'Unknown error',
      detail: 'gurt hit an unexpected error and has to close.',
      buttons: ['Send Report to Developer'],
      defaultId: 0,
      noLink: true
    })
  } catch {
    // A broken dialog must not mask the crash itself.
  }
}

// A crash must leave a record behind: log it, then force the queue to disk with
// a synchronous write — the process may not survive to the next drain tick.
// Registering this handler suppresses Electron's own crash dialog, so we show
// our own, then exit: resuming after an uncaught exception is unsafe (the
// process state is undefined).
let crashing = false
process.on('uncaughtException', (err) => {
  // A second exception while the dialog is up (or during the exit grace period)
  // is still recorded, but must not stack a second dialog on the first.
  if (crashing) {
    log.error('app.crash', { reason: 'uncaughtException', err })
    flushSync()
    return
  }
  crashing = true
  log.error('app.crash', { reason: 'uncaughtException', err })
  flushSync()
  showCrashDialog()
  setTimeout(() => process.exit(1), 1000)
})
// A rejection is recorded but not fatal — matching Electron's own default,
// which warns on unhandled rejections without taking the process down.
process.on('unhandledRejection', (reason) => {
  log.error('app.crash', { reason: 'unhandledRejection', err: reason })
  flushSync()
})
