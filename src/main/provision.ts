import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_BASE_IMAGE, type EnvConfig, type EnvRef, type RepoConfig } from '../shared/types'
import type { AgentManifest } from '../shared/agentPlugin'
import { envImageTag, insideRoot, validateEnvConfig } from '../shared/envConfig'
import type { EnvImageStatus } from '../shared/api'
import { cloneDir, getWorkspace, historySlug, taskDir } from './store'
import { scopeBranch } from '../shared/scopeName'
import { gurtRoot } from './paths'
import { listCredentials } from './credentials'
import { hostGitAccess } from './git/env'
import { hostPath, resolveHostCommand } from './hostPath'
import { createLogger } from './log'

// Named `procLog` because most functions here take a `log: LogSink` sink.
const procLog = createLogger('proc')

/** Cap on the unterminated remainder buffered between chunks in `lineBuffer`. A
 *  process that never emits '\n' must not grow it without bound — matches the
 *  record truncation limit in log.ts. Well above any realistic secret length,
 *  but not a hard guarantee: a single line longer than this with no '\n' can
 *  still force a flush mid-secret, splitting it across two redacted records.
 *  Accepted as a rare edge case (real docker/git output does not run this
 *  long without a newline) — the unbounded-growth risk this cap prevents
 *  matters more than closing that last gap. */
const MAX_LINE_BUFFER = 32 * 1024

/**
 * Trace one child process. Container lifecycle steps are rare and slow enough
 * that they belong in the default log; the host probes below it (`git`,
 * `docker inspect`, `tar`) run several times per panel refresh, so they trace
 * at DBG — a failing one still surfaces at WRN. argv rides through the ctx
 * redactor, which scrubs `://user:pass@` URLs and every known secret value —
 * but that only catches known secrets, not free-form prose (a commit
 * message). A caller whose argv carries prose passes `opaqueArgv` so this
 * traces an argument count instead, never the values — the same treatment
 * `ipc.ts`'s `OPAQUE_ARGS` gives `changesCommit` at the IPC boundary; without
 * it that protection is defeated the moment the same call reaches a subprocess.
 */
function traceProc(
  level: 'info' | 'debug',
  cmd: string,
  argv: string[],
  pid: number | undefined,
  opaqueArgv = false
): (code: number | null, ms: number, ok: boolean) => void {
  procLog[level]('proc.spawn', {
    cmd,
    argv: opaqueArgv ? `${argv.length} arg(s) [not logged]` : argv,
    pid
  })
  let done = false
  return (code, ms, ok) => {
    // An 'error' after a successful spawn is followed by 'close' — one
    // `proc.exit` per process, whichever event fires first wins.
    if (done) return
    done = true
    const record = { cmd, pid, code, ms }
    if (ok) procLog[level]('proc.exit', record)
    else procLog.warn('proc.exit', record)
  }
}

export type LogSink = (line: string) => void

/**
 * Line-buffer a child's output before it reaches a sink. Redaction runs per
 * line, so a chunk boundary must never split a line on its way out: half a
 * secret in one record and half in the next would defeat it. `flush` emits the
 * unterminated remainder when the process ends.
 */
export function lineBuffer(sink: LogSink): { push: (chunk: Buffer) => void; flush: () => void } {
  // A chunk boundary can land mid multi-byte UTF-8 sequence; decoding each
  // chunk on its own would turn both halves into U+FFFD. The decoder carries
  // the partial sequence across chunks, the same way `rest` carries the
  // partial line.
  const utf8 = new StringDecoder('utf8')
  let rest = ''
  return {
    push(chunk) {
      rest += utf8.write(chunk)
      const lines = rest.split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) sink(line)
      // A line-less stream must not buffer forever: flush the remainder as a
      // partial line once it passes the cap, and start over.
      if (rest.length > MAX_LINE_BUFFER) {
        sink(rest)
        rest = ''
      }
    },
    flush() {
      const last = rest + utf8.end()
      rest = ''
      if (last.trim()) sink(last)
    }
  }
}

/** Bounds every docker/git probe below: a wedged daemon must surface as the
 *  probe's own failure value (false / null), not as an await that never
 *  settles — dockerVersion's comment states the hazard; this applies its
 *  answer to the rest. */
const PROBE_TIMEOUT_MS = 30_000

/** SIGKILL `child` after `ms`. The caller's own 'close' handler then resolves
 *  through its failure path (a killed child never exits 0), so every probe
 *  keeps its "could not ask" semantics without new plumbing. */
function killAfter(child: ChildProcess, ms: number): void {
  const timer = setTimeout(() => child.kill('SIGKILL'), ms)
  timer.unref?.()
  child.on('close', () => clearTimeout(timer))
  child.on('error', () => clearTimeout(timer))
}

interface RunOpts {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Kill the child and reject if it hasn't exited within this many ms. */
  timeoutMs?: number
  /** Exit codes to treat as success (default [0]) — e.g. `git diff` exits 1 on differences. */
  okCodes?: number[]
  /** This argv carries prose (a commit message, …) — `proc.spawn` traces an
   *  argument count instead of the values. See `traceProc`. */
  opaqueArgv?: boolean
  /** Container lifecycle steps (build, pull, create, start) are rare, slow and
   *  usually the thing being diagnosed: they trace at INF. Probes stay DBG. */
  level?: 'info' | 'debug'
}

/** Resolves with the child's stdout; exported for host-git modules (changes.ts). */
export function run(cmd: string, args: string[], sink: LogSink, opts: RunOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env })
    const exited = traceProc(opts.level ?? 'debug', cmd, args, child.pid, opts.opaqueArgv)
    // The last few lines are what a failure message quotes.
    const tail: string[] = []
    let stdout = ''
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error(`${cmd} ${args[0]} timed out after ${opts.timeoutMs}ms`))
        }, opts.timeoutMs)
      : undefined
    const emit = (line: string): void => {
      tail.push(line)
      if (tail.length > 3) tail.shift()
      sink(line)
    }
    const out = lineBuffer(emit)
    const err = lineBuffer(emit)
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
      out.push(d)
    })
    child.stderr.on('data', (d: Buffer) => err.push(d))
    child.on('error', (e) => {
      if (timer) clearTimeout(timer)
      out.flush()
      err.flush()
      exited(null, Date.now() - started, false)
      // A binary that is not there fails as `spawn docker ENOENT`, which names
      // neither the cause (a GUI app's PATH, see hostPath.ts) nor a remedy.
      // The PATH actually searched goes to the session log, not into the
      // message the session pane shows.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        sink(`${cmd} was not found on this machine — PATH searched: ${hostPath()}`)
        reject(new Error(`${cmd} is not installed, or is not on the PATH gurt searches`))
      } else reject(e)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      out.flush()
      err.flush()
      const ok = (opts.okCodes ?? [0]).includes(code ?? -1)
      exited(code, Date.now() - started, ok)
      if (ok) resolve(stdout)
      else reject(new Error(`${cmd} ${args[0]} failed (${code}): ${tail.join(' | ')}`))
    })
  })
}

/** True if `ref` exists in the clone. Callers pass a fully qualified ref on
 *  purpose: a short name would also match a tag or a remote-tracking ref
 *  through rev-parse's DWIM rules, and the answer decides create-vs-switch. */
async function refExists(
  dir: string,
  gitArgs: string[],
  env: NodeJS.ProcessEnv,
  ref: string
): Promise<boolean> {
  const out = await run(
    'git',
    ['-C', dir, ...gitArgs, 'rev-parse', '--verify', '--quiet', ref],
    () => {},
    { env, okCodes: [0, 1] }
  )
  return out.trim().length > 0
}

/** Short name of the checked-out branch, or '' when HEAD is detached. */
async function currentBranch(
  dir: string,
  gitArgs: string[],
  env: NodeJS.ProcessEnv
): Promise<string> {
  const out = await run(
    'git',
    ['-C', dir, ...gitArgs, 'symbolic-ref', '--quiet', '--short', 'HEAD'],
    () => {},
    { env, okCodes: [0, 1] }
  )
  return out.trim()
}

/** Short name of the clone's default branch (`origin/HEAD`), or '' when the
 *  remote names none (an empty remote). */
