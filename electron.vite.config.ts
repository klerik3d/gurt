import { execSync } from 'node:child_process'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/** Short commit SHA of the build — 'unknown' outside a git checkout (a
 *  from-tarball build, say). Read at build time: a packaged app ships without
 *  `.git`, so this has to be baked in, not read at runtime. */
function commitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'unknown'
  }
}

// Consumed by src/main/menu.ts's About panel; declared for TS in
// src/main/build-info.d.ts.
const BUILD_INFO = {
  __GURT_COMMIT__: JSON.stringify(commitHash()),
  __GURT_BUILD_DATE__: JSON.stringify(new Date().toISOString())
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: BUILD_INFO
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()]
  }
})
