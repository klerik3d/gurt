import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { EnvConfig, EnvRef, RepoConfig } from '../shared/types'
import type { AgentDef } from '../shared/agents'
import { cloneDir, overrideConfigPath, rmTree, taskDir } from './store'
import { listCredentials } from './credentials'
import { hostGitAccess } from './git/env'
import { forgeFeatures, forgeWrappers } from './git/providers'
import { BASE_SHIMS, shimInstallScript } from './git/shims'
import { LAUNCH_BIN } from './git/config'

const require = createRequire(import.meta.url)

/** Features every environment gets (adapters are npm packages). */
const BASE_FEATURES = { 'ghcr.io/devcontainers/features/node:1': {} }

function devcontainerCliPath(): string {
  return path.join(
    path.dirname(require.resolve('@devcontainers/cli/package.json')),
    'devcontainer.js'
  )
}

export type LogSink = (line: string) => void

interface RunResult {
  code: number
  stdout: string
}

/** Runs the CLI under Electron's own binary in Node mode — no system node needed. */
function runNodeCli(args: string[], log: LogSink): Promise<RunResult> {
  log(`$ devcontainer ${args.join(' ')}`)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [devcontainerCliPath(), ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    let stdout = ''
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
      for (const line of d.toString().split('\n')) if (line.trim()) log(line)
    })
    child.stderr.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n')) if (line.trim()) log(line)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout }))
  })
}

interface RunOpts {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Kill the child and reject if it hasn't exited within this many ms. */
  timeoutMs?: number
  /** Exit codes to treat as success (default [0]) — e.g. `git diff` exits 1 on differences. */
  okCodes?: number[]
}

/** Resolves with the child's stdout; exported for host-git modules (changes.ts). */
export function run(cmd: string, args: string[], log: LogSink, opts: RunOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env })
    const lines: string[] = []
    let stdout = ''
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error(`${cmd} ${args[0]} timed out after ${opts.timeoutMs}ms`))
        }, opts.timeoutMs)
      : undefined
    const onData = (d: Buffer) => {
      for (const line of d.toString().split('\n'))
        if (line.trim()) {
          lines.push(line)
          log(line)
        }
    }
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
      onData(d)
    })
    child.stderr.on('data', onData)
    child.on('error', (e) => {
      if (timer) clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if ((opts.okCodes ?? [0]).includes(code ?? -1)) resolve(stdout)
      else reject(new Error(`${cmd} ${args[0]} failed (${code}): ${lines.slice(-3).join(' | ')}`))
    })
  })
}

export async function ensureClone(ref: EnvRef, repo: RepoConfig, log: LogSink): Promise<string> {
  const dir = cloneDir(ref.workspace, ref.task, repo.name)
  // Same git-native contract as the container: a gurt-managed token clones over
  // https even from an ssh URL, and no operation blocks on a credential prompt.
  const { env, gitArgs } = await hostGitAccess(repo, await listCredentials())
  if (!existsSync(dir)) {
    await fs.mkdir(taskDir(ref.workspace, ref.task), { recursive: true })
    log(`cloning ${repo.url} ...`)
    await run('git', [...gitArgs, 'clone', '--', repo.url, dir], log, { env })
  }
  const branch = `gurt/${ref.task}`
  try {
    await run('git', ['-C', dir, ...gitArgs, 'rev-parse', '--verify', branch], () => {}, { env })
    await run('git', ['-C', dir, ...gitArgs, 'checkout', branch], log, { env })
  } catch {
    await run('git', ['-C', dir, ...gitArgs, 'checkout', '-b', branch], log, { env })
  }
  return dir
}

export async function removeClone(ws: string, task: string, repo: string): Promise<void> {
  await rmTree(cloneDir(ws, task, repo))
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

/** Shallow-clones the repo to a scratch dir and looks for its devcontainer.json. */
export async function discoverDevcontainer(url: string): Promise<DiscoveredDevcontainer | null> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gurt-discover-'))
  try {
    // Same credential policy as everything else: resolve by the URL's host
    // (auto-match — there is no RepoConfig yet), never fall back to ambient.
    // Anonymous https clones of public repos still work under the blocked env.
    // GIT_TERMINAL_PROMPT=0 → private/unreachable URLs fail fast instead of
    // blocking on a credential prompt with no terminal. `--` guards against a
    // URL beginning with `-` being parsed as a git option. The timeout is a
    // backstop for a clone that stalls on a slow/hanging network.
    const { env, gitArgs } = await hostGitAccess({ name: '', url }, await listCredentials())
    await run('git', [...gitArgs, 'clone', '--depth', '1', '--no-tags', '--', url, dir], () => {}, {
      env,
      timeoutMs: DISCOVER_TIMEOUT_MS
    })
    for (const rel of await devcontainerCandidates(dir)) {
      const content = await fs.readFile(path.join(dir, rel), 'utf8').catch(() => null)
      if (content != null) return { path: rel, content }
    }
    return null
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/**
 * Writes the user-provided inline devcontainer config (if any) to a stable
 * host path and returns the CLI args that make every command use it. The
 * same args must go to `up` and to each `exec` — exec re-resolves the config.
 */
export async function overrideConfigArgs(
  ref: EnvRef,
  env: EnvConfig | undefined
): Promise<string[]> {
  if (!env?.devcontainer.trim()) return []
  const override = overrideConfigPath(ref.workspace, ref.env)
  await fs.mkdir(path.dirname(override), { recursive: true })
  await fs.writeFile(override, env.devcontainer)
  return ['--override-config', override]
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

export async function devcontainerUp(
  session: string,
  configArgs: string[],
  workspaceFolder: string,
  log: LogSink,
  repoName: string,
  repoHost?: string | null
): Promise<UpResult> {
  // The container is agent-agnostic: only the node feature is injected, plus any
  // forge-CLI features for the repo's host (computed from the host alone, so the
  // image-level feature set is stable across ups — an installed-but-unused CLI
  // is harmless). Agent adapters are installed lazily via `exec` on connect.
  const features = { ...BASE_FEATURES, ...forgeFeatures(repoHost ?? null) }
  const args = [
    'up',
    '--workspace-folder', workspaceFolder,
    '--additional-features', JSON.stringify(features),
    ...idLabelArgs(session),
    ...configArgs
  ]
  const { code, stdout } = await runNodeCli(args, log)
  const jsonLine = stdout
    .split('\n')
    .reverse()
    .find((l) => l.trim().startsWith('{'))
  const result = jsonLine ? JSON.parse(jsonLine) : undefined
  if (code !== 0 || result?.outcome !== 'success') {
    throw new Error(result?.message ?? `devcontainer up failed (exit ${code})`)
  }
  return {
    containerId: result.containerId,
    remoteWorkspaceFolder: result.remoteWorkspaceFolder ?? '/workspaces/' + repoName
  }
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

/** True only if the container exists and is actually running (survives a Docker
 *  daemon restart, after which a previously-`running` env is left `Exited`). */
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
