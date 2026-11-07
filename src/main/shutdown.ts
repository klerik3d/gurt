interface QuitApp {
  on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown
  quit(): void
}

/** Flush debounced writes before Electron exits. Repeated requests join one
 * save; a failed save keeps the application open and quitting retryable. */
export function saveBeforeQuit(app: QuitApp, save: () => Promise<void>, onError: (error: unknown) => void): void {
  let saved = false
  let saving = false
  app.on('before-quit', (event) => {
    if (saved) {
      // This permits only the quit we just retried. A window's beforeunload
      // can still cancel it; a later attempt must save subsequent edits again.
      saved = false
      saving = false
      return
    }
    event.preventDefault()
    if (saving) return
    saving = true
    void Promise.resolve().then(save).then(() => {
      saved = true
      app.quit()
    }).catch((error: unknown) => {
      saving = false
      onError(error)
    })
  })
}
