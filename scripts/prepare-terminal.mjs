// node-pty's npm prebuilds ship macOS spawn-helper without its executable bit.
// Run after the allow-listed install scripts, before dev or packaging. Changing
// it at runtime would fail inside a read-only/signed application installation.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const root = path.dirname(require.resolve('node-pty/package.json'))
for (const dir of ['build/Release', 'build/Debug', 'prebuilds/darwin-arm64', 'prebuilds/darwin-x64']) {
  const helper = path.join(root, dir, 'spawn-helper')
  if (existsSync(helper)) chmodSync(helper, 0o755)
}

// node-pty rewrites its spawn-helper path with replace('app.asar',
// 'app.asar.unpacked'), which is not idempotent. The devcontainer CLI runs from
// app.asar.unpacked and picks up this node-pty, so the helper resolves to
// app.asar.unpacked.unpacked/... and every docker call fails with
// "posix_spawnp failed". Only rewrite paths that are not already unpacked.
const unixTerminal = path.join(root, 'lib/unixTerminal.js')
const source = readFileSync(unixTerminal, 'utf8')
const patched = source
  .replace("helperPath.replace('app.asar', 'app.asar.unpacked')", 'helperPath.replace(/app\\.asar(?!\\.unpacked)/, \'app.asar.unpacked\')')
  .replace("helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked')", 'helperPath.replace(/node_modules\\.asar(?!\\.unpacked)/, \'node_modules.asar.unpacked\')')
if (patched !== source) writeFileSync(unixTerminal, patched)
