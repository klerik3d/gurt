import { app, BrowserWindow, dialog, nativeImage, shell } from 'electron'
import path from 'node:path'
import { registerIpc } from './ipc'
import { loadSecrets, migrateAgentSecrets, sealPlaintextSecrets } from './credentials'
import { createLogger, flushSync, logDir, logLevel } from './log'
import { dockerVersion } from './provision'
import { gurtRoot } from './store'

const log = createLogger('app')

// One instance only: two processes would share ~/.gurt with none of the
// in-memory guarantees holding across them — both would reconcile containers,
// both would write sessions.json/workspace.json, and the repo locks that keep
// two agents out of one working tree exist per process. The second instance
// hands focus to the first and leaves.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
}

// Bundled app icon; on macOS the dock icon is set at runtime (the packaged
// .icns route only exists once we ship a real bundle).
const iconPath = path.join(__dirname, '../../resources/icon.png')

/** Hand a URL to the OS browser. Never fatal: the user can still copy the link,
 *  and an unhandled rejection here would be reported as an app crash. */
async function openExternal(url: string): Promise<void> {
  try {
    await shell.openExternal(url)
  } catch (e) {
    log.warn('external.open-failed', { err: e })
  }
}

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
    void openExternal(url)
    return { action: 'deny' }
  })

  // Same for in-place navigation (a plain <a href> click): only the app's
  // own page may load in this window, everything else goes to the browser.
  const isAppUrl = (url: string): boolean =>
    process.env['ELECTRON_RENDERER_URL']
      ? url.startsWith(process.env['ELECTRON_RENDERER_URL'])
      : url.startsWith('file://')
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    void openExternal(url)
  })

  const loaded = process.env['ELECTRON_RENDERER_URL']
    ? win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    : win.loadFile(path.join(__dirname, '../renderer/index.html'))
  // Nothing to fall back to if the window's own document fails to load, but a
  // silent blank window is the worst way to find that out.
  void loaded.catch((e: unknown) => log.error('internal.fail', { site: 'window-load', err: e }))
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

void app.whenReady().then(async () => {
  void logStartBanner()
  if (process.platform === 'darwin') {
    const icon = nativeImage.createFromPath(iconPath)
    if (!icon.isEmpty()) app.dock?.setIcon(icon)
  }
  // Arm value-based log redaction before anything can spawn a process holding a
  // token, then lift any inline agent secrets into the credential store — both
  // before the IPC surface (and thus getAgents) serves the renderer.
  await loadSecrets().catch((e: unknown) => log.error('internal.fail', { site: 'credential-load', err: e }))
  await migrateAgentSecrets().catch((e: unknown) => log.error('internal.fail', { site: 'agent-secret-migrate', err: e }))
  // Reseal any plaintext secret-flagged field left over from before this
  // feature existed (or from a GURT_FORCE_PLAINTEXT run) now that the
  // keystore may be available. Idempotent, so safe to run every start.
  await sealPlaintextSecrets().catch((e: unknown) => log.error('internal.fail', { site: 'credential-seal', err: e }))
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
