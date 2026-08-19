import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { EnvConfig, EnvRef, RepoConfig } from '../shared/types'
import type { AgentDef } from '../shared/agents'
import { envImageTag, parseEnvDevcontainer, validateEnvConfig } from '../shared/envConfig'
import type { EnvImageStatus } from '../shared/api'
import { cloneDir, getWorkspace, gurtRoot, overrideConfigPath, taskDir } from './store'
import { listCredentials } from './credentials'
import { hostGitAccess } from './git/env'
import { forgeFeatures, forgeWrappers } from './git/providers'
import { BASE_SHIMS, shimInstallScript } from './git/shims'
import { LAUNCH_BIN } from './git/config'
import { createLogger } from './log'

const require = createRequire(import.meta.url)

// Named `procLog` because most functions here take a `log: LogSink` sink.
const procLog = createLogger('proc')

/** Cap on the unterminated remainder buffered between chunks in `lineBuffer`. A
 *  process that never emits '\n' must not grow it without bound — matches the
 *  record truncation limit in log.ts. Well above any realistic secret length,
 *  but not a hard guarantee: a single line longer than this with no '\n' can
 *  still force a flush mid-secret, splitting it across two redacted records.
 *  Accepted as a rare edge case (real devcontainer/git output does not run this
 *  long without a newline) — the unbounded-growth risk this cap prevents
 *  matters more than closing that last gap. */
const MAX_LINE_BUFFER = 32 * 1024

/**
 * Trace one child process. The devcontainer CLI is rare and slow enough that
 * its lifecycle belongs in the default log; the host probes below it (`git`,
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

/** Features every environment gets (adapters are npm packages). */
const BASE_FEATURES = { 'ghcr.io/devcontainers/features/node:1': {} }

/**
 * In a packaged build the CLI lives inside app.asar, which only Electron's own
 * fs can read — we spawn it as a separate process, so it must come from the
 * unpacked mirror instead (see `asarUnpack` in electron-builder.yml). Resolving
 * still goes through the asar path; only the returned path is redirected.
 */
function devcontainerCliPath(): string {
  const dir = path
    .dirname(require.resolve('@devcontainers/cli/package.json'))
    .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
  return path.join(dir, 'devcontainer.js')
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

interface RunResult {
  code: number
  stdout: string
}

/** Runs the CLI under Electron's own binary in Node mode — no system node needed. */
function runNodeCli(args: string[], sink: LogSink): Promise<RunResult> {
  sink(`$ devcontainer ${args.join(' ')}`)
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const child = spawn(process.execPath, [devcontainerCliPath(), ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    const exited = traceProc('info', 'devcontainer', args, child.pid)
    const out = lineBuffer(sink)
    const err = lineBuffer(sink)
    let stdout = ''
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
      out.push(d)
    })
    child.stderr.on('data', (d: Buffer) => err.push(d))
    child.on('error', (e) => {
      out.flush()
      err.flush()
      exited(null, Date.now() - started, false)
      reject(e)
    })
    child.on('close', (code) => {
      out.flush()
      err.flush()
      exited(code, Date.now() - started, code === 0)
      resolve({ code: code ?? -1, stdout })
    })
  })
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
}

/** Resolves with the child's stdout; exported for host-git modules (changes.ts). */
export function run(cmd: string, args: string[], sink: LogSink, opts: RunOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env })
    const exited = traceProc('debug', cmd, args, child.pid, opts.opaqueArgv)
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
      reject(e)
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

/** True if `refs/heads/<branch>` exists in the clone. Fully qualified on
 *  purpose: the short name would also match a tag or a remote-tracking ref
 *  through rev-parse's DWIM rules, and the answer decides create-vs-switch. */
