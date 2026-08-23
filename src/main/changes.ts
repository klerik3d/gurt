// Task Changes panel: the delivery thread of the task's clones vs the default
// branch, computed on the host from git alone — no forge APIs, no state outside
// the clone, works with containers stopped.
// See docs/requirements-changes-thread.md.
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { ChangedFile, DiffPair, DiffTarget, RepoChanges, ThreadCommit } from '../shared/types'
import { run } from './provision'
import { cloneDir, taskDir } from './store'
import { hostGitAccessForRepo, type HostGitAccess } from './git/env'
import { canonicalRepoId } from '../shared/repoId'
import { createLogger } from './log'

const log = createLogger('changes')

/** Bounds a fetch against an unreachable origin; failure is non-fatal anyway. */
const FETCH_TIMEOUT_MS = 30_000

/** Bounds a push — fatal (unlike a fetch) and legitimately slower on a thin
 *  uplink, so generous; a dead network must still surface as an error rather
 *  than an await that never settles. */
const PUSH_TIMEOUT_MS = 120_000

/** Per-clone chain for the *mutating* git operations (fetch/commit/push/merge):
 *  interleaved they fight over `.git/index.lock` at best, and at worst a
 *  `commit` runs `add -A` in the middle of `updateFromMain`'s merge and stages
 *  its conflict markers. Reads stay unchained — git serves them concurrently. */
const cloneChains = new Map<string, Promise<unknown>>()

function serialized<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const next = Promise.resolve(cloneChains.get(dir))
    .catch(() => {})
    .then(fn)
  cloneChains.set(
    dir,
    next.catch(() => {})
  )
  return next
}

interface GitOpts {
  /** Exit codes to treat as success (default [0]). */
  okCodes?: number[]
  timeoutMs?: number
  /** This call's argv carries prose (a commit message) — traced as an
   *  argument count, never the values. See `run`'s `opaqueArgv`. */
  opaqueArgv?: boolean
}

/**
 * Non-interactive host git in the clone dir; resolves stdout. Every call runs
 * under the repo's resolved access (§8) — env plus `-c` config args — so no
 * operation can silently reach ambient credentials.
 */
function git(dir: string, access: HostGitAccess, args: string[], opts: GitOpts = {}): Promise<string> {
  return run('git', ['-C', dir, ...access.gitArgs, ...args], () => {}, {
    env: access.env,
    ...opts
  })
}

const branchFor = (task: string) => task

/** SHA of `ref`, or '' when it does not exist. */
async function revParse(dir: string, access: HostGitAccess, ref: string): Promise<string> {
  return (
    await git(dir, access, ['rev-parse', '--verify', '--quiet', ref], { okCodes: [0, 1] })
  ).trim()
}

