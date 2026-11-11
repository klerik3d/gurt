// A clone the AGENT has written to (docs/requirements-review-loop.md §10): its
// `.git/config` and `.git/hooks` name programs, and every one of them leaves a
// marker file when git runs it. The review loop's host git must run none, so a
// test builds this clone, drives the loop's git, and asserts `hits()` is empty
// (and that the work itself still went through).
//
//   const evil = makeEvil(cloneDir, tmpDir, { remote })
//   ...run the loop's git...
//   assert.deepEqual(evil.hits(), [])
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const HOOKS = [
  'pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-push', 'post-checkout', 'post-merge',
  'reference-transaction', 'post-index-change', 'fsmonitor-watchman', 'pre-auto-gc'
]

/** @param {string} dir the clone  @param {string} scratch an empty directory for the scripts and the markers
 *  @param {{ remote?: string }} [opts] `remote`: origin's path (a local transport, so `remote.origin.uploadpack` is exercised) */
export function makeEvil(dir, scratch, opts = {}) {
  const bin = path.join(scratch, 'bin')
  const hit = path.join(scratch, 'hit')
  const hookDir = path.join(scratch, 'evil-hooks')
  for (const d of [bin, hit, hookDir]) fs.mkdirSync(d, { recursive: true })
  const cfg = (...a) => execFileSync('git', ['-C', dir, 'config', '--local', ...a], { stdio: 'ignore' })
  /** An executable that leaves the marker `name`, then does `body`. */
  const script = (name, body = 'exit 0') => {
    const file = path.join(bin, name)
    fs.writeFileSync(file, `#!/bin/sh\ntouch ${JSON.stringify(path.join(hit, name))}\n${body}\n`, { mode: 0o755 })
    return file
  }

  for (const h of HOOKS) {
    fs.writeFileSync(path.join(dir, '.git', 'hooks', h), `#!/bin/sh\ntouch ${JSON.stringify(path.join(hit, `hook-${h}`))}\nexit 0\n`, { mode: 0o755 })
    fs.writeFileSync(path.join(hookDir, h), `#!/bin/sh\ntouch ${JSON.stringify(path.join(hit, `hookspath-${h}`))}\nexit 0\n`, { mode: 0o755 })
  }
  cfg('core.hooksPath', hookDir)
  cfg('core.fsmonitor', script('fsmonitor'))
  cfg('core.pager', script('pager', 'cat'))
  cfg('core.sshCommand', script('ssh'))
  cfg('core.askPass', script('askpass'))
  cfg('core.gitProxy', script('gitproxy'))
  // A filter on every path, as a clean/smudge pair and as a long-running process.
  cfg('filter.evil.clean', script('filter-clean', 'cat'))
  cfg('filter.evil.smudge', script('filter-smudge', 'cat'))
  cfg('filter.evil.process', script('filter-process', 'exit 1'))
  cfg('filter.evil.required', 'true')
  fs.writeFileSync(path.join(dir, '.git', 'info', 'attributes'), '* filter=evil diff=tc\n')
  cfg('diff.external', script('diff-external'))
  cfg('diff.tc.textconv', script('textconv', 'cat "$1"'))
  cfg('diff.tc.command', script('diff-command'))
  // Signing a commit would run this program.
  cfg('commit.gpgsign', 'true')
  cfg('gpg.program', script('gpg', 'exit 1'))
  cfg('credential.helper', script('credential-helper'))
  // ext:: is a command in the guise of a URL, once the clone allows it.
  cfg('protocol.ext.allow', 'always')
  cfg('remote.evilext.url', `ext::${script('ext')} %S`)
  if (opts.remote) {
    cfg('remote.origin.uploadpack', script('uploadpack', 'exec git upload-pack "$@"'))
    cfg('remote.origin.receivepack', script('receivepack', 'exec git receive-pack "$@"'))
  }

  /** What ran: marker names, sorted. */
  return { hits: () => fs.readdirSync(hit).sort() }
}