async function localBranchExists(
  dir: string,
  gitArgs: string[],
  env: NodeJS.ProcessEnv,
  branch: string
): Promise<boolean> {
  const out = await run(
    'git',
    ['-C', dir, ...gitArgs, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
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

export function ensureClone(ref: EnvRef, repo: RepoConfig, log: LogSink): Promise<string> {
  const dir = cloneDir(ref.workspace, ref.task, repo.name)
  const prev = clonesInFlight.get(dir)
  // A failed predecessor must not fail this caller — it re-runs the work itself.
  const p = (prev ? prev.catch(() => {}) : Promise.resolve()).then(() =>
    provisionClone(dir, ref, repo, log)
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
  log: LogSink
): Promise<string> {
  // Same git-native contract as the container: a gurt-managed token clones over
  // https even from an ssh URL, and no operation blocks on a credential prompt.
  const { env, gitArgs } = await hostGitAccess(repo, await listCredentials())
  if (!existsSync(dir)) {
    await fs.mkdir(taskDir(ref.workspace, ref.task), { recursive: true })
    log(`cloning ${repo.url} ...`)
    await run('git', [...gitArgs, 'clone', '--', repo.url, dir], log, { env })
  }
  const branch = ref.task
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
  if (await localBranchExists(dir, gitArgs, env, branch))
    await run('git', ['-C', dir, ...gitArgs, 'checkout', branch], log, { env })
  else await run('git', ['-C', dir, ...gitArgs, 'checkout', '-b', branch], log, { env })
  return dir
}

/** True if the clone at `dir` has uncommitted changes (staged, unstaged, or untracked). */
export function isDirty(dir: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', dir, 'status', '--porcelain'])
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', () => resolve(false))
    child.on('close', () => resolve(out.trim().length > 0))
  })
}

/** Upper bound on the discovery clone before it's killed. */
const DISCOVER_TIMEOUT_MS = 60_000

export interface DiscoveredDevcontainer {
  path: string
  content: string
  /** Companion Dockerfile, when the discovered config has `build.dockerfile`. */
  dockerfile?: { path: string; content: string }
}

/** Repo-relative paths checked, in order, plus any `.devcontainer/<name>/` variant. */
async function devcontainerCandidates(dir: string): Promise<string[]> {
  const candidates = ['.devcontainer/devcontainer.json', '.devcontainer.json']
  const devcontainerDir = path.join(dir, '.devcontainer')
  for (const entry of await fs.readdir(devcontainerDir, { withFileTypes: true }).catch(() => []))
    if (entry.isDirectory())
      candidates.push(path.join('.devcontainer', entry.name, 'devcontainer.json'))
  return candidates
}

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

/** Shallow-clones the repo to a scratch dir and looks for its devcontainer.json.
 *  When the discovered config has `build.dockerfile`, the companion Dockerfile
 *  (path resolved relative to the config's directory) is returned too — the env
 *  editor seeds both fields at once. */
export async function discoverDevcontainer(
  ws: string,
  repoName: string
): Promise<DiscoveredDevcontainer | null> {
  const repo = await requireRepo(ws, repoName)
  return withShallowClone(repo, async (dir) => {
    for (const rel of await devcontainerCandidates(dir)) {
      const content = await fs.readFile(path.join(dir, rel), 'utf8').catch(() => null)
      if (content == null) continue
      const found: DiscoveredDevcontainer = { path: rel, content }
      const buildDockerfile = parseEnvDevcontainer(content).build?.dockerfile
      if (buildDockerfile) {
        const dfAbs = path.resolve(
          dir,
          path.dirname(rel),
          buildDockerfile.replaceAll('${localWorkspaceFolder}', dir)
        )
        const dfContent = await fs.readFile(dfAbs, 'utf8').catch(() => null)
        if (dfContent != null)
          found.dockerfile = { path: path.relative(dir, dfAbs), content: dfContent }
      }
      return found
    }
    return null
  })
}

const isDockerfileName = (name: string) => name === 'Dockerfile' || name.startsWith('Dockerfile.')

/** Root `Dockerfile*` plus `.devcontainer/**`'s `Dockerfile*`, root first —
 *  candidates for a repo with no devcontainer.json to build from directly. */
async function dockerfileCandidates(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
    if (entry.isFile() && isDockerfileName(entry.name)) out.push(entry.name)
  const devcontainerDir = path.join(dir, '.devcontainer')
  for (const entry of await fs.readdir(devcontainerDir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && isDockerfileName(entry.name)) {
      out.push(path.join('.devcontainer', entry.name))
    } else if (entry.isDirectory()) {
      const sub = path.join(devcontainerDir, entry.name)
      for (const nested of await fs.readdir(sub, { withFileTypes: true }).catch(() => []))
        if (nested.isFile() && isDockerfileName(nested.name))
          out.push(path.join('.devcontainer', entry.name, nested.name))
    }
  }
  return out
}

export interface DiscoveredDockerfile {
  path: string
  content: string
}

/** Shallow-clones the repo and returns every Dockerfile candidate (repo root +
 *  `.devcontainer/**`) with its content — the env editor loads one into its
 *  (editable) Dockerfile field when there's no devcontainer.json. */
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

/** Writes `content` as the env's materialized devcontainer.json. */
async function writeOverrideConfig(ref: EnvRef, content: string): Promise<void> {
  const override = overrideConfigPath(ref.workspace, ref.env)
  await fs.mkdir(path.dirname(override), { recursive: true })
  await fs.writeFile(override, content)
}

/** ['--override-config', path] — no content logic; the file was written by
 *  `materializeEnvConfig` at `up` (it persists on disk across app restarts, so
 *  the reattach path needs nothing). The same args must go to `up` and to each
 *  `exec` — exec re-resolves the config. Mounted sessions instead resolve the
 *  per-session merged copy at `mountedConfigPath` (written by `devcontainerUp`,
 *  same persistence). */
export function overrideConfigArgs(ref: EnvRef): string[] {
  return ['--override-config', overrideConfigPath(ref.workspace, ref.env)]
}

/** The mounted session's merged devcontainer config — sibling of its wrapper
 *  workspace dir (`.multirepo/<sessionId>/devcontainer.json`), so it is
 *  per-session and lives exactly as long as the session's wrapper. */
export const mountedConfigPath = (mountedWorkspaceFolder: string): string =>
  path.join(path.dirname(mountedWorkspaceFolder), 'devcontainer.json')

/** True if an image with this tag exists in the local Docker image store. */
export function dockerImageExists(tag: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['image', 'inspect', '-f', '{{.Id}}', tag])
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

/** Builds in flight, keyed by tag — dedupes concurrent callers building the
 *  same content (e.g. two tasks starting on the same env at once). */
const buildsInFlight = new Map<string, Promise<string>>()

/**
 * Ensure the image for (repo, commit, envCfg) exists and return its tag.
 * `contextDir` is a disposable snapshot of the repo at `commit` — the env's own
 * devcontainer.json + Dockerfile are written into its `.devcontainer/`
 * (overwriting the repo's versions: the env config is the source of truth),
 * then `docker build` runs with the config's build args/target. Tagged by
 * content (`envImageTag`), so the image is built once and reused by every later
 * session on this env until the Dockerfile, the build args, or the repo's
 * committed content change. Shared by session start and Settings pre-build.
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
  const build = parseEnvDevcontainer(envCfg.devcontainer).build
  if (!build) throw new Error(`env "${envCfg.name}" has no build section — nothing to build`)
  const tag = envImageTag(repo.url, commit, envCfg.dockerfile!, build)
  const inflight = buildsInFlight.get(tag)
  if (inflight) return inflight
  const p = (async () => {
    if (await dockerImageExists(tag)) {
      log(`image ${tag} already present`)
      return tag
    }
    const devcontainerDir = path.join(contextDir, '.devcontainer')
    await fs.mkdir(devcontainerDir, { recursive: true })
    await fs.writeFile(path.join(devcontainerDir, 'devcontainer.json'), envCfg.devcontainer)
    // ${localWorkspaceFolder} in build.dockerfile/context means the repo root —
    // the CLI substitutes it at `up`, but this build runs outside the CLI.
    // Use-time only: the tag hashes the raw build object, so the temporary
    // snapshot path never enters the image identity.
    const subst = (p: string) => p.replaceAll('${localWorkspaceFolder}', contextDir)
    const dockerfilePath = path.resolve(devcontainerDir, subst(build.dockerfile ?? 'Dockerfile'))
    await fs.mkdir(path.dirname(dockerfilePath), { recursive: true })
    await fs.writeFile(dockerfilePath, envCfg.dockerfile!)
    // build.context resolves relative to `.devcontainer/`; the default is the
    // repo root — gurt's convention (documented divergence from the spec
    // default). `build.options` / `cacheFrom` are ignored (non-goals).
    const context = build.context ? path.resolve(devcontainerDir, subst(build.context)) : contextDir
    const args = ['build', '-f', dockerfilePath, '-t', tag]
    for (const [k, v] of Object.entries(build.args ?? {})) args.push('--build-arg', `${k}=${v}`)
    if (build.target) args.push('--target', build.target)
    args.push(context)
    log(`building ${tag} ...`)
    await run('docker', args, log)
    return tag
  })()
  buildsInFlight.set(tag, p)
  p.finally(() => buildsInFlight.delete(tag)).catch(() => {})
  return p
}

/**
 * Write the env's effective devcontainer.json to `overrideConfigPath` and
 * return ['--override-config', path]. Without a `build` section the stored
 * config is written verbatim (JSONC is fine, the CLI reads it). With one, the
 * image is ensured first — built in a temporary snapshot of the clone at HEAD
 * (`git archive`; the working clone is never touched) — and the materialized
 * config has `build` replaced by `image: tag`, all other fields preserved.
 * Comments are lost only in that materialized file, never in the stored config.
 */
export async function materializeEnvConfig(
  ref: EnvRef,
  envCfg: EnvConfig,
  repo: RepoConfig,
  cloneDir: string,
  log: LogSink
): Promise<string[]> {
  const invalid = validateEnvConfig(envCfg)
  if (invalid) throw new Error(`env "${envCfg.name}": ${invalid}`)
  const { config, build } = parseEnvDevcontainer(envCfg.devcontainer)
  if (!build) {
    await writeOverrideConfig(ref, envCfg.devcontainer)
    return overrideConfigArgs(ref)
  }
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'gurt-env-snapshot-'))
  try {
    const tarFile = path.join(scratch, 'src.tar')
    const srcDir = path.join(scratch, 'src')
    await fs.mkdir(srcDir)
    await run('git', ['-C', cloneDir, 'archive', '--format=tar', '-o', tarFile, 'HEAD'], log)
    await run('tar', ['-xf', tarFile, '-C', srcDir], log)
    const commit = (await run('git', ['-C', cloneDir, 'rev-parse', 'HEAD'], () => {})).trim()
    const tag = await buildEnvImage(repo, envCfg, srcDir, commit, log)
    const materialized: Record<string, unknown> = { ...config!, image: tag }
    delete materialized.build
    await writeOverrideConfig(ref, JSON.stringify(materialized, null, 2))
    return overrideConfigArgs(ref)
  } finally {
    await fs.rm(scratch, { recursive: true, force: true })
  }
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
  const build = parseEnvDevcontainer(envCfg.devcontainer).build
  if (!build) return { state: 'not-applicable' }
  const repo = envCfg.repo ? wsData.repos.find((r) => r.name === envCfg.repo) : undefined
  if (!repo) return { state: 'no-repo' }
  const commit = await remoteHead(repo)
  const tag = envImageTag(repo.url, commit, envCfg.dockerfile!, build)
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
  if (!parseEnvDevcontainer(envCfg.devcontainer).build)
    throw new Error(`env "${envName}" has no build section — nothing to build`)
  const repo = envCfg.repo ? wsData.repos.find((r) => r.name === envCfg.repo) : undefined
  if (!repo) throw new Error(`env "${envName}" has no default repository to build from`)
  const tag = await withShallowClone(repo, async (dir) => {
    const commit = (await run('git', ['-C', dir, 'rev-parse', 'HEAD'], () => {})).trim()
    return buildEnvImage(repo, envCfg, dir, commit, log)
  })
  return { tag }
}