/** Short name of the default branch: `origin/HEAD`, fallback `main`. */
async function defaultBranch(dir: string, access: HostGitAccess): Promise<string> {
  const ref = (
    await git(dir, access, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')
  ).trim()
  return ref.replace(/^origin\//, '') || 'main'
}

/** Parse one `git status --porcelain` line into a ChangedFile. */
function parseStatusLine(line: string): ChangedFile | null {
  if (line.length < 4) return null
  const x = line[0]
  const y = line[1]
  // Same condition as the length check above, spelled so the compiler can see
  // it: `line[0]`/`line[1]` are only `string | undefined` to the type system.
  if (x === undefined || y === undefined) return null
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
  const id = canonicalRepoId(url)
  if (!id) return null
  const segs = id.path.split('/')
  if (segs.length < 2 || !segs[0] || !segs[1]) return null
  return { host: id.host, owner: segs[0], repo: segs[1] }
}

/** Origin host → PR compare URL. MVP scope: one entry; an unknown host gets no button. */
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
async function compareUrl(dir: string, access: HostGitAccess, task: string): Promise<string | null> {
  const origin = (await git(dir, access, ['remote', 'get-url', 'origin']).catch(() => '')).trim()
  const parsed = parseOrigin(origin)
  if (!parsed) return null
  const forge = FORGES.find((f) => f.match(parsed.host))
  if (!forge) return null
  return forge.compareUrl(parsed, await defaultBranch(dir, access), branchFor(task))
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
function fetchPrune(dir: string, access: HostGitAccess, task: string): Promise<void> {
  return serialized(dir, async () => {
    const remoteRef = `refs/remotes/origin/${branchFor(task)}`
    const before = await revParse(dir, access, remoteRef)
    try {
      await git(dir, access, ['fetch', '--prune', 'origin'], { timeoutMs: FETCH_TIMEOUT_MS })
    } catch (e) {
      // Non-fatal: the panel renders the refs as they are (WRN, not ERR).
      log.warn('fetch failed', { dir, err: e })
      return
    }
    // Pruned while it pointed at HEAD → the thread landed on the remote.
    if (!before || (await revParse(dir, access, remoteRef))) return
    if (before === (await revParse(dir, access, 'HEAD')))
      await git(dir, access, ['update-ref', 'refs/gurt/integrated', before])
  })
}

/**
 * Commits in `<base>..HEAD`, newest first, each pushed or local. A null `base`
 * means the default branch has no remote ref (a clone of an empty remote): the
 * whole of HEAD is the thread, and `log` itself fails while HEAD is unborn.
 */
async function threadCommits(
  dir: string,
  access: HostGitAccess,
  task: string,
  base: string | null
): Promise<ThreadCommit[]> {
  const commits = await git(dir, access, [
    'log',
    '--format=%H%x00%s',
    base ? `${base}..HEAD` : 'HEAD'
  ]).catch(() => '')
  const remoteRef = `refs/remotes/origin/${branchFor(task)}`
  const pushed = new Set(
    (
      await git(dir, access, ['rev-list', base ? `${base}..${remoteRef}` : remoteRef]).catch(
        () => ''
      )
    )
      .split('\n')
      .filter(Boolean)
  )
  return commits
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      // Lines are non-empty (filtered above), so the sha is always there; the
      // subject is absent for a commit with an empty message.
      const [sha = '', subject = ''] = line.split('\0')
      return { sha, subject, pushed: pushed.has(sha) }
    })
}

async function repoChanges(
  ws: string,
  task: string,
  repo: string,
  fetch: boolean
): Promise<RepoChanges> {
  const dir = cloneDir(ws, task, repo)
  const access = await hostGitAccessForRepo(ws, repo)
  if (fetch) await fetchPrune(dir, access, task)

  // `-uall` lists every untracked file individually; the default `normal` mode
  // collapses a wholly-untracked directory into one `newdir/` entry, hiding its files.
  const porcelain = await git(dir, access, ['status', '--porcelain', '-uall'])
  const files = porcelain
    .split('\n')
    .filter((l) => l.trim())
    .map(parseStatusLine)
    .filter((f): f is ChangedFile => f !== null)

  // Untracked files count toward the file count only.
  let insertions = 0
  let deletions = 0
  const shortstat = await git(dir, access, ['diff', 'HEAD', '--shortstat']).catch(() => '')
  const ins = /(\d+) insertion/.exec(shortstat)?.[1]
  const del = /(\d+) deletion/.exec(shortstat)?.[1]
  if (ins) insertions = parseInt(ins, 10)
  if (del) deletions = parseInt(del, 10)

  const def = await defaultBranch(dir, access)
  // A clone of an empty remote has no `origin/<def>` to compare against, and it
  // stays that way for the life of the clone — pushes go to `<task>`, never
  // to the default branch — so this is resolved on every call, not once.
  const base = (await revParse(dir, access, `origin/${def}`)) ? `origin/${def}` : null
  const commits = await threadCommits(dir, access, task, base)
  const marker = await revParse(dir, access, 'refs/gurt/integrated')
  const integrated =
    commits.length === 0 || (!!marker && marker === (await revParse(dir, access, 'HEAD')))
  const url = commits.some((c) => c.pushed) ? await compareUrl(dir, access, task) : null
  const behindOut = base
    ? await git(dir, access, ['rev-list', '--count', `HEAD..${base}`]).catch(() => '0')
    : '0'
  const behind = parseInt(behindOut.trim(), 10) || 0
  const conflicted = !!(await revParse(dir, access, 'MERGE_HEAD'))

  return {
    repo,
    dirty: files.length > 0,
    files,
    insertions,
    deletions,
    defaultBranch: def,
    commits,
    integrated,
    behind,
    conflicted,
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
      log.warn('repo skipped', { ws, task, repo: entry.name, err: e })
    }
  }
  return out.sort((a, b) => a.repo.localeCompare(b.repo))
}

// --- split review: file lists and before/after pairs -----------------------
// See docs/requirements-manual-review.md. The host returns whole file content
// and lets the renderer align it; nothing here knows about hunks.