async function originHead(dir: string, gitArgs: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const out = await run(
    'git',
    ['-C', dir, ...gitArgs, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    () => {},
    { env, okCodes: [0, 1] }
  )
  return out.trim().replace(/^origin\//, '')
}

/** Files under the git dir that mark an operation git left half-finished. A
 *  rebase/cherry-pick that stopped on conflicts also detaches HEAD, so the
 *  branch check alone would not recognise it. */
const IN_PROGRESS_MARKERS = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'rebase-merge',
  'rebase-apply'
]

/** True while the clone is mid-merge / mid-rebase / mid-cherry-pick. */
async function operationInProgress(
  dir: string,
  gitArgs: string[],
  env: NodeJS.ProcessEnv
): Promise<boolean> {
  const gitDir = (
    await run('git', ['-C', dir, ...gitArgs, 'rev-parse', '--absolute-git-dir'], () => {}, {
      env
    }).catch(() => '')
  ).trim()
  if (!gitDir) return false
  return IN_PROGRESS_MARKERS.some((name) => existsSync(path.join(gitDir, name)))
}

/** Clone provisioning in flight, keyed by clone dir. One clone is shared by
 *  every env of a task (`~/.gurt/<ws>/<task>/<repo>/`), so two sessions of the
 *  same task starting at once would otherwise race over it: the second sees the
 *  half-written dir as an existing clone, and both run `checkout -b`, the loser
 *  failing with `a branch named '<task>' already exists`. Callers queue
 *  behind each other instead — the body is idempotent, so the follower just
 *  finds the finished clone. */
const clonesInFlight = new Map<string, Promise<string>>()

export function ensureClone(ref: EnvRef, repo: RepoConfig, log: LogSink, refresh = false): Promise<string> {
  const dir = cloneDir(ref.workspace, ref.task, repo.name)
  const prev = clonesInFlight.get(dir)
  // A failed predecessor must not fail this caller — it re-runs the work itself.
  const p = (prev ? prev.catch(() => {}) : Promise.resolve()).then(() =>
    provisionClone(dir, ref, repo, log, refresh)
  )
  clonesInFlight.set(dir, p)
  p.catch(() => {}).finally(() => {
    if (clonesInFlight.get(dir) === p) clonesInFlight.delete(dir)
  })
  return p
}

async function provisionClone(
  dir: string,
  ref: EnvRef,
  repo: RepoConfig,
  log: LogSink,
  refresh: boolean
): Promise<string> {
  // Same git-native contract as the container: a gurt-managed token clones over
  // https even from an ssh URL, and no operation blocks on a credential prompt.
  const { env, gitArgs } = await hostGitAccess(repo, await listCredentials())
  if (!existsSync(dir)) {
    await fs.mkdir(taskDir(ref.workspace, ref.task), { recursive: true })
    log(`cloning ${repo.url} ...`)
    await run('git', [...gitArgs, 'clone', '--', repo.url, dir], log, { env })
  }
  // Proactive runs reuse a read-only context clone. Refresh it on the host,
  // before mounting it, and fail closed rather than scanning stale code.
  if (refresh) {
    if (await operationInProgress(dir, gitArgs, env))
      throw new Error('Cannot refresh proactive repository: a git operation is in progress')
    const status = await run('git', ['-C', dir, ...gitArgs, 'status', '--porcelain'], log, { env })
    if (status.trim()) throw new Error('Cannot refresh proactive repository: uncommitted changes')
    log('refreshing proactive repository from origin HEAD ...')
    await run('git', ['-C', dir, ...gitArgs, 'fetch', 'origin', 'HEAD'], log, { env })
    // Refuse local-only commits too: --ff-only alone accepts an ahead branch.
    await run('git', ['-C', dir, ...gitArgs, 'merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD'], log, { env })
    await run('git', ['-C', dir, ...gitArgs, 'merge', '--ff-only', 'FETCH_HEAD'], log, { env })
    return dir
  }
  const branch = scopeBranch(ref.task)
  // A scope named after the default branch would work on it directly, and push
  // to it. `main`/`master` are refused as scope names already; this catches a
  // repo whose default is something else (`develop`, `trunk`). Ahead of the
  // early return below: a fresh clone already sits on that branch, and so does
  // a scope created before this check — renaming it moves its work off.
  if ((await originHead(dir, gitArgs, env)) === branch)
    throw new Error(
      `Scope "${ref.task}" has the name of ${repo.name}'s default branch — rename the scope to work on its own branch`
    )
  // Nothing to check out when we are already on the task branch — and skipping
  // that no-op is what keeps a conflicted clone startable: with unmerged index
  // entries git refuses even a same-branch checkout ("you need to resolve your
  // current index first"). Without this, an `update from main` that conflicted
  // would leave the task unable to start any agent, including one asked to
  // resolve the conflict. Same for a half-finished merge/rebase (which also
  // detaches HEAD): the tree is left exactly as it is, for the agent to finish.
  if ((await currentBranch(dir, gitArgs, env)) === branch) return dir
  if (await operationInProgress(dir, gitArgs, env)) {
    log(`git operation in progress in ${dir} — leaving the tree as is`)
    return dir
  }
  // Create vs switch, never one masking the other: a `checkout` that fails on
  // its own (dirty tree, missing ref) must surface that error, not retry as
  // `checkout -b` and report the misleading "branch already exists".
  if (await refExists(dir, gitArgs, env, `refs/heads/${branch}`))
    await run('git', ['-C', dir, ...gitArgs, 'checkout', branch], log, { env })
  // A remote branch of the task's name *is* the task's branch, so continue it
  // instead of forking a second one off the default branch: changes.ts already
  // reads `origin/<task>` as this task's remote branch — it fetches and prunes
  // it, publishes with `push -u`, and splits pushed from local commits against
  // it — so provisioning has to agree, or a task whose branch already exists on
  // the remote would start from the wrong commit and report every commit
  // already on that branch as missing. `--track origin/<branch>` is spelled out
  // rather than left to a bare `checkout <branch>`, so the DWIM path stays
  // unused here too. No fetch is needed: the clone above brought every remote
  // ref along, and a pre-existing clone returned further up.
  else if (await refExists(dir, gitArgs, env, `refs/remotes/origin/${branch}`))
    await run(
      'git',
      ['-C', dir, ...gitArgs, 'checkout', '-b', branch, '--track', `origin/${branch}`],
      log,
      { env }
    )
  else await run('git', ['-C', dir, ...gitArgs, 'checkout', '-b', branch], log, { env })
  return dir
}

/** True if the clone at `dir` has uncommitted changes (staged, unstaged, or untracked). */
export function isDirty(dir: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', dir, 'status', '--porcelain'])
    killAfter(child, PROBE_TIMEOUT_MS)
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', () => resolve(false))
    child.on('close', () => resolve(out.trim().length > 0))
  })
}

/** Upper bound on the discovery clone before it's killed. */
const DISCOVER_TIMEOUT_MS = 60_000

/** Looks up the registered repo the same way `ensureClone` does, so discovery
 *  resolves credentials (including a repo-linked `credentialId`) identically
 *  to the real clone instead of falling back to host-auto-match only. */
async function requireRepo(ws: string, repoName: string): Promise<RepoConfig> {
  const repo = (await getWorkspace(ws)).repos.find((r) => r.name === repoName)
  if (!repo) throw new Error(`repo "${repoName}" is not registered in "${ws}"`)
  return repo
}

/** Shallow-clones `repo` to a scratch dir, runs `fn` against it, and always
 *  cleans up — the shared body behind every repo-discovery helper below. */
