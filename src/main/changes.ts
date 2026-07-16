// Task Changes panel: git state of the task's clones, computed on the host —
// works with containers stopped. See docs/requirements-changes-panel.md.
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'
import type { ChangedFile, RepoChanges } from '../shared/types'
import { run } from './provision'
import { cloneDir, taskDir } from './store'

/** Non-interactive host git in the clone dir; resolves stdout. */
function git(dir: string, args: string[], okCodes?: number[]): Promise<string> {
  return run('git', ['-C', dir, ...args], () => {}, {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    okCodes
  })
}

const branchFor = (task: string) => `gurt/${task}`

/** Parse one `git status --porcelain` line into a ChangedFile. */
function parseStatusLine(line: string): ChangedFile | null {
  if (line.length < 4) return null
  const x = line[0]
  const y = line[1]
  let p = line.slice(3)
  // Renames list `old -> new`; the panel shows the new path.
  const arrow = p.indexOf(' -> ')
  if (arrow >= 0) p = p.slice(arrow + 4)
  // Paths with special characters come C-quoted.
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1)
  const status =
    x === '?' ? 'A' : x === 'R' || y === 'R' ? 'R' : x !== ' ' ? x : y
  return { path: p, status }
}

/** Local commits not on the remote: upstream if set, else origin/HEAD. */
async function aheadCount(dir: string): Promise<number> {
  for (const base of ['@{u}', 'origin/HEAD']) {
    try {
      return parseInt((await git(dir, ['rev-list', '--count', `${base}..HEAD`])).trim(), 10) || 0
    } catch {
      // no upstream / no origin/HEAD — try the next base
    }
  }
  return 0
}

/** host + owner/repo parsed from the origin URL (scheme or scp-like), or null. */
function parseOrigin(url: string): { host: string; owner: string; repo: string } | null {
  let host: string
  let p: string
  if (/^[a-z][\w+.-]*:\/\//i.test(url)) {
    try {
      const u = new URL(url)
      host = u.hostname
      p = u.pathname
    } catch {
      return null
    }
  } else {
    const m = url.match(/^(?:[^@/]+@)?([\w.-]+):(.+)$/)
    if (!m) return null
    host = m[1]
    p = m[2]
  }
  const segs = p.replace(/^\/+/, '').replace(/\.git$/, '').split('/')
  if (segs.length < 2 || !segs[0] || !segs[1]) return null
  return { host, owner: segs[0], repo: segs[1] }
}

async function repoChanges(ws: string, task: string, repo: string): Promise<RepoChanges> {
  const dir = cloneDir(ws, task, repo)
  const porcelain = await git(dir, ['status', '--porcelain'])
  const files = porcelain
    .split('\n')
    .filter((l) => l.trim())
    .map(parseStatusLine)
    .filter((f): f is ChangedFile => f !== null)

  // Untracked files count toward the file count only.
  let insertions = 0
  let deletions = 0
  const shortstat = await git(dir, ['diff', 'HEAD', '--shortstat']).catch(() => '')
  const ins = shortstat.match(/(\d+) insertion/)
  const del = shortstat.match(/(\d+) deletion/)
  if (ins) insertions = parseInt(ins[1], 10)
  if (del) deletions = parseInt(del[1], 10)

  const origin = (await git(dir, ['remote', 'get-url', 'origin']).catch(() => '')).trim()
  const parsed = parseOrigin(origin)
  const prAvailable = !!parsed && parsed.host.includes('github')

  let prReady = false
  if (prAvailable) {
    try {
      const remote = (
        await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branchFor(task)}`])
      ).trim()
      const head = (await git(dir, ['rev-parse', 'HEAD'])).trim()
      prReady = !!remote && remote === head
    } catch {
      prReady = false
    }
  }

  return {
    repo,
    dirty: files.length > 0,
    ahead: await aheadCount(dir),
    files,
    insertions,
    deletions,
    prAvailable,
    prReady
  }
}

/**
 * Git state for every clone of the task. Rendered from disk, not configuration:
 * any task-dir subdirectory with a `.git` is a clone. A repo whose git commands
 * fail is skipped rather than failing the whole panel.
 */
export async function getTaskChanges(ws: string, task: string): Promise<RepoChanges[]> {
  const dir = taskDir(ws, task)
  const out: RepoChanges[] = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue
    if (!existsSync(path.join(dir, entry.name, '.git'))) continue
    try {
      out.push(await repoChanges(ws, task, entry.name))
    } catch (e) {
      console.error(`changes: skipping ${ws}/${task}/${entry.name}:`, e)
    }
  }
  return out.sort((a, b) => a.repo.localeCompare(b.repo))
}

/** Read-only unified diff for one file: `diff HEAD` for tracked, whole-file-added for untracked. */
export async function getFileDiff(
  ws: string,
  task: string,
  repo: string,
  file: string
): Promise<string> {
  const dir = cloneDir(ws, task, repo)
  const status = await git(dir, ['status', '--porcelain', '--', file])
  if (status.startsWith('??')) {
    // `git diff --no-index` exits 1 when the files differ — that's the success case.
    return git(dir, ['diff', '--no-index', '--', '/dev/null', file], [0, 1])
  }
  return git(dir, ['diff', 'HEAD', '--', file])
}

export async function commit(ws: string, task: string, repo: string, message: string): Promise<void> {
  const dir = cloneDir(ws, task, repo)
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-m', message])
}

export async function push(ws: string, task: string, repo: string): Promise<void> {
  await git(cloneDir(ws, task, repo), ['push', '-u', 'origin', branchFor(task)])
}

/** PoC delivery: open the browser at the GitHub compare URL for gurt/<task>. */
export async function openPr(ws: string, task: string, repo: string): Promise<void> {
  const dir = cloneDir(ws, task, repo)
  const origin = (await git(dir, ['remote', 'get-url', 'origin'])).trim()
  const parsed = parseOrigin(origin)
  if (!parsed || !parsed.host.includes('github'))
    throw new Error(`origin is not a GitHub remote: ${origin}`)
  let def = 'main'
  try {
    const head = (await git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD'])).trim()
    def = head.replace('refs/remotes/origin/', '') || def
  } catch {
    // origin/HEAD unset — fall back to main
  }
  const url = `https://github.com/${parsed.owner}/${parsed.repo}/compare/${def}...${branchFor(task)}?expand=1`
  await shell.openExternal(url)
}

/** PoC escape hatch: open the clone with host VS Code. */
export function openInVscode(ws: string, task: string, repo: string): Promise<void> {
  const dir = cloneDir(ws, task, repo)
  return new Promise((resolve, reject) => {
    const child = spawn('code', [dir], { stdio: 'ignore', detached: true })
    child.on('error', () =>
      reject(new Error('could not launch "code" — install the VS Code shell command'))
    )
    child.on('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