/** Parse `--name-status` output (`M\tpath`, `R100\told\tnew`) into ChangedFile. */
function parseNameStatus(out: string): ChangedFile[] {
  const files: ChangedFile[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    const code = parts[0]?.[0]
    // A rename/copy line carries both paths; the panel shows the new one.
    const p = code === 'R' || code === 'C' ? parts[2] : parts[1]
    if (!code || !p) continue
    files.push({ path: p, status: code })
  }
  return files
}

/** Files a review target touches — the same list the Changes panel shows for
 *  `uncommitted`, and the commit's own `--name-status` for `commit`. */
export async function getDiffFiles(
  ws: string,
  task: string,
  repo: string,
  target: DiffTarget
): Promise<ChangedFile[]> {
  const dir = cloneDir(ws, task, repo)
  const access = await hostGitAccessForRepo(ws, repo)
  if (target.kind === 'uncommitted') {
    const porcelain = await git(dir, access, ['status', '--porcelain', '-uall'])
    return porcelain
      .split('\n')
      .filter((l) => l.trim())
      .map(parseStatusLine)
      .filter((f): f is ChangedFile => f !== null)
  }
  // `--format=` drops the commit header, leaving only the name-status body.
  return parseNameStatus(
    await git(dir, access, ['show', '--name-status', '--format=', assertSha(target.sha)])
  )
}

/** A `sha` arriving over IPC becomes argv — accept only what a SHA can look
 *  like, so nothing can smuggle a leading `-` past git's option parser. */
function assertSha(sha: string): string {
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) throw new Error(`not a commit sha: "${sha}"`)
  return sha
}

/**
 * A review path arriving over IPC is used two ways — as `<rev>:<path>` for git
 * and as a host path under the clone — and `git show` resolves `..` against the
 * repo root just as the filesystem does. Confine it to the clone before either.
 */
function assertRepoPath(file: string): string {
  const norm = path.normalize(file)
  if (!file || path.isAbsolute(norm) || norm === '..' || norm.startsWith(`..${path.sep}`))
    throw new Error(`path escapes the repository: "${file}"`)
  return norm
}

/** Content of `<rev>:<file>`, or '' when the path does not exist at that rev
 *  (a file the target adds, or one it deletes). */
async function blob(dir: string, access: HostGitAccess, rev: string, file: string): Promise<string> {
  return git(dir, access, ['show', `${rev}:${file}`]).catch(() => '')
}

/**
 * Git's own binary verdict, via `--numstat`: it reports `-` for both counts of a
 * binary file. Cheaper and more faithful than sniffing the content we would
 * otherwise have to decode as utf8 first.
 */
function isBinaryNumstat(out: string): boolean {
  const line = out.split('\n').find((l) => l.trim())
  return !!line && line.startsWith('-\t-')
}

/** Before/after content of one file of a review target. */
export async function getDiffPair(
  ws: string,
  task: string,
  repo: string,
  target: DiffTarget,
  rawFile: string
): Promise<DiffPair> {
  const dir = cloneDir(ws, task, repo)
  const access = await hostGitAccessForRepo(ws, repo)
  const file = assertRepoPath(rawFile)

  if (target.kind === 'commit') {
    const sha = assertSha(target.sha)
    const numstat = await git(dir, access, [
      'show', '--numstat', '--format=', sha, '--', file
    ]).catch(() => '')
    if (isBinaryNumstat(numstat)) return { binary: true }
    return {
      binary: false,
      // A root commit has no `^`; `blob` folds that into an empty before-side,
      // which is exactly right — the whole file reads as added.
      before: await blob(dir, access, `${sha}^`, file),
      after: await blob(dir, access, sha, file)
    }
  }

  const status = await git(dir, access, ['status', '--porcelain', '--', file])
  const untracked = status.startsWith('??')
  const numstat = untracked
    ? // `--no-index` exits 1 when the files differ — the success case here.
      await git(dir, access, ['diff', '--numstat', '--no-index', '--', '/dev/null', file], {
        okCodes: [0, 1]
      }).catch(() => '')
    : await git(dir, access, ['diff', 'HEAD', '--numstat', '--', file]).catch(() => '')
  if (isBinaryNumstat(numstat)) return { binary: true }
  return {
    binary: false,
    before: untracked ? '' : await blob(dir, access, 'HEAD', file),
    // Deleted in the working tree → no file to read → an empty after-side.
    after: await fs.readFile(path.join(dir, file), 'utf8').catch(() => '')
  }
}