async function withShallowClone<T>(repo: RepoConfig, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gurt-discover-'))
  try {
    // Same credential resolution as `ensureClone` — the real RepoConfig (with
    // its `credentialId` link, if any), not a synthetic `{ name: '', url }`.
    // GIT_TERMINAL_PROMPT=0 → private/unreachable URLs fail fast instead of
    // blocking on a credential prompt with no terminal. `--` guards against a
    // URL beginning with `-` being parsed as a git option. The timeout is a
    // backstop for a clone that stalls on a slow/hanging network.
    const { env, gitArgs } = await hostGitAccess(repo, await listCredentials())
    await run(
      'git',
      [...gitArgs, 'clone', '--depth', '1', '--no-tags', '--', repo.url, dir],
      () => {},
      { env, timeoutMs: DISCOVER_TIMEOUT_MS }
    )
    return await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const isDockerfileName = (name: string) => name === 'Dockerfile' || name.startsWith('Dockerfile.')

/** Root `Dockerfile*` — candidates to build an env from. */
async function dockerfileCandidates(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
    if (entry.isFile() && isDockerfileName(entry.name)) out.push(entry.name)
  return out
}

export interface DiscoveredDockerfile {
  path: string
  content: string
}

/** Shallow-clones the repo and returns every root Dockerfile candidate with its
 *  content — the env editor loads one into its (editable) Dockerfile field. */
export async function discoverDockerfiles(
  ws: string,
  repoName: string
): Promise<DiscoveredDockerfile[]> {
  const repo = await requireRepo(ws, repoName)
  return withShallowClone(repo, async (dir) => {
    const out: DiscoveredDockerfile[] = []
    for (const rel of await dockerfileCandidates(dir)) {
      const content = await fs.readFile(path.join(dir, rel), 'utf8').catch(() => null)
      if (content != null) out.push({ path: rel, content })
    }
    return out
  })
}

/** True if an image with this tag exists in the local Docker image store. */
export function dockerImageExists(tag: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['image', 'inspect', '-f', '{{.Id}}', tag])
    killAfter(child, PROBE_TIMEOUT_MS)
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

/** Labels stamped on every env image: they mark it as ours and say which
 *  (repo, env) it was built for, so superseded builds can be found again. */
const envImageLabels = (repo: RepoConfig, envCfg: EnvConfig): string[] => [
  'gurt.managed=1',
  'gurt.kind=env-image',
  `gurt.repo=${repo.url}`,
  `gurt.env=${envCfg.name}`
]

/**
 * Remove the older images of this (repo, env) — each new commit or Dockerfile
 * edit mints a new content tag, and nothing else ever deletes the previous one.
 * Keeps only `keepTag`. No `-f`: an image a container still uses is refused by
 * Docker and simply stays until that container is gone. Best-effort.
 */
async function removeStaleEnvImages(
  repo: RepoConfig,
  envCfg: EnvConfig,
  keepTag: string,
  log: LogSink
): Promise<void> {
  try {
    const out = await run(
      'docker',
      [
        'image', 'ls',
        '--filter', 'label=gurt.kind=env-image',
        '--filter', `label=gurt.repo=${repo.url}`,
        '--filter', `label=gurt.env=${envCfg.name}`,
        '--format', '{{.Repository}}:{{.Tag}}'
      ],
      () => {},
      { timeoutMs: PROBE_TIMEOUT_MS }
    )
    for (const old of out.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (old === keepTag || old.endsWith(':<none>')) continue
      await run('docker', ['rmi', old], () => {}, { timeoutMs: PROBE_TIMEOUT_MS })
        .then(() => log(`removed superseded image ${old}`))
        .catch(() => {})
    }
  } catch {
    /* cleanup only — never fail a build over it */
  }
}

/** Builds in flight, keyed by tag — dedupes concurrent callers building the
 *  same content (e.g. two tasks starting on the same env at once). */
const buildsInFlight = new Map<string, Promise<string>>()

/** True while an env image is being built — between the build and the create that
 *  uses it the image has no container, so a sweep must not take it. */
export const envBuildInFlight = (): boolean => buildsInFlight.size > 0

/**
 * Ensure the image for (repo, commit, envCfg) exists and return its tag.
 * `contextDir` is a disposable snapshot of the repo at `commit`; the env's
 * Dockerfile is written to a scratch dir *outside* it and passed with `-f`
 * (nothing lands in the snapshot), and the build context is `build.context`
 * resolved against the snapshot root. Tagged by content (`envImageTag`), so
 * the image is built once and reused by every later session on this env until
 * the Dockerfile, the build args, or the repo's committed content change.
 * Shared by session start and Settings pre-build.
 */
export async function buildEnvImage(
  repo: RepoConfig,
  envCfg: EnvConfig,
  contextDir: string,
  commit: string,
  log: LogSink
): Promise<string> {
  const invalid = validateEnvConfig(envCfg)
  if (invalid) throw new Error(`env "${envCfg.name}": ${invalid}`)
  if (!envCfg.dockerfile) throw new Error(`env "${envCfg.name}" has no Dockerfile — nothing to build`)
  const build = envCfg.build ?? {}
  const tag = envImageTag(repo.url, commit, envCfg.dockerfile, build)
  const inflight = buildsInFlight.get(tag)
  if (inflight) return inflight
  const p = (async () => {
    if (await dockerImageExists(tag)) {
      log(`image ${tag} already present`)
      return tag
    }
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'gurt-env-build-'))
    try {
      const dockerfilePath = path.join(scratch, 'Dockerfile')
      await fs.writeFile(dockerfilePath, envCfg.dockerfile!)
      // Validated above: relative, and inside the snapshot.
      const context = path.join(contextDir, insideRoot(build.context ?? '.') ?? '.')
      const args = ['build', '-f', dockerfilePath, '-t', tag]
      for (const l of envImageLabels(repo, envCfg)) args.push('--label', l)
      for (const [k, v] of Object.entries(build.args ?? {})) args.push('--build-arg', `${k}=${v}`)
      if (build.target) args.push('--target', build.target)
      args.push(context)
      log(`building ${tag} ...`)
      await run('docker', args, log, { level: 'info' })
    } finally {
      await fs.rm(scratch, { recursive: true, force: true })
    }
    await removeStaleEnvImages(repo, envCfg, tag, log)
    return tag
  })()
  buildsInFlight.set(tag, p)
  p.finally(() => buildsInFlight.delete(tag)).catch(() => {})
  return p
}

/**
 * The image a session's container is created from (§3.1). An `image` env is
 * pulled when it is not in the local store. A `dockerfile` env is built in a
 * temporary snapshot of the clone at HEAD (`git archive`; the working clone is
 * never touched) and tagged by content.
 *
 * `repo`/`cloneDir` are null for a repo-less operator session
 * (docs/requirements-session-operator.md §2.1): the build needs a clone to
 * `git archive` and a commit to tag the image with, so a Dockerfile env is
 * structurally unreachable there — refused with its own sentence, not at the
 * anchor guard with "session has no repository".
 */
export async function prepareEnvImage(
  envCfg: EnvConfig,
  repo: RepoConfig | null,
  cloneDir: string | null,
  log: LogSink
): Promise<string> {
  const invalid = validateEnvConfig(envCfg)
  if (invalid) throw new Error(`env "${envCfg.name}": ${invalid}`)
  if (envCfg.image) {
    await pullIfMissing(envCfg.image, log)
    return envCfg.image
  }
  if (!repo || !cloneDir)
    throw new Error(
      `env "${envCfg.name}" has a build section, which needs a repository to build from — ` +
        'a repo-less operator session needs an image-only env'
    )
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'gurt-env-snapshot-'))
  try {
    const tarFile = path.join(scratch, 'src.tar')
    const srcDir = path.join(scratch, 'src')
    await fs.mkdir(srcDir)
    await run('git', ['-C', cloneDir, 'archive', '--format=tar', '-o', tarFile, 'HEAD'], log)
    await run('tar', ['-xf', tarFile, '-C', srcDir], log)
    const commit = (await run('git', ['-C', cloneDir, 'rev-parse', 'HEAD'], () => {})).trim()
    return await buildEnvImage(repo, envCfg, srcDir, commit, log)
  } finally {
    await fs.rm(scratch, { recursive: true, force: true })
  }
}

/** `docker pull` when the image is not in the local store; the output goes to
 *  the provisioning log (phase `image`). */
export async function pullIfMissing(image: string, log: LogSink): Promise<void> {
  if (await dockerImageExists(image)) return
  log(`pulling ${image} ...`)
  await run('docker', ['pull', image], log, { level: 'info' })
}

/** Remote HEAD commit of `repo`, resolved with the same credentials as clones. */
async function remoteHead(repo: RepoConfig): Promise<string> {
  const { env, gitArgs } = await hostGitAccess(repo, await listCredentials())
  const out = await run('git', [...gitArgs, 'ls-remote', '--', repo.url, 'HEAD'], () => {}, {
    env,
    timeoutMs: DISCOVER_TIMEOUT_MS
  })
  const commit = out.split(/\s+/)[0]?.trim()
  if (!commit) throw new Error(`cannot resolve remote HEAD of ${repo.url}`)
  return commit
}

/** Image status of a SAVED env config (workspace-level, no task context): the
 *  tag it would build at the default repo's remote HEAD, and whether that image
 *  already exists locally. */
export async function envImageStatus(ws: string, envName: string): Promise<EnvImageStatus> {
  const wsData = await getWorkspace(ws)
  const envCfg = wsData.envs.find((e) => e.name === envName)
  if (!envCfg) throw new Error(`env "${envName}" not found in "${ws}"`)
  if (validateEnvConfig(envCfg)) return { state: 'invalid' }
  if (!envCfg.dockerfile) return { state: 'not-applicable' }
  const repo = envCfg.repo ? wsData.repos.find((r) => r.name === envCfg.repo) : undefined
  if (!repo) return { state: 'no-repo' }
  const commit = await remoteHead(repo)
  const tag = envImageTag(repo.url, commit, envCfg.dockerfile, envCfg.build ?? {})
  return { state: (await dockerImageExists(tag)) ? 'exists' : 'missing', tag, commit }
}

/** Pre-build the SAVED env config's image from its default repo's HEAD — the
 *  shallow clone IS the temporary repo snapshot. Session start reuses the
 *  result automatically via the content tag. */
export async function envBuildImage(
  ws: string,
  envName: string,
  log: LogSink
): Promise<{ tag: string }> {
  const wsData = await getWorkspace(ws)
  const envCfg = wsData.envs.find((e) => e.name === envName)
  if (!envCfg) throw new Error(`env "${envName}" not found in "${ws}"`)
  const invalid = validateEnvConfig(envCfg)
  if (invalid) throw new Error(`env "${envName}": ${invalid}`)
  if (!envCfg.dockerfile) throw new Error(`env "${envName}" has no Dockerfile — nothing to build`)
  const repo = envCfg.repo ? wsData.repos.find((r) => r.name === envCfg.repo) : undefined
  if (!repo) throw new Error(`env "${envName}" has no default repository to build from`)
  const tag = await withShallowClone(repo, async (dir) => {
    const commit = (await run('git', ['-C', dir, 'rev-parse', 'HEAD'], () => {})).trim()
    return buildEnvImage(repo, envCfg, dir, commit, log)
  })
  return { tag }
}

// --- the docker runtime (docs/requirements-env-docker.md §3) ----------------
//
// Every container step is the docker CLI, and every exec targets the container
// *id* in the session record — never a label lookup.

/** Everything an exec needs to land in the right place: the container, the user
 *  it runs as, its working directory, and the PATH the agent should see. `path`
 *  is absent only before the env probe has run (setup/start/probe themselves). */