/**
 * Id-labels are the devcontainer CLI's find-key for an existing container.
 * A container belongs to exactly one session, so the session IS the identity —
 * one label, passed identically by `up`, `exec` and the adapter spawn. The env
 * manager guarantees at most one container per env (it removes any other
 * session's container before `up`).
 */
function idLabelArgs(session: string): string[] {
  return ['--id-label', `gurt.session=${session}`]
}

export interface UpResult {
  containerId: string
  remoteWorkspaceFolder: string
}

/**
 * The CLI announces every lifecycle hook it is about to run with this banner
 * (`Running the postCreateCommand from devcontainer.json...`, or
 * `Running 'name' from <feature>...` for named/feature commands). Seeing it is
 * the point where the image is done and the container exists — everything after
 * it is post-commands. Bold-ANSI wrapped, hence the loose match.
 */
const LIFECYCLE_BANNER = /Running (?:the \w+|'[^']*') from /

/** Docker Desktop (macOS) reports a host path it has stale-cached as missing,
 *  prefixed with the VM's /host_mnt root. */
const STALE_BIND_RE = /bind source path does not exist: (?:\/host_mnt)?(\/\S+)/

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

export async function devcontainerUp(
  session: string,
  configArgs: string[],
  workspaceFolder: string,
  log: LogSink,
  repoName: string,
  repoHost?: string | null,
  /** Called once, when `up` moves from building the image to post-commands. */
  onPostCommands?: () => void,
  /** Repos mounted explicitly as siblings under the container-side root
   *  (`/workspaces/<repoName>/<name>`), instead of through the workspace folder
   *  itself: every repo of a session whose `--workspace-folder` is the empty
   *  wrapper directory. That is any session with more than one repo, and any
   *  read-only role — `readonly` is what the CLI's own workspace mount can never
   *  be. Empty for a plain read-write single-repo session. */
  extraMounts: { hostDir: string; name: string; readonly?: boolean }[] = []
): Promise<UpResult> {
  // The container is agent-agnostic: only the node feature is injected, plus any
  // forge-CLI features for the repo's host (computed from the host alone, so the
  // image-level feature set is stable across ups — an installed-but-unused CLI
  // is harmless). Agent adapters are installed lazily via `exec` on connect.
  const features = { ...BASE_FEATURES, ...forgeFeatures(repoHost ?? null) }
  const remoteRoot = '/workspaces/' + repoName
  // The CLI's `--mount` argument is validated by a strict regex
  // (`type=,source=,target=[,external=]`) with no `readonly` key, while strings
  // in the config's `mounts` array go to `docker --mount` verbatim — the only
  // channel that can express a read-only bind. `readonly` (docker's own
  // flag-style key) is the filesystem-level enforcement a read-only role asks
  // for — not a convention the agent could talk itself out of. The env's
  // materialized config is shared per (workspace, env) while mounts are
  // per-session, so the merged copy lives beside the session's wrapper dir —
  // and every `exec` of a mounted session must resolve it too (the config
  // decides the exec cwd and the reported remoteWorkspaceFolder).
  let mountConfigArgs = configArgs
  if (extraMounts.length) {
    const envConfigPath = configArgs[configArgs.indexOf('--override-config') + 1]
    const { config, error } = parseEnvDevcontainer(await fs.readFile(envConfigPath, 'utf8'))
    if (error) throw new Error(`materialized config ${envConfigPath}: ${error}`)
    // The sibling mounts land under the env's own workspace root: the config's
    // workspaceFolder/workspaceMount stay untouched, so its workspaceMount
    // still binds `${localWorkspaceFolder}` — here the empty wrapper dir — over
    // the image's baked copy at the configured path, and each repo binds inside
    // it by name (`<workspaceFolder>/<repo>`). Only without a configured
    // workspaceFolder does the wrapper's CLI-default landing spot
    // (`/workspaces/<basename>` = remoteRoot) serve as the root.
    const mountRoot =
      typeof config!.workspaceFolder === 'string' && config!.workspaceFolder
        ? (config!.workspaceFolder as string).replace(/\/+$/, '')
        : remoteRoot
    const merged: Record<string, unknown> = {
      ...config,
      mounts: [
        ...(Array.isArray(config!.mounts) ? config!.mounts : []),
        ...extraMounts.map(
          (m) =>
            `type=bind,source=${m.hostDir},target=${mountRoot}/${m.name}${m.readonly ? ',readonly' : ''}`
        )
      ]
    }
    await fs.writeFile(mountedConfigPath(workspaceFolder), JSON.stringify(merged, null, 2))
    mountConfigArgs = ['--override-config', mountedConfigPath(workspaceFolder)]
  }
  const args = [
    'up',
    '--workspace-folder', workspaceFolder,
    '--additional-features', JSON.stringify(features),
    ...idLabelArgs(session),
    ...mountConfigArgs
  ]
  let announced = false
  const MAX_ATTEMPTS = 3
  /** Waits before attempt 2 and 3. The stale window is time-sensitive and
   *  self-heals on its own eventually — back-to-back retries seconds apart all
   *  failed, so give the VM a moment after each warm-up. */
  const BACKOFF_MS = [2_000, 5_000]
  /** Every path this run has reported as missing. One `up` can report several
   *  (the whole subtree goes stale together), and only the last attempt's
   *  wording reaches the user, so accumulate across attempts. */
  const stalePaths = new Set<string>()
  for (let attempt = 1; ; attempt++) {
    let sawStale = false
    const watch: LogSink = (line) => {
      if (!announced && LIFECYCLE_BANNER.test(line)) {
        announced = true
        onPostCommands?.()
      }
      const staleMatch = STALE_BIND_RE.exec(line)
      if (staleMatch) {
        sawStale = true
        stalePaths.add(staleMatch[1])
      }
      log(line)
    }
    const { code, stdout } = await runNodeCli(args, watch)
    const jsonLine = stdout
      .split('\n')
      .reverse()
      .find((l) => l.trim().startsWith('{'))
    const result = jsonLine ? JSON.parse(jsonLine) : undefined
    if (code !== 0 || result?.outcome !== 'success') {
      // Anything that is not the stale-bind condition fails on the first
      // attempt, exactly as it did before the retry existed.
      if (!sawStale) throw new Error(result?.message ?? `devcontainer up failed (exit ${code})`)
      if (attempt < MAX_ATTEMPTS) {
        // Warm every bind source of this `up`, not just the reported one: the
        // staleness covers a whole subtree, so the next path would fail next.
        await warmBindPaths(
          [workspaceFolder, ...extraMounts.map((m) => m.hostDir), ...stalePaths],
          log
        )
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1] ?? 5_000))
        continue
      }
      // The raw `docker run ...` command line the CLI reports says nothing
      // about why it failed; lead with the cause and the way out instead.
      throw new Error(
        `container start failed: Docker could not see ${[...stalePaths].join(', ')} even ` +
          `though it exists on the host (Docker Desktop's stale path cache). Retried ` +
          `${MAX_ATTEMPTS}× with a cache warm-up. If this keeps happening, restart ` +
          `Docker Desktop, or switch Settings → Resources → File sharing to gRPC FUSE.`
      )
    }
    return {
      containerId: result.containerId,
      remoteWorkspaceFolder: result.remoteWorkspaceFolder ?? remoteRoot
    }
  }
}

