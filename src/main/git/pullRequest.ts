// Host-side "push, then open a GitHub pull request" — extracted from the github
// MCP tool `create_pull_request` (mcp/githubServer.ts) so the review loop's
// delivery (docs/requirements-review-loop.md §6) and the tool run the very
// same code: the tool keeps its behaviour and its local-repo refusal, the loop
// adds `--draft`. No credential ever enters a container — everything here runs
// on the host under the repo's resolved access (git/env.ts).
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { hostGitAccessForRepo, type HostGitAccess } from './env'
import { hardenGit } from './harden'
import { providerForHost } from './providers'

const pexec = promisify(execFile)

/** Outcome of a host command: `text` is what the caller shows (stdout+stderr
 *  flattened, or the failure's), `stdout` alone is for parsing. */
export interface HostResult {
  ok: boolean
  text: string
  stdout: string
}

/**
 * gurt's main process is launched from the GUI, whose PATH often lacks the
 * Homebrew/usr-local dirs where `git`/`gh` live. Augment the resolved git env
 * so the tools resolve.
 */
export function withHostPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin']
  const path = [env['PATH'], ...extra].filter(Boolean).join(':')
  return { ...env, PATH: path }
}

/** Bounds every host subprocess: `GIT_TERMINAL_PROMPT=0` stops a *prompt*, not
 *  a TCP stall against an unreachable forge — without this the MCP call (and
 *  the agent's turn behind it) would hang forever. Generous, matching the push
 *  bound in changes.ts. */
export const TOOL_TIMEOUT_MS = 120_000