export interface ExecTarget {
  containerId: string
  user: string
  cwd: string
  path?: string
}

/** Where gurt's own Node runtime is mounted (read-only volume). */
export const NODE_MOUNT = '/opt/gurt/node'

/**
 * gurt's Node runtime (§3.2): adapters are npm packages and need Node whatever
 * the env image carries. Pinned by digest, not tag (supply chain) — bump
 * deliberately with gurt releases (`docker manifest inspect
 * node:26-trixie`). Every plugin's minimum must hold (pi needs ≥ 22.19).
 * glibc on purpose: the volume's node runs inside the *env's* image, so a
 * musl/alpine env is unsupported (§12).
 */
export const NODE_RUNTIME_IMAGE = DEFAULT_BASE_IMAGE

/** `docker exec` argv up to (not including) the command: the one helper every
 *  in-container step goes through. Secrets are never in it — `envNames` are
 *  passed as `-e NAME`, the values ride in the docker client's own environment
 *  (see {@link spawnDockerExec}). */
export function dockerExecArgs(
  t: ExecTarget,
  envNames: readonly string[] = [],
  flags: { interactive?: boolean; tty?: boolean } = { interactive: true }
): string[] {
  return [
    'exec',
    ...(flags.interactive ? ['-i'] : []),
    ...(flags.tty ? ['-t'] : []),
    '-u', t.user,
    '-w', t.cwd,
    ...(t.path ? ['-e', `PATH=${t.path}`] : []),
    ...envNames.flatMap((n) => ['-e', n]),
    t.containerId
  ]
}

/** Spawn `docker exec` and hand back the child — the caller owns it and its
 *  pipes (ACP adapter, PII-masked fs/terminal). `env` values reach the process
 *  through the client's environment only. */
export function spawnDockerExec(
  t: ExecTarget,
  argv: string[],
  env: Record<string, string> = {},
  flags?: { interactive?: boolean; tty?: boolean }
) {
  return spawn('docker', [...dockerExecArgs(t, Object.keys(env), flags), ...argv], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

interface ExecResult {
  code: number
  stdout: string
  /** The last lines of combined output, for a failure to quote. */
  tail: string[]
}

/** Run one command in a container to completion. Never rejects on a non-zero
 *  exit — the caller decides what a code means — only when `docker` itself
 *  cannot be spawned. `stdin` is written and closed (file content goes this
 *  way, never through argv). */
export function dockerExec(
  t: ExecTarget,
  argv: string[],
  sink: LogSink,
  opts: {
    env?: Record<string, string>
    stdin?: string
    timeoutMs?: number
    quiet?: boolean
    level?: 'info' | 'debug'
  } = {}
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const env = opts.env ?? {}
    const args = [...dockerExecArgs(t, Object.keys(env), { interactive: opts.stdin !== undefined }), ...argv]
    const child = spawn('docker', args, { env: { ...process.env, ...env } })
    // `quiet` (file writes, probes): trace an argument count, not the values.
    const exited = traceProc(opts.level ?? 'debug', 'docker', args, child.pid, !!opts.quiet)
    const tail: string[] = []
    const emit = (line: string): void => {
      tail.push(line)
      if (tail.length > HOOK_WINDOW_LINES) tail.shift()
      if (!opts.quiet) sink(line)
    }
    const out = lineBuffer(emit)
    const err = lineBuffer(emit)
    let stdout = ''
    let timedOut = false
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, opts.timeoutMs)
      : undefined
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
      out.push(d)
    })
    child.stderr.on('data', (d: Buffer) => err.push(d))
    child.stdin.on('error', () => {})
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin)
    else child.stdin.end()
    child.on('error', (e) => {
      if (timer) clearTimeout(timer)
      exited(null, Date.now() - started, false)
      reject(e)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      out.flush()
      err.flush()
      const ok = code === 0 && !timedOut
      exited(code, Date.now() - started, ok)
      resolve({ code: timedOut ? -1 : (code ?? -1), stdout, tail })
    })
  })
}

/** The user's login shell, resolved inside the container from /etc/passwd
 *  (nologin/false and anything not executable fall back to /bin/sh). */
const PICK_SHELL =
  'sh_=$(getent passwd "$(id -un 2>/dev/null)" 2>/dev/null | cut -d: -f7); ' +
  'case "$sh_" in ""|*/nologin|*/false) sh_=/bin/sh;; esac; [ -x "$sh_" ] || sh_=/bin/sh; '

/** argv that runs `script` in the user's login shell: `$SHELL -lc <script>`. */
export const loginShell = (script: string, flags = '-lc'): string[] => [
  'sh', '-c', `${PICK_SHELL}exec "$sh_" ${flags} "$0"`, script
]

/** What a human terminal in the container runs: the user's login shell. */
export const interactiveShellArgv = (): string[] => ['sh', '-c', `${PICK_SHELL}exec "$sh_" -l`]

/** A terminal uses the same user/cwd/PATH as the agent, but targets the exact
 *  live container so a delayed window cannot attach to a replacement. */
export function containerTerminalCommand(t: ExecTarget): { cmd: string; args: string[] } {
  return {
    cmd: '/usr/bin/env',
    args: [
      `PATH=${hostPath()}`,
      'docker',
      ...dockerExecArgs(t, [], { interactive: true, tty: true }),
      ...interactiveShellArgv()
    ]
  }
}

/** Docker Desktop (macOS) reports a host path it has stale-cached as missing,
 *  prefixed with the VM's /host_mnt root. */
const STALE_BIND_RE = /bind source path does not exist: (?:\/host_mnt)?(\/\S+)/

/** How many output lines a failure quotes, and how many it keeps to pick them
 *  from (stack frames are dropped, so the window has to be the wider). */
const HOOK_TAIL_LINES = 6
const HOOK_WINDOW_LINES = 40

/** The lines worth quoting when a setup/start script fails: its own output,
 *  without node stack frames. */
export function hookOutputTail(lines: string[], max = HOOK_TAIL_LINES): string[] {
  return lines.filter((l) => l.trim() && !/^\s*at /.test(l)).slice(-max)
}

/**
 * Docker Desktop's VM caches path lookups per bind source and can keep a stale
 * "missing" entry for a path that exists on the host, failing every `docker run`
 * that binds it for tens of minutes. A host-side rename does not clear it;
 * re-reading the paths from INSIDE the VM does. One container, all paths, ~1s.
 */
async function warmBindPaths(paths: string[], log: LogSink): Promise<void> {
  const inside = paths
    .filter((p) => p.startsWith(gurtRoot) && existsSync(p))
    .map((p) => '/probe' + p.slice(gurtRoot.length))
  if (!inside.length) return
  // `ls -d` on each: cheap, forces the VM to traverse the full chain.
  await run(
    'docker',
    [
      'run', '--rm',
      '--mount', `type=bind,source=${gurtRoot},target=/probe,readonly`,
      'alpine', 'sh', '-c', `ls -d ${inside.map((p) => `'${p}'`).join(' ')}`
    ],
    log
  ).catch(() => {}) // best-effort: never turn a warm-up failure into a start failure
  log(`warmed Docker's path cache for ${inside.length} bind source(s)`)
}

export interface ContainerMount {
  type: 'bind' | 'volume'
  source: string
  target: string
  readonly?: boolean
}

/** One `--mount` value. A field holding a comma or a quote is CSV-quoted, which
 *  is how `docker --mount` reads a path like `/Users/a,b/repo`. */
