// Local repos (docs/requirements-new-projects.md §2): a repository gurt
// creates itself, for a project that has no forge yet. Its storage is a bare
// repo under `~/.gurt/<ws>/repos/<name>.git`, and that path is the registered
// `url` — so a task clones it, branches `gurt/<task>` off it and pushes back to
// it through exactly the code paths a forge repo uses. Only the forge-facing
// verbs (pull requests, publishing) know the difference — and publishing is
// how it stops being local.
import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import type { PublishResult, PublishSpec, RepoConfig } from '../shared/types'
import * as store from './store'
import { discoverDevcontainer, run } from './provision'
import { listCredentials } from './credentials'
import { hostGitAccess } from './git/env'
import { providerForHost } from './git/providers'

/** Upper bound on pushing a whole history to a fresh forge repo. */
const PUSH_TIMEOUT_MS = 300_000

/** The default branch a new local repo starts on. */
export const LOCAL_DEFAULT_BRANCH = 'main'

/** Fixed identity of the one commit gurt itself makes: the empty root every
 *  later commit sits on. Nobody's credential is involved — there is none yet. */
const SEED_IDENTITY = {
  GIT_AUTHOR_NAME: 'gurt',
  GIT_AUTHOR_EMAIL: 'gurt@localhost',
  GIT_COMMITTER_NAME: 'gurt',
  GIT_COMMITTER_EMAIL: 'gurt@localhost'
}

/**
 * Create a bare repo with one empty commit on `main` and register it in the
 * workspace as a local repo. The seed commit is what makes the rest of gurt
 * work unchanged on a brand-new project: the task branch has a commit to fork
 * from, an image build has a `HEAD` to `git archive`, and the changes panel has
 * an `origin/main` to measure against.
 *
 * A directory already at the target path is refused, never adopted or
 * overwritten — it is somebody's history.
 */
export async function createLocalRepo(ws: string, name: string): Promise<RepoConfig> {
  const trimmed = name.trim()
  // First: the name becomes a path segment of the directory created below.
  store.validateName('repo', trimmed)
  if ((await store.getWorkspace(ws)).repos.some((r) => r.name === trimmed))
    throw new Error(`repo "${trimmed}" already exists in "${ws}"`)
  const dir = store.localRepoDir(ws, trimmed)
  if (existsSync(dir)) throw new Error(`${dir} already exists — remove it or pick another name`)
  const repo: RepoConfig = { name: trimmed, url: dir, local: true }
  // From here on a failure would leave the directory behind; the cleanup below
  // covers every step, the registration included.
  await fs.mkdir(store.localReposDir(ws), { recursive: true })
  try {
    const log = (): void => {}
    const env = { ...process.env, ...SEED_IDENTITY }
    await run('git', ['init', '-q', '--bare', `--initial-branch=${LOCAL_DEFAULT_BRANCH}`, dir], log)
    const tree = (
      await run('git', ['-C', dir, 'hash-object', '-w', '-t', 'tree', '/dev/null'], log)
    ).trim()
    const commit = (
      await run('git', ['-C', dir, 'commit-tree', tree, '-m', 'Initial commit'], log, { env })
    ).trim()
    await run('git', ['-C', dir, 'update-ref', `refs/heads/${LOCAL_DEFAULT_BRANCH}`, commit], log)
    await store.addRepo(ws, repo)
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true })
    throw e
  }
  return repo
}

/**
 * Publish a local repo to a forge (docs/requirements-new-projects.md §6):
 * create the forge repository, push every branch of the bare storage there,
 * point the registry and every task's clone at it, and drop the storage. From
 * then on it is an ordinary repo — pull requests, the github MCP and all.
 *
 * Ordered so a failure leaves the repo usable: until the push has landed
 * nothing local has changed (a repo created on the forge but not pushed to is
 * the one leftover, and the error names it). Adopting the env comes last and
 * never undoes a publish — a failure there is reported, not thrown.
 */
export async function publishLocalRepo(
  ws: string,
  name: string,
  spec: PublishSpec
): Promise<PublishResult> {
  const repo = (await store.getWorkspace(ws)).repos.find((r) => r.name === name)
  if (!repo) throw new Error(`repo "${name}" is not registered in "${ws}"`)
  if (!repo.local) throw new Error(`repo "${name}" is already on a forge`)

  const credentials = await listCredentials()
  const cred = credentials.find((c) => c.id === spec.credentialId)
  if (!cred) throw new Error(`credential "${spec.credentialId}" not found`)
  const host = cred.hosts?.find((h) => providerForHost(h))
  const provider = host ? providerForHost(host) : null
  if (!host || !provider)
    throw new Error(`credential "${cred.label}" names no forge host gurt can create a repo on`)

  // Read before anything moves: discovery clones from the url, which is still
  // the local storage here and will be gone once the publish is through.
  const discovered = spec.adoptEnv ? await discoverDevcontainer(ws, name) : null

  const created = await provider.createRepo(cred, host, {
    name: spec.remoteName?.trim() || name,
    owner: spec.owner?.trim() || undefined,
    private: spec.private
  })
  const published: RepoConfig = { name, url: created.cloneUrl, credentialId: cred.id }
  const access = await hostGitAccess(published, credentials)
  if (access.mode !== 'managed' && access.mode !== 'ambient')
    throw new Error(
      `created ${created.webUrl}, but cannot push to it: ${access.reason ?? 'no credential resolves'}`
    )
  try {
    await run(
      'git',
      ['-C', repo.url, ...access.gitArgs, 'push', '--all', '--', created.cloneUrl],
      () => {},
      { env: access.env, timeoutMs: PUSH_TIMEOUT_MS }
    )
  } catch (e) {
    throw new Error(
      `created ${created.webUrl}, but pushing the history failed — ` +
        `${e instanceof Error ? e.message : String(e)}`,
      { cause: e }
    )
  }

  await store.markRepoPublished(ws, name, created.cloneUrl, cred.id)
  // Every branch a clone tracks was in the storage, so it is on the forge now
  // too: re-pointing origin leaves each clone's remote-tracking refs true, and
  // the next fetch finds them all (no false "integrated" from a prune).
  for (const task of await store.tasksUsingRepo(ws, name))
    await run(
      'git',
      ['-C', store.cloneDir(ws, task, name), 'remote', 'set-url', 'origin', created.cloneUrl],
      () => {}
    )
  await store.rmTree(store.localRepoDir(ws, name))

  const result: PublishResult = { url: created.cloneUrl, webUrl: created.webUrl }
  if (!spec.adoptEnv) return result
  if (!discovered) return { ...result, envNote: 'the repo has no devcontainer.json' }
  if ((await store.getWorkspace(ws)).envs.some((e) => e.name === name))
    return { ...result, envNote: `an env named "${name}" already exists — left as is` }
  try {
    await store.addEnv(ws, {
      name,
      devcontainer: discovered.content,
      ...(discovered.dockerfile
        ? { dockerfile: discovered.dockerfile.content, dockerfilePath: discovered.dockerfile.path }
        : {}),
      repo: name
    })
    return { ...result, env: name }
  } catch (e) {
    return { ...result, envNote: e instanceof Error ? e.message : String(e) }
  }
}
