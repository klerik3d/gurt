import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { registerIpc } from './ipc'
import { migrateAgentSecrets } from './credentials'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'gurt',
    backgroundColor: '#1f1f1f',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 13 },
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