export function mountArg(m: ContainerMount): string {
  const field = (k: string, v: string): string =>
    /[,"]/.test(v) ? `"${k}=${v.replaceAll('"', '""')}"` : `${k}=${v}`
  return [
    `type=${m.type}`,
    field('source', m.source),
    field('target', m.target),
    ...(m.readonly ? ['readonly'] : [])
  ].join(',')
}

/** `docker image inspect` facts the runtime needs: the image's own user and its
 *  architecture (which picks the node volume). null = not in the store. */
async function inspectImage(image: string): Promise<{ user: string; arch: string } | null> {
  try {
    const out = await run(
      'docker',
      ['image', 'inspect', '-f', '{{.Config.User}}|{{.Architecture}}', image],
      () => {},
      { timeoutMs: PROBE_TIMEOUT_MS }
    )
    const [user = '', arch = ''] = out.trim().split('|')
    return { user, arch }
  } catch {
    return null
  }
}

/** True if a container with this id exists (running or not). */
export async function dockerContainerExists(containerId: string): Promise<boolean> {
  return run('docker', ['inspect', '-f', '{{.Id}}', containerId], () => {}, {
    timeoutMs: PROBE_TIMEOUT_MS
  }).then(
    () => true,
    () => false
  )
}

// --- node runtime volume (§3.2) ---

const nodeVolumeName = (arch: string): string =>
  `gurt-node-${/sha256:([0-9a-f]{12})/.exec(NODE_RUNTIME_IMAGE)?.[1] ?? 'unpinned'}-${arch}`

/** Volumes verified ready in this app process — the `.gurt-ready` check is one
 *  container run, paid once per process, not per start. */
const readyNodeVolumes = new Set<string>()
const nodeVolumesInFlight = new Map<string, Promise<string>>()

/**
 * The docker volume holding gurt's Node, filled once from
 * {@link NODE_RUNTIME_IMAGE}. A volume without `.gurt-ready` (a fill that died
 * half-way) is emptied and refilled. Concurrent callers share one fill.
 */
export function ensureNodeRuntimeVolume(arch: string, log: LogSink): Promise<string> {
  const name = nodeVolumeName(arch)
  if (readyNodeVolumes.has(name)) return Promise.resolve(name)
  const inflight = nodeVolumesInFlight.get(name)
  if (inflight) return inflight
  const p = (async () => {
    const platform = `linux/${arch}`
    const probe = (): Promise<boolean> =>
      run(
        'docker',
        [
          'run', '--rm', '--platform', platform, '--entrypoint', 'test',
          '--mount', mountArg({ type: 'volume', source: name, target: '/out', readonly: true }),
          NODE_RUNTIME_IMAGE, '-f', '/out/.gurt-ready'
        ],
        () => {},
        { timeoutMs: PROBE_TIMEOUT_MS }
      ).then(
        () => true,
        () => false
      )
    const exists = await run('docker', ['volume', 'inspect', name], () => {}, {
      timeoutMs: PROBE_TIMEOUT_MS
    }).then(
      () => true,
      () => false
    )
    if (exists && (await probe())) return name
    if (!exists)
      await run(
        'docker',
        ['volume', 'create', '--label', 'gurt.managed=1', '--label', 'gurt.kind=node-runtime', name],
        log
      )
    log(`filling gurt's node runtime volume ${name} from ${NODE_RUNTIME_IMAGE.split('@')[0]} ...`)
    await pullIfMissing(NODE_RUNTIME_IMAGE, log)
    await run(
      'docker',
      [
        'run', '--rm', '--platform', platform, '--entrypoint', 'sh',
        '--mount', mountArg({ type: 'volume', source: name, target: '/out' }),
        NODE_RUNTIME_IMAGE, '-c',
        'find /out -mindepth 1 -delete && cp -a /usr/local/. /out/ && touch /out/.gurt-ready'
      ],
      log,
      { level: 'info' }
    )
    return name
  })().then((n) => {
    readyNodeVolumes.add(n)
    return n
  })
  nodeVolumesInFlight.set(name, p)
  p.finally(() => nodeVolumesInFlight.delete(name)).catch(() => {})
  return p
}

// --- create / start ---

const STALE_ATTEMPTS = 3
/** Waits before attempt 2 and 3. The stale window is time-sensitive and
 *  self-heals on its own eventually — back-to-back retries seconds apart all
 *  failed, so give the VM a moment after each warm-up. */
const STALE_BACKOFF_MS = [2_000, 5_000]

/** Run `fn` (a `docker create`/`start`), retrying the Docker Desktop stale-bind
 *  fault: warm every bind source and back off. Anything else is not retried. */
async function withStaleBindRetry<T>(
  bindSources: string[],
  log: LogSink,
  fn: (watch: LogSink) => Promise<T>,
  cleanup?: () => Promise<void>
): Promise<T> {
  /** Every path reported missing: one attempt can report several (the whole
   *  subtree goes stale together) and only the last attempt's wording reaches
   *  the user, so accumulate across attempts. */
  const stalePaths = new Set<string>()
  for (let attempt = 1; ; attempt++) {
    let sawStale = false
    const watch: LogSink = (line) => {
      const stalePath = STALE_BIND_RE.exec(line)?.[1]
      if (stalePath) {
        sawStale = true
        stalePaths.add(stalePath)
      }
      log(line)
    }
    try {
      return await fn(watch)
    } catch (e) {
      if (!sawStale) throw e
      await cleanup?.()
      if (attempt >= STALE_ATTEMPTS)
        // The raw `docker create ...` line says nothing about why it failed;
        // lead with the cause and the way out instead.
        throw new Error(
          `container start failed: Docker could not see ${[...stalePaths].join(', ')} even ` +
            `though it exists on the host (Docker Desktop's stale path cache). Retried ` +
            `${STALE_ATTEMPTS}× with a cache warm-up. If this keeps happening, restart ` +
            `Docker Desktop, or switch Settings → Resources → File sharing to gRPC FUSE.`,
          { cause: e }
        )
      // Warm every bind source, not just the reported one: the staleness covers
      // a whole subtree, so the next path would fail next.
      await warmBindPaths([...bindSources, ...stalePaths], log)
      // GURT_STALE_BACKOFF_SCALE: test seam, scales the waits (0 = none).
      const scale = Number(process.env['GURT_STALE_BACKOFF_SCALE'] ?? 1)
      await new Promise((r) => setTimeout(r, (STALE_BACKOFF_MS[attempt - 1] ?? 5_000) * scale))
    }
  }
}

/** `docker start` an existing container, with the stale-bind retry. */
export async function dockerStart(
  containerId: string,
  bindSources: string[],
  log: LogSink
): Promise<void> {
  await withStaleBindRetry(bindSources, log, (watch) =>
    run('docker', ['start', containerId], watch, { timeoutMs: PROBE_TIMEOUT_MS * 2, level: 'info' }).then(() => {})
  )
}

export interface ContainerSpec {
  session: string
  /** The image to create from — already pulled/built. */
  image: string
  env: EnvConfig
  /** Container-side working directory of every exec. */
  workdir: string
  /** Every mount except the node runtime volume, which is added here. */
  mounts: ContainerMount[]
  /** The role mounts read-only: its `setup` script is skipped (§3.4 step 2). */
  skipSetup: boolean
}

export interface CreatedContainer {
  containerId: string
  user: string
  /** The PATH every exec carries (probed, plus gurt's node and npm bins). */
  path: string
}

/** How many times a failed `setup` gets a fresh container: the usual cause is a
 *  transient registry or network error, which a second run clears, and one that
 *  isn't transient would only make every start pay twice for it. */
const MAX_SETUP_RETRIES = 1

/** Align the container user's uid/gid with the host's (Linux, non-root user,
 *  mismatch only) so files the agent writes into the bind-mounted clone are the
 *  host user's. Not on
 *  macOS/Windows, where Docker's file sharing maps ownership itself. Any
 *  obstacle is a logged warning, never a failed start. */
async function alignUserUid(t: ExecTarget, log: LogSink): Promise<void> {
  const hostUid = process.getuid?.()
  const hostGid = process.getgid?.()
  if (process.platform !== 'linux' || hostUid === undefined || hostGid === undefined) return
  if (hostUid === 0 || t.user === 'root' || t.user === '0') return
  const user = t.user.split(':')[0] ?? t.user
  const script =
    'user="$1"; huid="$2"; hgid="$3"\n' +
    'name=$(id -un "$user" 2>/dev/null) || { echo "user $user has no passwd entry"; exit 3; }\n' +
    'cur=$(id -u "$name")\n' +
    '[ "$cur" = "$huid" ] && exit 0\n' +
    'command -v usermod >/dev/null 2>&1 || { echo "usermod is not installed"; exit 4; }\n' +
    'if getent passwd "$huid" >/dev/null 2>&1; then echo "uid $huid is already taken"; exit 5; fi\n' +
    'grp=$(id -gn "$name")\n' +
    'if [ "$(id -g "$name")" != "$hgid" ] && ! getent group "$hgid" >/dev/null 2>&1; then groupmod -g "$hgid" "$grp" || exit 6; fi\n' +
    'usermod -u "$huid" "$name" || exit 7\n' +
    'home=$(getent passwd "$name" | cut -d: -f6)\n' +
    '[ -n "$home" ] && [ -d "$home" ] && chown -R "$huid:$(id -g "$name")" "$home"\n' +
    'exit 0'
  const { code, tail } = await dockerExec(
    { ...t, user: 'root' },
    ['sh', '-c', script, 'align', user, String(hostUid), String(hostGid)],
    () => {}
  )
  if (code !== 0)
    log(
      `could not align ${t.user}'s uid with the host's ${hostUid} (exit ${code}` +
        `${tail.length ? `: ${tail[tail.length - 1]}` : ''}) — files created in the clone may be owned by another uid`
    )
  else log(`aligned ${t.user}'s uid/gid with the host's (${hostUid}:${hostGid})`)
}

/** Run a setup/start script as `user`, in the workdir, in the user's login shell. */
function runScript(t: ExecTarget, script: string, log: LogSink): Promise<ExecResult> {
  return dockerExec(t, loginShell(script), log, { level: 'info' })
}

const PROBE_MARK = '__GURT_ENV__'

/**
 * The PATH a session's execs carry (§3.4 step 4). The login shell's PATH is
 * what the user's toolchain (nvm, pyenv, …) puts there, which a plain exec
 * never sees — so ask a login shell (`-lic`, 10 s; then `-lc`; then the image's
 * own PATH), and *append* gurt's node and npm bins: the project's toolchain
 * wins for the agent's own commands, gurt's node only fills the gap.
 */
export async function probeExecPath(t: ExecTarget, log: LogSink): Promise<string> {
  const printer = `printf '%s' "${PROBE_MARK}$HOME${PROBE_MARK}$PATH${PROBE_MARK}"`
  const bare: ExecTarget = { ...t }
  delete bare.path
  let home = ''
  let probed = ''
  const attempts: string[][] = [
    loginShell(printer, '-lic'),
    loginShell(printer, '-lc'),
    ['sh', '-c', printer]
  ]
  for (const argv of attempts) {
    const r = await dockerExec(bare, argv, () => {}, { timeoutMs: 10_000, quiet: true }).catch(
      () => null
    )
    const m = r && r.code === 0 ? r.stdout.match(/__GURT_ENV__(.*?)__GURT_ENV__(.*?)__GURT_ENV__/s) : null
    if (m && m[2]) {
      home = m[1] ?? ''
      probed = m[2]
      break
    }
  }
  if (!probed) {
    log('could not read the container PATH — using the system default')
    probed = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
  }
  // A login shell always has a HOME; the guess only covers a probe that read nothing.
  const homeDir = home || (t.user === 'root' || t.user === '0' ? '/root' : `/home/${t.user.split(':')[0]}`)
  return `${probed}:${NODE_MOUNT}/bin:${homeDir}/.gurt/npm/bin`
}

/**
 * Create and start a session's container (§3.3, §3.4): `docker create` on the
 * default bridge → start → uid alignment → `setup` (on the open network, before
 * the network switch) → `start` → env probe.
 *
 * The container id reaches the caller (`onSetupDone`) only after `setup`
 * succeeded, so a crash mid-setup can never leave a record naming a
 * half-provisioned container. A `setup` that fails removes its container and
 * runs once more in a fresh one — the container exists by then, and reusing it
 * would silently skip the script ("it works the second time" of a flaky
 * install is not that it works). A `start` failure fails the start and keeps
 * the container.
 */
export async function createContainer(
  spec: ContainerSpec,
  log: LogSink,
  hooks: { onCreated?: () => void; onSetupDone?: (containerId: string, user: string) => void } = {}
): Promise<CreatedContainer> {
  const info = await inspectImage(spec.image)
  if (!info) throw new Error(`image ${spec.image} is not available locally`)
  const user = info.user || 'root'
  const volume = await ensureNodeRuntimeVolume(info.arch, log)
  const mounts: ContainerMount[] = [
    ...spec.mounts,
    { type: 'volume', source: volume, target: NODE_MOUNT, readonly: true }
  ]
  const bindSources = mounts.filter((m) => m.type === 'bind').map((m) => m.source)
  const createArgs = [
    'create',
    '--label', `gurt.session=${spec.session}`,
    '--label', 'gurt.managed=1',
    '--label', 'gurt.runtime=docker',
    '--init',
    '-w', spec.workdir,
    ...Object.entries(spec.env.env ?? {}).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    ...mounts.flatMap((m) => ['--mount', mountArg(m)]),
    '--entrypoint', '/bin/sh',
    spec.image,
    '-c', 'trap "exit 0" TERM; sleep infinity & wait'
  ]
  let setupRetries = 0
  for (;;) {
    let containerId = ''
    await withStaleBindRetry(
      bindSources,
      log,
      async (watch) => {
        containerId = (
          await run('docker', createArgs, watch, { timeoutMs: PROBE_TIMEOUT_MS * 2, level: 'info' })
        ).trim()
        await run('docker', ['start', containerId], watch, {
          timeoutMs: PROBE_TIMEOUT_MS * 2,
          level: 'info'
        })
      },
      async () => {
        if (containerId) await dockerRemove(containerId, log)
        containerId = ''
      }
    ).catch(async (e: unknown) => {
      if (containerId) await dockerRemove(containerId, log)
      throw e
    })
    hooks.onCreated?.()
    const target: ExecTarget = { containerId, user, cwd: spec.workdir }
    await alignUserUid(target, log)
    if (spec.env.setup?.trim()) {
      if (spec.skipSetup)
        log('read-only mount session: skipping the setup script (this role does not install dependencies)')
      else {
        log('running the setup script ...')
        const r = await runScript(target, spec.env.setup, log)
        if (r.code !== 0) {
          await dockerRemove(containerId, log)
          if (setupRetries < MAX_SETUP_RETRIES) {
            setupRetries++
            log(`setup script failed (exit ${r.code}). Removed the half-provisioned container; retrying once.`)
            continue
          }
          const tail = hookOutputTail(r.tail)
          throw new Error(
            `setup script failed (exit ${r.code}) — retried ${MAX_SETUP_RETRIES + 1}× in a fresh container.` +
              (tail.length ? `\n${tail.join('\n')}` : '')
          )
        }
      }
    }
    hooks.onSetupDone?.(containerId, user)
    if (spec.env.start?.trim()) {
      log('running the start script ...')
      const r = await runScript(target, spec.env.start, log)
      if (r.code !== 0) throw startScriptError(r)
    }
    const path = await probeExecPath(target, log)
    return { containerId, user, path }
  }
}

function startScriptError(r: ExecResult): Error {
  const tail = hookOutputTail(r.tail)
  return new Error(`start script failed (exit ${r.code})` + (tail.length ? `\n${tail.join('\n')}` : ''))
}

/**
 * Bring a stopped container of this session back (§3.4, restart): `docker
 * start` → the `start` script → the cached env probe (a missing one is probed
 * again — a container created by an older build has none recorded).
 */
export async function restartContainer(
  t: ExecTarget,
  env: EnvConfig,
  bindSources: string[],
  log: LogSink
): Promise<string> {
  await dockerStart(t.containerId, bindSources, log)
  if (env.start?.trim()) {
    log('running the start script ...')
    const r = await runScript(t, env.start, log)
    if (r.code !== 0) throw startScriptError(r)
  }
  return t.path ?? (await probeExecPath(t, log))
}

/**
 * Where a session's materialized skills are bound inside its container.
 *
 * A fixed absolute path rather than the `$HOME/<skillsDir>` the agent
 * actually reads, because the remote user — hence the home directory — is the
 * image's choice, not gurt's, and a mount target cannot name it.
 * {@link linkContainerSkills} closes the gap once the container is up.
 */
export const SKILLS_MOUNT = '/gurt/skills'

/**
 * Point the agent's own skills directory — `AgentManifest.skillsDir`, `$HOME`-
 * relative, e.g. claude-code's `.claude/skills` — at the read-only bind
 * (docs/requirements-skills.md §5). Where the link lands is the agent kind's
 * to say; callers skip both the mount and this link for a kind whose
 * `skillsDir` is `null`.
 *
 * Run by gurt through `docker exec`, deliberately not as part of the env's
 * `setup` script: a read-only role has its setup stripped (see
 * `createContainer`), so a script-based delivery would skip exactly the roles
 * most likely to be handed a read-only procedure. Writes into the container's
 * home, which is writable for every role — only the repo mounts and this bind
 * are read-only.
 *
 * Replaces whatever was at that path: the enabled set is the whole set the
 * session sees, which is the promise the picker makes. Idempotent, and re-run
 * after every container start.
 */
export async function linkContainerSkills(
  t: ExecTarget,
  skillsDir: string,
  log: LogSink
): Promise<void> {
  const parent = path.posix.dirname(skillsDir)
  const { code } = await dockerExec(
    t,
    [
      'sh', '-c',
      `mkdir -p "$HOME/${parent}" && rm -rf "$HOME/${skillsDir}" && ln -s ${SKILLS_MOUNT} "$HOME/${skillsDir}"`
    ],
    log
  )
  // Not fatal: the skills are mounted either way, and a session that starts
  // without them beats one that does not start. The line above says which.
  if (code !== 0) log(`could not link ${SKILLS_MOUNT} into the agent's home (exit ${code})`)
  else log(`skills mounted read-only at ${SKILLS_MOUNT}, linked as ~/${skillsDir}`)
}

/**
 * Where a session's agent history is bound inside its container — the
 * read-write counterpart of {@link SKILLS_MOUNT}, fixed and absolute for the
 * same reason (docs/requirements-agent-history.md §4 step 2).
 */
export const HISTORY_MOUNT = '/gurt/history'

/**
 * Link every entry of the agent kind's `historyPaths` (`AgentManifest`) into the
 * container's home, pointed at its own subdirectory of the read-write history
 * bind — `linkContainerHistory`, a sibling of {@link linkContainerSkills}.
 * One `sh -c` per entry, same shape as the skills link:
 *
 * ```sh
 * mkdir -p "$HOME/<parent>" && rm -rf "$HOME/<entry>" \
 *   && ln -s /gurt/history/<slug> "$HOME/<entry>"
 * ```
 *
 * `rm -rf` on the link target removes a symlink without following it, so a
 * re-link never touches the bound history
 * (docs/requirements-agent-history.md §4 step 3). Idempotent, re-run after
 * every container start.
 *
 * Failure is logged per entry and never fatal: a session that starts without
 * durable history beats one that does not start, and "which half landed"
 * matters for a CLI that degrades unevenly. `kind` rides the `history.link`
 * log line only — it is never read back.
 */
export async function linkContainerHistory(
  t: ExecTarget,
  session: string,
  kind: string,
  historyPaths: readonly string[],
  log: LogSink
): Promise<void> {
  const linked: string[] = []
  const failed: { entry: string; code: number | null }[] = []
  for (const entry of historyPaths) {
    const parent = path.posix.dirname(entry)
    const slug = historySlug(entry)
    const { code } = await dockerExec(
      t,
      [
        'sh', '-c',
        `mkdir -p "$HOME/${parent}" && rm -rf "$HOME/${entry}" && ln -s ${HISTORY_MOUNT}/${slug} "$HOME/${entry}"`
      ],
      log
    )
    const ok = code === 0
    procLog.info('history.link', { s: session, kind, path: entry, ok })
    if (ok) linked.push(entry)
    else failed.push({ entry, code })
  }
  if (linked.length)
    log(`history mounted at ${HISTORY_MOUNT}, linked as ${linked.map((e) => `~/${e}`).join(', ')}`)
  for (const f of failed)
    log(`could not link ${HISTORY_MOUNT} entry ~/${f.entry} into the agent's home (exit ${f.code})`)
}

/** Path, relative to the container `$HOME`, of the marker file that records
 *  which exact pin was last installed for an agent — keyed by agent id so
 *  unrelated agents in the same container never collide. */
function adapterMarkerPath(agent: AgentManifest): string {
  return `.gurt/adapter-versions/${agent.id}`
}

/** The marker's expected content for the *current* pin. Comparing the
 *  installed marker against this (not just the binary's presence on PATH) is
 *  what makes a pin bump reinstall into a container that already has an
 *  older version from before the bump. */
function adapterMarkerValue(agent: AgentManifest): string {
  return agent.adapterPackages.join(',')
}

/** True when the agent's adapter binary is on PATH inside the container
 *  *and* the version marker left by the last successful install matches the
 *  currently pinned `adapterPackages` exactly. The host-side installed-cache
 *  dies with the app process while the install itself lives in the container,
 *  and this probe is what keeps a fresh process from reinstalling over it — a
 *  reinstall skipped is also a reinstall that cannot rewrite the package under
 *  a live spawn. The version check on top of the PATH check is what makes a
 *  pin bump apply to a container provisioned under the old pin. */
export async function adapterPresent(t: ExecTarget, agent: AgentManifest): Promise<boolean> {
  const marker = adapterMarkerPath(agent)
  const expected = adapterMarkerValue(agent)
  const { code } = await dockerExec(
    t,
    [
      'sh', '-c',
      `command -v ${agent.bin} >/dev/null 2>&1 && [ "$(cat "$HOME/${marker}" 2>/dev/null)" = "${expected}" ]`
    ],
    () => {}
  )
  return code === 0
}

/**
 * Merges {@link linkContainerSkills} and {@link adapterPresent} into one
 * `docker exec`: in the session-start chain that mounts skills, the two run
 * back to back right after a container start
 * (`ContainerManager.installAdapter` consumes the pending link left by
 * `ensureUncoalesced`). The exit code packs both independent outcomes, since
 * one shell reports only one status: bit 0 is the adapter probe (0 = present,
 * the same sense `adapterPresent` itself returns), bit 1 is whether the skills
 * link failed — non-fatal either way, exactly as `linkContainerSkills` treats
 * it on its own.
 */
export async function probeAdapterAndLinkSkills(
  t: ExecTarget,
  agent: AgentManifest,
  skillsDir: string,
  log: LogSink
): Promise<boolean> {
  const parent = path.posix.dirname(skillsDir)
  const marker = adapterMarkerPath(agent)
  const expected = adapterMarkerValue(agent)
  const { code } = await dockerExec(
    t,
    [
      'sh', '-c',
      `skills_rc=0\n` +
        `mkdir -p "$HOME/${parent}" && rm -rf "$HOME/${skillsDir}" && ` +
        `ln -s ${SKILLS_MOUNT} "$HOME/${skillsDir}" || skills_rc=1\n` +
        `if command -v ${agent.bin} >/dev/null 2>&1 && ` +
        `[ "$(cat "$HOME/${marker}" 2>/dev/null)" = "${expected}" ]; then adapter_rc=0; else adapter_rc=1; fi\n` +
        `exit $(( skills_rc * 2 + adapter_rc ))`
    ],
    log
  )
  if ((code & 2) !== 0) log(`could not link ${SKILLS_MOUNT} into the agent's home`)
  else log(`skills mounted read-only at ${SKILLS_MOUNT}, linked as ~/${skillsDir}`)
  return (code & 1) === 0
}

/**
 * Write one small file into the agent's `$HOME` inside the container — the
 * §5.2.1 seam (docs/requirements-oauth-credentials.md): the access-only native
 * auth file an oauth-linked launch materializes (codex's, gemini's), and the
 * client's own config.
 *
 * The content goes through **stdin**: the sh argv carries no secret and no
 * quoting can mangle one, and the trace is opaque anyway. `umask 077` keeps
 * the file owner-only, like the CLIs' own writes of it.
 */
export async function writeContainerUserFile(
  t: ExecTarget,
  relPath: string,
  content: string
): Promise<void> {
  const parent = path.posix.dirname(relPath)
  const { code } = await dockerExec(
    t,
    ['sh', '-c', `umask 077 && mkdir -p "$HOME/${parent}" && cat > "$HOME/${relPath}"`],
    () => {},
    { stdin: content, quiet: true }
  )
  if (code !== 0) throw new Error(`could not write ~/${relPath} in the container (exit ${code})`)
}

/** Sentinel exit code for "the install itself succeeded but recording the
 *  version marker did not" — outside the range `npm install` itself ever
 *  exits with, so it can share the one exec's exit code with npm's own
 *  without the two being confused. */
const MARKER_WRITE_FAILED = 90

export async function installAcpAdapter(
  t: ExecTarget,
  agent: AgentManifest,
  log: LogSink
): Promise<void> {
  // gurt's node must run in *this* image: it is a glibc build, so a musl
  // (alpine) env fails here, and "node: not found" out of an npm shebang is
  // the worst place to learn that.
  const node = await dockerExec(t, [`${NODE_MOUNT}/bin/node`, '--version'], () => {})
  if (node.code !== 0)
    throw new Error(
      `gurt's Node runtime does not run in this image (exit ${node.code}` +
        `${node.tail.length ? `: ${node.tail.slice(-3).join(' | ')}` : ''}). ` +
        'The env image needs a glibc distro (Debian, Ubuntu, …) — musl/Alpine images are not supported.'
    )
  log(`installing ${agent.adapterPackages.join(', ')} in container ...`)
  // One exec for both `npm install -g` and recording the version marker
  // `adapterPresent` compares against on the next probe — the marker is
  // written only when the install exits 0 (`&&`, never on the `exit "$rc"`
  // branch above it). gurt's node leads PATH for this exec alone, so npm's own
  // `#!/usr/bin/env node` and any package's postinstall use it, not a project's
  // older one; the prefix keeps the install out of the image's own tree.
  const marker = adapterMarkerPath(agent)
  const parent = path.posix.dirname(marker)
  const { code } = await dockerExec(
    t,
    [
      'sh', '-c',
      `export PATH="${NODE_MOUNT}/bin:$PATH" NPM_CONFIG_PREFIX="$HOME/.gurt/npm"\n` +
        `${NODE_MOUNT}/bin/npm install -g ${agent.adapterPackages.map((p) => `'${p}'`).join(' ')}\n` +
        `rc=$?\n` +
        `if [ "$rc" -ne 0 ]; then exit "$rc"; fi\n` +
        `mkdir -p "$HOME/${parent}" && printf '%s' '${adapterMarkerValue(agent)}' > "$HOME/${marker}" ` +
        `&& exit 0\n` +
        `exit ${MARKER_WRITE_FAILED}`
    ],
    log,
    { level: 'info' }
  )
  if (code === MARKER_WRITE_FAILED) {
    log('could not record adapter version marker — next probe will reinstall')
    return
  }
  if (code !== 0) throw new Error(`ACP adapter install failed (exit ${code})`)
}

/**
 * The shell that launches an adapter with gurt's own node (§3.2): `$0` is the
 * bin name, the rest its args. A JS bin runs as `node <resolved script>`, so a
 * project's own, older Node on PATH can never be the one that runs it; a bin
 * that is not JS (opencode's native binary) is exec'd directly.
 */
const LAUNCH_SCRIPT =
  'f=$(readlink -f "$HOME/.gurt/npm/bin/$0" 2>/dev/null) || f=""\n' +
  '[ -n "$f" ] || { echo "$0 is not installed" >&2; exit 127; }\n' +
  'case "$f" in\n' +
  `  *.js|*.mjs|*.cjs) exec ${NODE_MOUNT}/bin/node "$f" "$@" ;;\n` +
  '  *) exec "$f" "$@" ;;\n' +
  'esac'

/** Spawns the ACP adapter inside the container; caller owns the process. The
 *  agent secret, proxy vars, git identity and launch env all go by name
 *  (`-e NAME`) with the values in the docker client's environment. */
export function spawnAcpAdapter(
  t: ExecTarget,
  agent: AgentManifest,
  secret: string,
  secretEnv: string,
  extraEnv?: Record<string, string>,
  gitIdentityEnv?: Record<string, string>
) {
  const env: Record<string, string> = {
    ...(secret ? { [secretEnv]: secret } : {}),
    ...extraEnv,
    // Commit identity for the container's local git, as GIT_CONFIG_* env (§10.3).
    // No credentials, no helper, no launcher — there are no shims to put on PATH.
    ...gitIdentityEnv
  }
  return spawnDockerExec(t, ['sh', '-c', LAUNCH_SCRIPT, agent.bin, ...agent.binArgs], env)
}

/**
 * Run one command in a session's container, as the same user and environment
 * the agent has — the host's half of the ACP client methods (`fs/*`,
 * `terminal/*`): the agent asks gurt to touch a file or run a command, and gurt
 * does it here. `argv` is the command exactly (no shell is added); `env` goes
 * by name, values in the client environment. The caller owns the process and
 * its pipes.
 */
export function spawnInContainer(t: ExecTarget, argv: string[], env?: Record<string, string>) {
  return spawnDockerExec(t, argv, env ?? {})
}

/**
 * Every gurt-created container the daemon currently knows, as session id →
 * `{ id, runtime }`, running or not. Containers are stamped `gurt.session=<id>`
 * at create, so Docker itself is the registry: this is what the persisted
 * records are reconciled against at boot, and how containers orphaned by a
 * crash (their session record never written) are found. `runtime` is the
 * `gurt.runtime` label — '' on a container made before this runtime.
 */
export function dockerSessionContainersDetailed(): Promise<
  Map<string, { id: string; runtime: string }> | null
> {
  return new Promise((resolve) => {
    const child = spawn('docker', [
      'ps', '-a',
      '--filter', 'label=gurt.session',
      '--format', '{{.Label "gurt.session"}} {{.ID}} {{.Label "gurt.runtime"}}'
    ])
    killAfter(child, PROBE_TIMEOUT_MS)
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    // null, not an empty map: "the daemon says there are none" and "we could not
    // ask the daemon" must not read alike — the caller deletes records on the
    // first and would wipe every one of them on the second.
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      if (code !== 0) return resolve(null)
      const map = new Map<string, { id: string; runtime: string }>()
      for (const line of out.split('\n')) {
        const [session, id, runtime = ''] = line.trim().split(/\s+/)
        if (session && id) map.set(session, { id, runtime })
      }
      resolve(map)
    })
  })
}