/** Read-only unified diff for one file: `diff HEAD` for tracked, whole-file-added for untracked. */
export async function getFileDiff(
  ws: string,
  task: string,
  repo: string,
  file: string
): Promise<string> {
  const dir = cloneDir(ws, task, repo)
  const access = await hostGitAccessForRepo(ws, repo)
  const status = await git(dir, access, ['status', '--porcelain', '--', file])
  if (status.startsWith('??')) {
    // `git diff --no-index` exits 1 when the files differ — that's the success case.
    return git(dir, access, ['diff', '--no-index', '--', '/dev/null', file], { okCodes: [0, 1] })
  }
  return git(dir, access, ['diff', 'HEAD', '--', file])
}

/** Read-only `git show` of one commit of the thread. */
export async function getCommitDiff(
  ws: string,
  task: string,
  repo: string,
  sha: string
): Promise<string> {
  return git(cloneDir(ws, task, repo), await hostGitAccessForRepo(ws, repo), ['show', sha])
}

export async function commit(ws: string, task: string, repo: string, message: string): Promise<void> {
  const dir = cloneDir(ws, task, repo)
  const access = await hostGitAccessForRepo(ws, repo)
  await serialized(dir, async () => {
    await git(dir, access, ['add', '-A'])
    // The message is user/agent prose — never logged, matching ipc.ts's
    // OPAQUE_ARGS treatment of `changesCommit` at the IPC boundary.
    await git(dir, access, ['commit', '-m', message], { opaqueArgv: true })
  })
}

export async function push(ws: string, task: string, repo: string): Promise<void> {
  const dir = cloneDir(ws, task, repo)
  const access = await hostGitAccessForRepo(ws, repo)
  await serialized(dir, () =>
    git(dir, access, ['push', '-u', 'origin', branchFor(task)], { timeoutMs: PUSH_TIMEOUT_MS })
  )
}

/**
 * Merges the fetched default branch into the task branch. Exit code 1 (merge
 * left conflicts) is not an error here — it surfaces as `conflicted` on the
 * next `getTaskChanges`, for the user (or agent, inside the container) to
 * resolve like any other local conflict, rather than on the forge.
 */
export async function updateFromMain(ws: string, task: string, repo: string): Promise<void> {
  const dir = cloneDir(ws, task, repo)
  const access = await hostGitAccessForRepo(ws, repo)
  await serialized(dir, async () => {
    await git(dir, access, ['fetch', 'origin'], { timeoutMs: FETCH_TIMEOUT_MS })
    const def = await defaultBranch(dir, access)
    // Nothing to merge from an empty remote — the default branch has no ref yet.
    if (!(await revParse(dir, access, `origin/${def}`))) return
    await git(dir, access, ['merge', `origin/${def}`, '--no-edit'], { okCodes: [0, 1] })
  })
}

/** MVP delivery: the forge's compare URL for <task> (the IPC layer opens it). */
export async function prUrl(ws: string, task: string, repo: string): Promise<string> {
  const dir = cloneDir(ws, task, repo)
  const url = await compareUrl(dir, await hostGitAccessForRepo(ws, repo), task)
  if (!url) throw new Error('origin is not a known forge remote')
  return url
}

/**
 * Best-effort follow-up to a task rename: point each clone's local task branch
 * at the new name. Runs against the already-moved task dir, so `task` is the
 * new name and `oldTask` the one to look for. A clone with no such branch yet
 * (never provisioned, or provisioned under a different scheme) is skipped
 * rather than failing the whole rename.
 */
export async function renameTaskBranches(ws: string, task: string, oldTask: string): Promise<void> {
  const dir = taskDir(ws, task)
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue
    const repoDir = path.join(dir, entry.name)
    if (!existsSync(path.join(repoDir, '.git'))) continue
    const access = await hostGitAccessForRepo(ws, entry.name)
    const oldBranch = branchFor(oldTask)
    if (!(await revParse(repoDir, access, oldBranch))) continue
    await git(repoDir, access, ['branch', '-m', oldBranch, branchFor(task)]).catch((e: unknown) =>
      log.warn('branch rename failed', { dir: repoDir, err: e })
    )
  }
}

/** MVP escape hatch: open the clone with host VS Code. */
export function openInVscode(ws: string, task: string, repo: string): Promise<void> {
  const dir = cloneDir(ws, task, repo)
  return new Promise((resolve, reject) => {
    const child = spawn('code', ['--new-window', dir], { stdio: 'ignore', detached: true })
    child.on('error', () =>
      reject(new Error('could not launch "code" — install the VS Code shell command'))
    )
    child.on('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