/** Run a host command in the clone; never rejects. */
export async function runHost(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<HostResult> {
  try {
    const { stdout, stderr } = await pexec(cmd, args, {
      cwd,
      env: withHostPath(env),
      maxBuffer: 10 * 1024 * 1024,
      timeout: TOOL_TIMEOUT_MS,
      killSignal: 'SIGKILL'
    })
    const text = [stdout, stderr].map((s) => s.trim()).filter(Boolean).join('\n') || `${cmd} ok`
    return { ok: true, text, stdout }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    const text =
      [err.stdout, err.stderr, err.message].map((s) => s?.trim()).filter(Boolean).join('\n') ||
      'command failed'
    return { ok: false, text, stdout: err.stdout ?? '' }
  }
}

/**
 * Env for the `gh` CLI under `access`: managed → the provider's forge env
 * (e.g. GH_TOKEN/GH_HOST) on top of the git env, so the embedded push and the
 * API call use the same credential; ambient → the host env as-is (explicit
 * `git-host`). `error` set (a message) when the credential cannot serve the
 * forge API.
 */
export async function forgeCliEnv(
  access: HostGitAccess
): Promise<{ env?: NodeJS.ProcessEnv; error?: string }> {
  if (access.mode === 'ambient') return { env: access.env }
  const provider = access.host ? providerForHost(access.host) : null
  if (!provider) return { error: `no forge provider matches host "${access.host ?? '?'}"` }
  const entry = access.resolution?.entry
  const forge = entry ? await provider.forgeEnv(entry, access.host!) : null
  if (!forge) return { error: `credential "${entry?.label ?? '?'}" cannot serve the ${provider.id} API` }
  return { env: { ...access.env, ...forge } }
}

/** The access for a pull request or any other forge call, or the reason it is
 *  refused — same policy as everywhere (no silent fallback to ambient auth). */
export async function requireForgeAccess(
  ws: string,
  repo: string
): Promise<{ access: HostGitAccess } | { error: string }> {
  const access = await hostGitAccessForRepo(ws, repo)
  if (access.mode === 'blocked')
    return { error: `git access is blocked: ${access.reason ?? 'no credential resolves'}` }
  return { access }
}

/** Refused before the push, so a call does not half-succeed: a local repo's
 *  origin is a bare repo on this machine, with no forge to open a pull request
 *  on (docs/requirements-new-projects.md §4). */
export const localRepoNoPr = (repo: string): string =>
  `repo "${repo}" is local to gurt and not published to a forge yet, so there is ` +
  'nothing to open a pull request on — use git_push to push to its local origin; ' +
  'the user can publish it from Settings → Repos'

export interface PullRequestOptions {
  title: string
  body?: string | undefined
  /** `gh pr create --draft` (the loop's `draftPr`); the MCP tool never sets it. */
  draft?: boolean | undefined
  /** Push `HEAD` first (default, the MCP tool's contract). The loop's `push`
   *  rung has already pushed, so it passes false. */
  push?: boolean | undefined
  /** The review loop's call (§6, §10): no human, an agent-writable clone — `gh`
   *  runs `git status` there, so it gets the hardened git env. */
  unattended?: boolean | undefined
}

export type PullRequestResult =
  | { ok: true; text: string; url: string | undefined }
  | { ok: false; text: string }

/** The PR URL `gh pr create` prints: its last line that is one. */
const urlOf = (stdout: string): string | undefined =>
  stdout.split('\n').map((l) => l.trim()).filter((l) => /^https?:\/\/\S+$/.test(l)).pop()

/**
 * Push the current branch of `dir` to origin and open a pull request with the
 * `gh` CLI. `gh` infers the head from the current branch and the base from the
 * repo default.
 */
export async function openPullRequest(
  ws: string,
  repo: string,
  dir: string,
  opts: PullRequestOptions
): Promise<PullRequestResult> {
  const got = await requireForgeAccess(ws, repo)
  if ('error' in got) return { ok: false, text: got.error }
  const access = opts.unattended ? await hardenGit(dir, got.access) : got.access
  if (access.mode === 'local') return { ok: false, text: localRepoNoPr(repo) }
  if (opts.push !== false) {
    const push = await runHost(
      'git',
      ['-C', dir, ...access.gitArgs, 'push', '-u', 'origin', 'HEAD'],
      dir,
      access.env
    )
    if (!push.ok) return { ok: false, text: push.text }
  }
  const gh = await forgeCliEnv(access)
  if (gh.error) return { ok: false, text: gh.error }
  const created = await runHost(
    'gh',
    ['pr', 'create', '--title', opts.title, '--body', opts.body ?? '', ...(opts.draft === true ? ['--draft'] : [])],
    dir,
    gh.env!
  )
  return created.ok
    ? { ok: true, text: created.text, url: urlOf(created.stdout) }
    : { ok: false, text: created.text }
}

/** An open pull request for `branch`, found with `gh pr view` — the recovery
 *  probe of §8 (`gh` refuses a second PR for a branch). A closed or merged one
 *  does not count; `gh` finding none is `undefined`, not an error. */
export async function findOpenPullRequest(
  ws: string,
  repo: string,
  dir: string,
  branch: string
): Promise<{ url: string } | undefined | { error: string }> {
  const got = await requireForgeAccess(ws, repo)
  if ('error' in got) return { error: got.error }
  // Only the loop probes (unattended, §8): `gh` shells out to git in the clone.
  const gh = await forgeCliEnv(await hardenGit(dir, got.access))
  if (gh.error) return { error: gh.error }
  const view = await runHost('gh', ['pr', 'view', branch, '--json', 'url,state'], dir, gh.env!)
  if (!view.ok) {
    // `gh` exits 1 with "no pull requests found for branch" when there is none;
    // anything else (auth, network) is a real failure and must not read as "none".
    if (/no pull requests? found/i.test(view.text)) return undefined
    return { error: view.text }
  }
  try {
    const pr = JSON.parse(view.stdout) as { url?: unknown; state?: unknown }
    if (pr.state === 'OPEN' && typeof pr.url === 'string') return { url: pr.url }
  } catch {
    return { error: `gh pr view printed no JSON: ${view.text.slice(0, 300)}` }
  }
  return undefined
}