/** {@link dockerSessionContainersDetailed}, as session id → container id. */
export async function dockerSessionContainers(): Promise<Map<string, string> | null> {
  const detailed = await dockerSessionContainersDetailed()
  return detailed && new Map([...detailed].map(([s, c]) => [s, c.id]))
}

/** `docker --version`, or null when docker is not reachable — best-effort, for
 *  the startup banner (the single most useful line when a start later fails).
 *  Bounded: a hung docker binary (a half-dead Docker Desktop) must not hold the
 *  `app.start` record hostage — that record is the whole point of the probe. */
export function dockerVersion(timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['--version'])
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(null)
    }, timeoutMs)
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? out.trim() || null : null)
    })
  })
}

/**
 * The daemon's reported server version, or null when it is not answering.
 *
 * Three different questions, three different answers, and conflating any two
 * of them is how "spawn docker ENOENT" got its reputation: {@link dockerCliPath}
 * asks whether the binary exists at all, {@link dockerVersion} asks what the
 * *CLI* is (it answers perfectly well while the daemon is dead), and this asks
 * whether there is a daemon behind it.
 *
 * Bounded, like `dockerVersion`, and for a sharper reason: a half-started
 * Docker Desktop answers `info` slowly or never, which is precisely the state
 * this exists to name.
 *
 * Exit code alone is not the answer — `docker info` has historically exited 0
 * while reporting connection failures in its own body, and the template
 * renders `<nil>` for a field it cannot fill. A daemon counts as responding
 * only when the child exits 0 *and* prints a version.
 */
