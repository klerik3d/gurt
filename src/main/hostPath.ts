// The PATH a GUI app has to repair before it can shell out to anything.
//
// gurt spawns `docker` (every session's container), `git` (every clone), `tar`,
// the devcontainer CLI (which spawns `docker` itself), and whatever command a
// local MCP entry names. On macOS none of that is guaranteed to resolve as
// shipped: a bundle launched from Finder or the Dock inherits launchd's PATH —
// `/usr/bin:/bin:/usr/sbin:/sbin` — not the login shell's, while Docker
// Desktop installs its CLI into `/usr/local/bin` or `~/.docker/bin` and
// Homebrew into `/opt/homebrew/bin`. The symptom is a first start that dies
// with `spawn docker ENOENT` in an app that works perfectly when launched from
// a terminal. This was first hit for MCP commands
// (docs/requirements-mcp-stdio.md §4.2, §4.3); it is the same problem, with the
// same fix, for the binaries gurt itself runs.
//
// Two halves, in one module so there is one list of directories:
//
//   - {@link applyHostPath} repairs `process.env.PATH` once at startup, so
//     every child inherits it — including the ones gurt never names, like the
//     `docker` the devcontainer CLI spawns.
//   - {@link resolveHostCommand} answers "is this binary on this machine at
//     all", which is what turns an ENOENT an hour later into a message at the
//     moment it can still be acted on: when an MCP entry is saved, or when a
//     session start is refused (`assertDockerCli` in provision.ts).
import { accessSync, statSync, constants as FS } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Directories a GUI-launched process is missing from its PATH on macOS, and
 *  where a user's own tools live on Linux. Appended, never prepended: the
 *  user's PATH wins where it has an opinion.
 *
 *  The `docker` entries are the CLI locations of the runtimes people actually
 *  install — Docker Desktop symlinks into `/usr/local/bin` but keeps the real
 *  binary in `~/.docker/bin`, and OrbStack and Rancher Desktop ship their own
 *  directories that only a shell rc file ever puts on PATH. */
const EXTRA_PATH_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(os.homedir(), '.docker', 'bin'),
  path.join(os.homedir(), '.orbstack', 'bin'),
  path.join(os.homedir(), '.rd', 'bin'),
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.cargo', 'bin'),
  '/usr/bin',
  '/bin'
]

/** PATH with {@link EXTRA_PATH_DIRS} on the end, de-duplicated. */
export function hostPath(env: NodeJS.ProcessEnv = process.env): string {
  const seen = new Set<string>()
  const dirs: string[] = []
  for (const dir of [...(env['PATH'] ?? '').split(path.delimiter), ...EXTRA_PATH_DIRS]) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    dirs.push(dir)
  }
  return dirs.join(path.delimiter)
}

/**
 * Repair `process.env.PATH` in place. Called once, before anything is spawned,
 * so a child that gurt hands no env of its own is still able to find `docker`.
 * Idempotent: {@link hostPath} de-duplicates, so a second call is a no-op.
 * Returns the PATH it installed, for the start banner.
 */
export function applyHostPath(): string {
  const repaired = hostPath()
  process.env['PATH'] = repaired
  return repaired
}

/**
 * Where a command name actually is, or null. Synchronous and eager on purpose:
 * this is what the *save* path calls, so "there is no `uvx` on this machine"
 * is a rejected registry entry rather than a session that fails to start an
 * hour later (docs/requirements-mcp-stdio.md §4.3).
 *
 * A name containing a separator is a path and is only checked for existence; a
 * bare name is searched along {@link hostPath}. `PATHEXT` is not consulted —
 * gurt does not run on Windows.
 */
export function resolveHostCommand(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  // `X_OK` alone is not enough: every directory on PATH is executable, so a
  // blank command would "resolve" to the directory it was joined onto.
  const executable = (file: string): boolean => {
    try {
      accessSync(file, FS.X_OK)
      return statSync(file).isFile()
    } catch {
      return false
    }
  }
  if (!command.trim()) return null
  if (command.includes('/')) {
    const abs = path.resolve(command)
    return executable(abs) ? abs : null
  }
  for (const dir of hostPath(env).split(path.delimiter)) {
    const candidate = path.join(dir, command)
    if (executable(candidate)) return candidate
  }
  return null
}