/** True when the agent's adapter binary is already on PATH inside the
 *  container. Probed through `devcontainer exec` — the same environment the
 *  install and the adapter spawn resolve, so PATH (nvm's node) reads the same
 *  way for all three. The host-side installed-cache dies with the app process
 *  while the install itself lives in the container, and this probe is what
 *  keeps a fresh process from reinstalling over it — a reinstall skipped is
 *  also a reinstall that cannot rewrite the package under a live spawn. */
export async function adapterPresent(
  session: string,
  agent: AgentDef,
  configArgs: string[],
  workspaceFolder: string
): Promise<boolean> {
  const { code } = await runNodeCli(
    [
      'exec',
      '--workspace-folder', workspaceFolder,
      ...idLabelArgs(session),
      ...configArgs,
      'sh', '-c', `command -v ${agent.bin}`
    ],
    () => {}
  )
  return code === 0
}

export async function installAcpAdapter(
  session: string,
  agent: AgentDef,
  configArgs: string[],
  workspaceFolder: string,
  log: LogSink
): Promise<void> {
  log(`installing ${agent.adapterPackages.join(', ')} in container ...`)
  const { code } = await runNodeCli(
    [
      'exec',
      '--workspace-folder', workspaceFolder,
      ...idLabelArgs(session),
      ...configArgs,
      'npm', 'install', '-g', ...agent.adapterPackages
    ],
    log
  )
  if (code !== 0) throw new Error(`ACP adapter install failed (exit ${code})`)
}