export function dockerDaemon(timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['info', '--format', '{{.ServerVersion}}'])
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(null)
    }, timeoutMs)
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const version = out.trim()
      resolve(code === 0 && version && version !== '<nil>' ? version : null)
    })
  })
}

/** Where the `docker` CLI is on this machine, or null when it is in none of
 *  the places gurt looks (hostPath.ts). Cheap: a few `stat`s, no subprocess. */
export function dockerCliPath(): string | null {
  return resolveHostCommand('docker')
}

/**
 * Refuse, up front, a start that cannot possibly work. Docker missing is the
 * single most common reason a session never comes up, and every path into it
 * reports the same unhelpful thing: `spawn docker ENOENT`, which reads like an
 * internal error rather than "install Docker". This turns it into the sentence
 * that says what to do, before the clone and the image build waste the user's
 * time on a start that ends there anyway.
 *
 * The lookup is a defaulted parameter so the message can be tested without
 * uninstalling docker.
 */
export function assertDockerCli(cli: string | null = dockerCliPath()): void {
  if (cli) return
  throw new Error(
    'Docker was not found on this machine. gurt runs every session in a container, so it needs ' +
      'the `docker` CLI: install Docker Desktop (or another Docker runtime), start it, and start ' +
      'the session again. If Docker is installed somewhere unusual, launching gurt from a terminal ' +
      'hands it the PATH of that shell.'
  )
}

