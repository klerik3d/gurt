// Holding a host `git commit` in flight, without a git hook. The review loop's
// host git runs NO clone hook (docs/requirements-review-loop.md §6, §10: the
// clone's hooks are the agent's), so the tests that used a `pre-commit` /
// `post-commit` hook to freeze delivery at its first step use a `git` shim on
// PATH instead: it passes everything through and, for a `commit`, waits on
// files in $GATE_DIR while $GATE_COMMIT is set.
//
//   GATE_COMMIT=pre   — before the commit: touch reached-pre-commit, wait for
//                       `go`, then exit 1 (the commit never happens)
//   GATE_COMMIT=hold  — the same wait, then the commit runs (a step merely held)
//   GATE_COMMIT=post  — the commit runs, then: touch reached-post-commit, wait
//                       for `go`, exit with the commit's status
//
// The env vars are read from the spawning process' env, so only git started
// while they are set is held.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** Put the shim first on PATH (once per process). Returns its directory. */
export function installGitGate(parent) {
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  const dir = fs.mkdtempSync(path.join(parent, 'git-gate-'))
  fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh
real=${JSON.stringify(real)}
if [ -n "$GATE_DIR" ] && [ -n "$GATE_COMMIT" ]; then
  sub=""; prev=""
  for a in "$@"; do
    if [ -n "$prev" ]; then prev=""; continue; fi
    case "$a" in -C|-c) prev=1; continue;; -*) continue;; esac
    sub="$a"; break
  done
  if [ "$sub" = commit ]; then
    wait_go() { touch "$GATE_DIR/reached-$1"; n=0; while [ ! -f "$GATE_DIR/go" ] && [ $n -lt 1200 ]; do sleep 0.05; n=$((n+1)); done; }
    case "$GATE_COMMIT" in
      pre) wait_go pre-commit; exit 1 ;;
      hold) wait_go pre-commit ;;
      post) "$real" "$@"; rc=$?; wait_go post-commit; exit $rc ;;
    esac
  fi
fi
exec "$real" "$@"
`, { mode: 0o755 })
  process.env.PATH = `${dir}:${process.env.PATH}`
  return dir
}

/** Hold the next host `git commit` (any clone) until `open()`. */
export function gateCommit(parent, mode = 'hold') {
  const gate = fs.mkdtempSync(path.join(parent, 'gate-'))
  process.env.GATE_DIR = gate
  process.env.GATE_COMMIT = mode
  return {
    gate,
    reached: () => fs.existsSync(path.join(gate, 'reached-pre-commit')) || fs.existsSync(path.join(gate, 'reached-post-commit')),
    open: () => {
      fs.writeFileSync(path.join(gate, 'go'), '')
      delete process.env.GATE_DIR
      delete process.env.GATE_COMMIT
    }
  }
}