/**
 * Write the git shims into the container (§5), lazily, like the adapter install:
 * the launcher + credential helper always, plus any forge-CLI wrappers for the
 * repo's host. Idempotent — content is overwritten each call.
 *
 * Runs as root via `docker exec` (not `devcontainer exec`): /opt is root-owned
 * while the remoteUser is usually non-root, so a user-level `mkdir -p
 * /opt/gurt/bin` fails with EACCES. Shims hold no secrets; root-owned 755 also
 * keeps the agent from rewriting them.
 */
export async function installGitShims(
  containerId: string,
  repoHost: string | null,
  log: LogSink
): Promise<void> {
  const names = [...BASE_SHIMS, ...forgeWrappers(repoHost)]
  log(`installing git shims (${names.join(', ')}) in container ...`)
  try {
    await run('docker', ['exec', '-u', 'root', containerId, 'sh', '-c', shimInstallScript(names)], log)
  } catch (e) {
    throw new Error(`git shim install failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Spawns the ACP adapter inside the environment; caller owns the process. */
export function spawnAcpAdapter(
  session: string,
  agent: AgentDef,
  configArgs: string[],
  workspaceFolder: string,
  secret: string,
  secretEnv: string,
  extraEnv?: Record<string, string>,
  gitEnv?: Record<string, string>
) {
  const args = [
    devcontainerCliPath(),
    'exec',
    '--workspace-folder', workspaceFolder,
    ...idLabelArgs(session),
    ...configArgs
  ]
  if (secret) args.push('--remote-env', `${secretEnv}=${secret}`)
  for (const [k, v] of Object.entries(extraEnv ?? {}))
    args.push('--remote-env', `${k}=${v}`)
  // Git access (§6): broker URL + GIT_CONFIG_* injected as env (never secrets),
  // and the agent command run through the launcher so the shims shadow container
  // binaries for the agent's process tree only.
  for (const [k, v] of Object.entries(gitEnv ?? {})) args.push('--remote-env', `${k}=${v}`)
  if (gitEnv) args.push(LAUNCH_BIN)
  args.push(agent.bin, ...agent.binArgs)
  return spawn(process.execPath, args, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

/**
 * Every gurt-created container the daemon currently knows, as session id →
 * container id, running or not. Containers are stamped `gurt.session=<id>` at
 * `up`, so Docker itself is the registry: this is what the persisted records
 * are reconciled against at boot, and how containers orphaned by a crash (their
 * session record never written) are found.
 */
export function dockerSessionContainers(): Promise<Map<string, string> | null> {
  return new Promise((resolve) => {
    const child = spawn('docker', [
      'ps', '-a',
      '--filter', 'label=gurt.session',
      '--format', '{{.Label "gurt.session"}} {{.ID}}'
    ])
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    // null, not an empty map: "the daemon says there are none" and "we could not
    // ask the daemon" must not read alike — the caller deletes records on the
    // first and would wipe every one of them on the second.
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      if (code !== 0) return resolve(null)
      const map = new Map<string, string>()
      for (const line of out.split('\n')) {
        const [session, id] = line.trim().split(/\s+/)
        if (session && id) map.set(session, id)
      }
      resolve(map)
    })
  })
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

/** True only if the container exists and is actually running (survives a Docker
 *  daemon restart, after which a previously-`running` container is left `Exited`). */
export function dockerRunning(containerId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['inspect', '-f', '{{.State.Running}}', containerId])
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', () => resolve(false))
    child.on('close', () => resolve(out.trim() === 'true'))
  })
}

export async function dockerStop(containerId: string, log: LogSink): Promise<void> {
  await run('docker', ['stop', containerId], log)
}

export async function dockerRemove(containerId: string, log: LogSink): Promise<void> {
  await run('docker', ['rm', '-f', containerId], log).catch(() => {})
}

/**
 * Every container carrying *this* session's id-label, running or not. The same
 * registry {@link dockerSessionContainers} reads, narrowed to one session — the
 * teardown path needs it because a container can exist without any record of it
 * pointing at it: `up` stamps the label at `docker run`, but its id is only
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