/** Monotonic ms of the last daemon answer, for {@link assertDockerDaemon}'s
 *  positive memo. Only a *yes* is remembered: a user who has just started
 *  Docker Desktop must not have to wait out a cache. */
let daemonSeenAt = 0
/** Long enough that a burst of starts pays for one `docker info`, short enough
 *  that a daemon stopped mid-demo is never reported as up. */
const DAEMON_MEMO_MS = 5_000

/** Test seam: forget the memo. */
export function resetDockerDaemonMemo(): void {
  daemonSeenAt = 0
}

/**
 * The second half of the start preflight, beside {@link assertDockerCli}
 * (docs/requirements-first-run.md §4.2). A CLI with no daemon behind it fails
 * exactly the way a missing CLI does — every probe below swallows spawn errors
 * by design, so without this the first symptom is `Cannot connect to the
 * Docker daemon` quoted out of the tail of whichever `run` happened to go
 * first, several seconds and one clone later.
 *
 * `probe` is a parameter so the message can be tested without stopping the
 * machine's Docker.
 */
export async function assertDockerDaemon(
  probe: (timeoutMs?: number) => Promise<string | null> = dockerDaemon
): Promise<void> {
  if (Date.now() - daemonSeenAt < DAEMON_MEMO_MS) return
  if (await probe()) {
    daemonSeenAt = Date.now()
    return
  }
  throw new Error(
    'Docker is installed but its daemon is not responding. gurt runs every session in a ' +
      'container: start Docker Desktop (or your Docker runtime), wait for it to report ready, ' +
      'and start the session again.'
  )
}

/** The daemon's word on whether a container runs: `true`/`false`, and `null`
 *  when it cannot say (daemon unreachable, timeout) — a "no such container" is
 *  a plain `false`. The review loop's check termination is confirmed with this
 *  (docs/requirements-review-loop.md §5.3): an unanswered question must not
 *  read as "stopped". */
export function dockerInspectRunning(containerId: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['inspect', '-f', '{{.State.Running}}', containerId])
    killAfter(child, PROBE_TIMEOUT_MS)
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      const v = out.trim()
      resolve(v === 'true' ? true : v === 'false' ? false : code !== 0 && /no such (object|container)/i.test(err) ? false : null)
    })
  })
}

/** True only if the container exists and is actually running (survives a Docker
 *  daemon restart, after which a previously-`running` container is left `Exited`). */
export async function dockerRunning(containerId: string): Promise<boolean> {
  return (await dockerInspectRunning(containerId)) === true
}

export async function dockerStop(containerId: string, log: LogSink): Promise<void> {
  // Well above `docker stop`'s own ~10s SIGTERM grace, far below forever.
  await run('docker', ['stop', containerId], log, { timeoutMs: PROBE_TIMEOUT_MS })
}

export async function dockerRemove(containerId: string, log: LogSink): Promise<void> {
  // -v: also drop the container's anonymous volumes (image `VOLUME` entries),
  // which `rm -f` alone leaves behind forever.
  await run('docker', ['rm', '-fv', containerId], log, { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => {})
}

/**
 * Every container carrying *this* session's id-label, running or not. The same
 * registry {@link dockerSessionContainers} reads, narrowed to one session — the
 * teardown path needs it because a container can exist without any record of it
 * pointing at it: `create` stamps the label, but its id is only
 * written to the session once `up` returns, so a start that fails (or is
 * deleted) in between leaves a container findable here and nowhere else.
 */
export function dockerSessionContainerIds(session: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    const child = spawn('docker', [
      'ps', '-a', '--no-trunc',
      '--filter', `label=gurt.session=${session}`,
      '--format', '{{.ID}}'
    ])
    killAfter(child, PROBE_TIMEOUT_MS)
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    // null vs. [] carries the same distinction as in `dockerSessionContainers`:
    // "the daemon says none" must not read like "we could not ask".
    child.on('error', () => resolve(null))
    child.on('close', (code) =>
      resolve(code === 0 ? out.split('\n').map((l) => l.trim()).filter(Boolean) : null)
    )
  })
}
