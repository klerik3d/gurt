// Host git on a clone the agent can write, with no human present
// (docs/requirements-review-loop.md §6, §10). The clone's `.git` sits in the
// executor's read-write bind, so the agent controls `.git/config` and
// `.git/hooks` — and git runs what they name: a hook, `core.fsmonitor`, a
// `filter.<name>.clean` driver, a `diff.external` / textconv program,
// `core.sshCommand`, a credential helper, `remote.<n>.uploadpack` (the program a
// local or ssh fetch runs), a gpg program. The loop's host git (diff hash, the reviewer's diff, delivery) would
// run any of them as the desktop user, unattended. This module is the ONE place
// that stops that, for every call that goes through `changes.git()` with an
// `unattended` access (`unattendedGitAccessForRepo`).
//
// A deny-list, because git offers no "ignore the repo's config" switch; what it
// does not list stays as it is (§10 names the residue). The rule it applies:
// a setting that the CLONE's own config (scope `local` / `worktree`) defines
// and that can run a program is pinned — to the host's own value of the same
// key (system / global / `-c`: the agent cannot write those) when there is
// one, else to an inert default. So a host's git-lfs filter, ssh command or
// credential helper keeps working, and only the clone's override is dropped.
// Hooks are off outright: `core.hooksPath` is an empty host-owned directory.
//
// `-c` argv, not GIT_CONFIG_COUNT (env.ts's reason: older gits ignore it), and
// the same pairs go into GIT_CONFIG_PARAMETERS so that a tool the host runs in
// the clone — `gh` shells out to `git status` — is held to them as well.
// `GIT_CONFIG_NOSYSTEM` is deliberately NOT set: the system config is the host's
// (a credential helper or an LFS filter may live there).
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { run } from '../provision'
import { gurtRoot } from '../paths'
import { gitConfigArgs, type ConfigPair } from './config'
import type { HostGitAccess } from './env'

/** An empty directory no container can reach: hook lookups (`core.hooksPath`)
 *  find nothing in it. Created on first use. */
export async function emptyHooksDir(): Promise<string> {
  const dir = path.join(gurtRoot, 'git-no-hooks')
  await fs.mkdir(dir, { recursive: true })
  return dir
}

interface ConfigEntry {
  scope: string
  key: string
  value: string
}

/** The host's own scopes; anything else (`local`, `worktree`, a scope a newer
 *  git invents) is treated as the agent's. */
const HOST_SCOPES = new Set(['system', 'global', 'command'])

/** `git config --list --show-scope -z`: `scope NUL key NL value NUL` per entry
 *  (a valueless key has no NL). Reading config executes nothing. */
function parseConfigList(out: string): ConfigEntry[] {
  const parts = out.split('\0')
  const entries: ConfigEntry[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const kv = parts[i + 1]!
    const nl = kv.indexOf('\n')
    entries.push({ scope: parts[i]!, key: nl < 0 ? kv : kv.slice(0, nl), value: nl < 0 ? '' : kv.slice(nl + 1) })
  }
  return entries
}

/** A shell-quoted program path for `core.sshCommand`. */
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** GIT_CONFIG_PARAMETERS in the format every git version reads (`'key=value'`,
 *  space-separated, single-quoted). */
