import { app, BrowserWindow, nativeImage } from 'electron'
import path from 'node:path'
import { registerIpc } from './ipc'
import { migrateAgentSecrets } from './credentials'

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

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    const icon = nativeImage.createFromPath(iconPath)
    if (!icon.isEmpty()) app.dock?.setIcon(icon)
  }
  // Lift any inline agent secrets into the credential store before the IPC
  // surface (and thus getAgents) serves the renderer.
  await migrateAgentSecrets().catch((e) => console.error('agent-secret migration failed:', e))
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
