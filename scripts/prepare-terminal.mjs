// node-pty's npm prebuilds ship macOS spawn-helper without its executable bit.
// Run after the allow-listed install scripts, before dev or packaging. Changing
// it at runtime would fail inside a read-only/signed application installation.
import { chmodSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const root = path.dirname(require.resolve('node-pty/package.json'))
for (const dir of ['build/Release', 'build/Debug', 'prebuilds/darwin-arm64', 'prebuilds/darwin-x64']) {
  const helper = path.join(root, dir, 'spawn-helper')
  if (existsSync(helper)) chmodSync(helper, 0o755)
}