const configParameters = (pairs: ConfigPair[]): string =>
  pairs.map(([k, v]) => `'${`${k}=${v}`.replace(/'/g, `'\\''`)}'`).join(' ')

/** Inert stand-ins, by the variable a program setting ends in. */
const FILTER_NEUTRAL: Record<string, string> = { clean: 'cat', smudge: 'cat', process: '', required: 'false' }

/** Settings that run a program or sign with a key when the clone defines them. */
const PROGRAM_KEYS: Record<string, (env: NodeJS.ProcessEnv) => string> = {
  // GIT_SSH_COMMAND (env, the host's) already outranks it; the fallback is what
  // git itself would run.
  'core.sshcommand': (env) => (env['GIT_SSH'] ? shq(env['GIT_SSH']) : 'ssh'),
  'core.askpass': () => '',
  'commit.gpgsign': () => 'false',
  'tag.gpgsign': () => 'false',
  'gpg.program': () => 'gpg',
  'gpg.openpgp.program': () => 'gpg',
  'gpg.x509.program': () => 'gpgsm',
  'gpg.ssh.program': () => 'ssh-keygen',
  'gpg.ssh.defaultkeycommand': () => ''
}

/**
 * `access` made safe for unattended git in the clone `dir`: the clone's config
 * is read (`config --list`, nothing runs), its program-running settings are
 * pinned as described above, hooks are off. Fails closed: a git without
 * `--show-scope` (< 2.26), or a name that cannot ride in a `-c` (a `=` in a
 * filter or remote name would split the key there, and the pin would pin
 * another key), throws instead of running unpinned.
 */
export async function hardenGit(dir: string, access: HostGitAccess): Promise<HostGitAccess> {
  const listing = await run('git', ['-C', dir, 'config', '--list', '--show-scope', '-z'], () => {}, { env: access.env })
  const entries = parseConfigList(listing)
  const mine = entries.filter((e) => !HOST_SCOPES.has(e.scope))
  const host = (key: string): ConfigEntry[] => entries.filter((e) => HOST_SCOPES.has(e.scope) && e.key === key)
  const defined = new Set(mine.map((e) => e.key))

  const pairs: ConfigPair[] = [
    ['core.hooksPath', await emptyHooksDir()],
    ['core.fsmonitor', 'false'],
    ['core.pager', 'cat'],
    // ext:: runs a command as a "URL"; never, whatever the clone says.
    ['protocol.ext.allow', 'never']
  ]
  const pin = (key: string, neutral: string | undefined, force = false): void => {
    if (!force && !defined.has(key)) return
    if (key.includes('=')) throw new Error(`host git refused: "${key}" cannot be pinned (the name contains "=")`)
    const hostValues = host(key)
    if (hostValues.length) for (const e of hostValues) pairs.push([key, e.value])
    else if (neutral !== undefined) pairs.push([key, neutral])
  }

  for (const [key, neutral] of Object.entries(PROGRAM_KEYS)) pin(key, neutral(access.env))
  const filters = new Set<string>()
  for (const key of defined) {
    const f = /^filter\.(.+)\.(clean|smudge|process|required)$/.exec(key)
    if (f) filters.add(f[1]!)
    if (/^remote\..+\.proxy$/.test(key)) pin(key, '')
  }
  // A filter the clone names is replaced as a whole — all four keys — so a
  // host `clean` is not paired with the clone's `smudge`.
  for (const name of filters)
    for (const [v, neutral] of Object.entries(FILTER_NEUTRAL)) pin(`filter.${name}.${v}`, neutral, true)
  // Helpers form a list: reset it, then re-add the host's, in config order.
  const helperKey = /^credential\.(.+\.)?helper$/
  if ([...defined].some((k) => helperKey.test(k))) {
    pairs.push(['credential.helper', ''])
    for (const e of entries)
      if (HOST_SCOPES.has(e.scope) && helperKey.test(e.key)) {
        if (e.key.includes('=')) throw new Error(`host git refused: "${e.key}" cannot be pinned (the name contains "=")`)
        pairs.push([e.key, e.value])
      }
  }

  const env: NodeJS.ProcessEnv = { ...access.env, GIT_PAGER: 'cat' }
  // `-c` cannot override these two: `core.gitProxy` is first-wins, and
  // `core.worktree` is read before `-c`; their environment variables outrank
  // the config.
  if (defined.has('core.gitproxy') && env['GIT_PROXY_COMMAND'] === undefined) env['GIT_PROXY_COMMAND'] = ''
  if (defined.has('core.worktree') && env['GIT_WORK_TREE'] === undefined) env['GIT_WORK_TREE'] = path.resolve(dir)
  const inherited = env['GIT_CONFIG_PARAMETERS']
  env['GIT_CONFIG_PARAMETERS'] = [inherited, configParameters(pairs)].filter(Boolean).join(' ')
  // Ours first, the access's own after: its credential helper, ssh command and
  // identity outrank the pins.
  return { ...access, gitArgs: [...gitConfigArgs(pairs), ...access.gitArgs], env }
}

/** Flags for the subcommands whose program a `-c` cannot pin, added after the
 *  subcommand (`-c k=v` / `-C dir` come first): `diff` / `show` / `log` run
 *  `diff.external` and textconv programs unless told not to; `remote.<n>.uploadpack`
 *  and `.receivepack` are first-wins (git warns "more than one … given, using the
 *  first" and keeps the clone's), but an option on the command line outranks
 *  them. */
export function unattendedArgs(args: string[]): string[] {
  let i = 0
  while (i < args.length && (args[i] === '-c' || args[i] === '-C')) i += 2
  const flags: Record<string, string[]> = {
    diff: ['--no-ext-diff', '--no-textconv'],
    show: ['--no-ext-diff', '--no-textconv'],
    log: ['--no-ext-diff', '--no-textconv'],
    fetch: ['--upload-pack=git-upload-pack'],
    'ls-remote': ['--upload-pack=git-upload-pack'],
    push: ['--receive-pack=git-receive-pack']
  }
  const add = flags[args[i] ?? '']
  return add ? [...args.slice(0, i + 1), ...add, ...args.slice(i + 1)] : args
}
