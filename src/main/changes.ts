// Task Changes panel: the delivery thread of the task's clones vs the default
// branch, computed on the host from git alone — no forge APIs, no state outside
// the clone, works with containers stopped.
// See docs/requirements-changes-thread.md.
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'
import type { ChangedFile, RepoChanges, ThreadCommit } from '../shared/types'
import { run } from './provision'
import { cloneDir, taskDir } from './store'

/** Bounds a fetch against an unreachable origin; failure is non-fatal anyway. */
const FETCH_TIMEOUT_MS = 30_000

interface GitOpts {
  /** Exit codes to treat as success (default [0]). */
  okCodes?: number[]
  timeoutMs?: number
}

/** Non-interactive host git in the clone dir; resolves stdout. */
function git(dir: string, args: string[], opts: GitOpts = {}): Promise<string> {
  return run('git', ['-C', dir, ...args], () => {}, {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    ...opts
  })
}

const branchFor = (task: string) => `gurt/${task}`

/** SHA of `ref`, or '' when it does not exist. */
async function revParse(dir: string, ref: string): Promise<string> {
  return (await git(dir, ['rev-parse', '--verify', '--quiet', ref], { okCodes: [0, 1] })).trim()
}

/** Short name of the default branch: `origin/HEAD`, fallback `main`. */
async function defaultBranch(dir: string): Promise<string> {
  const ref = (
    await git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')
  ).trim()
  return ref.replace(/^origin\//, '') || 'main'
}

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

interface Origin {
  host: string
  owner: string
  repo: string
}

/** host + owner/repo parsed from the origin URL (scheme or scp-like), or null. */
function parseOrigin(url: string): Origin | null {
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

/** Origin host → PR compare URL. PoC scope: one entry; an unknown host gets no button. */
const FORGES: {
  match: (host: string) => boolean
  compareUrl: (o: Origin, def: string, branch: string) => string
}[] = [
  {
    // SSH host aliases like github.com-personal count.
    match: (host) => host.includes('github'),
    compareUrl: (o, def, branch) =>
      `https://github.com/${o.owner}/${o.repo}/compare/${def}...${branch}?expand=1`
  }
]

/** Compare URL for the task branch, or null when the origin matches no forge. */
async function compareUrl(dir: string, task: string): Promise<string | null> {
  const origin = (await git(dir, ['remote', 'get-url', 'origin']).catch(() => '')).trim()
  const parsed = parseOrigin(origin)
  if (!parsed) return null
  const forge = FORGES.find((f) => f.match(parsed.host))
  if (!forge) return null
  return forge.compareUrl(parsed, await defaultBranch(dir), branchFor(task))
}

/**
 * `git fetch --prune origin`, and the integration signal derived from it.
 *
 * Squash merges rewrite SHAs, so `<default>..HEAD` never empties by ancestry; what
 * marks the thread as landed is the remote branch disappearing. Accepted trade-off:
 * deleting an unmerged remote branch also counts as integrated.
 *
 * Failure is non-fatal — the caller renders last-known refs, with no error UI.
 */
async function fetchPrune(dir: string, task: string): Promise<void> {
  const remoteRef = `refs/remotes/origin/${branchFor(task)}`
  const before = await revParse(dir, remoteRef)
  try {
    await git(dir, ['fetch', '--prune', 'origin'], { timeoutMs: FETCH_TIMEOUT_MS })
  } catch (e) {
    console.error(`changes: fetch failed in ${dir}:`, e)
    return
  }
  // Pruned while it pointed at HEAD → the thread landed on the remote.
  if (!before || (await revParse(dir, remoteRef))) return
  if (before === (await revParse(dir, 'HEAD')))
    await git(dir, ['update-ref', 'refs/gurt/integrated', before])
}

/** Commits in `<base>..HEAD`, newest first, each pushed or local. */
async function threadCommits(dir: string, task: string, base: string): Promise<ThreadCommit[]> {
  const log = await git(dir, ['log', '--format=%H%x00%s', `${base}..HEAD`])
  const pushed = new Set(
    (
      await git(dir, [
        'rev-list',
        `${base}..refs/remotes/origin/${branchFor(task)}`
      ]).catch(() => '')
    )
      .split('\n')
      .filter(Boolean)
  )
  return log
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, subject] = line.split('\0')
      return { sha, subject: subject ?? '', pushed: pushed.has(sha) }
    })
}

async function repoChanges(
  ws: string,
  task: string,
  repo: string,
  fetch: boolean
): Promise<RepoChanges> {
  const dir = cloneDir(ws, task, repo)
  if (fetch) await fetchPrune(dir, task)

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

  const def = await defaultBranch(dir)
  const commits = await threadCommits(dir, task, `origin/${def}`)
  const marker = await revParse(dir, 'refs/gurt/integrated')
  const integrated = commits.length === 0 || (!!marker && marker === (await revParse(dir, 'HEAD')))
  const url = commits.some((c) => c.pushed) ? await compareUrl(dir, task) : null

  return {
    repo,
    dirty: files.length > 0,
    files,
    insertions,
    deletions,
    defaultBranch: def,
    commits,
    integrated,
    ...(url ? { prUrl: url } : {})
  }
}

/**
 * Git state for every clone of the task. Rendered from disk, not configuration:
 * any task-dir subdirectory with a `.git` is a clone. A repo whose git commands
 * fail is skipped rather than failing the whole panel.
 *
 * `fetch` reaches the network — panel open, manual refresh, after an action. The
 * cheap triggers (app start, end of an agent turn) read the refs as they are.
 */
export async function getTaskChanges(
  ws: string,
  task: string,
  opts: { fetch?: boolean } = {}
): Promise<RepoChanges[]> {
  const dir = taskDir(ws, task)
  const out: RepoChanges[] = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue
    if (!existsSync(path.join(dir, entry.name, '.git'))) continue
    try {
      out.push(await repoChanges(ws, task, entry.name, opts.fetch === true))
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
    return git(dir, ['diff', '--no-index', '--', '/dev/null', file], { okCodes: [0, 1] })
  }
  return git(dir, ['diff', 'HEAD', '--', file])
}

/** Read-only `git show` of one commit of the thread. */
export function getCommitDiff(ws: string, task: string, repo: string, sha: string): Promise<string> {
  return git(cloneDir(ws, task, repo), ['show', sha])
}

export async function commit(ws: string, task: string, repo: string, message: string): Promise<void> {
  const dir = cloneDir(ws, task, repo)
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-m', message])
}

export async function push(ws: string, task: string, repo: string): Promise<void> {
  await git(cloneDir(ws, task, repo), ['push', '-u', 'origin', branchFor(task)])
}

/** PoC delivery: open the browser at the forge's compare URL for gurt/<task>. */
export async function openPr(ws: string, task: string, repo: string): Promise<void> {
  const dir = cloneDir(ws, task, repo)
  const url = await compareUrl(dir, task)
  if (!url) throw new Error('origin is not a known forge remote')
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
