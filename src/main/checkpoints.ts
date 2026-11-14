// Host Git snapshots. Only the disposable index is ever staged or restored.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { git, serialized } from './changes'
import { hostGitAccessForRepo, type HostGitAccess } from './git/env'
import { cloneDir } from './store'
import { writeRepos, type SessionInfo } from '../shared/types'

export const checkpointRef = (session: string, key: string | number): string =>
  `refs/gurt/checkpoints/${session}/${key}`

export class Checkpoints {
  constructor(readonly dir: string, readonly access: HostGitAccess) {}

  private async index<T>(action: (g: (args: string[]) => Promise<string>) => Promise<T>): Promise<T> {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'gurt-checkpoint-'))
    try {
      const access = { ...this.access, env: { ...this.access.env,
        GIT_INDEX_FILE: path.join(temp, 'index'),
        GIT_AUTHOR_NAME: 'gurt', GIT_AUTHOR_EMAIL: 'gurt@localhost',
        GIT_COMMITTER_NAME: 'gurt', GIT_COMMITTER_EMAIL: 'gurt@localhost' } }
      return await action((args) => git(this.dir, access, args))
    } finally { await fs.rm(temp, { recursive: true, force: true }) }
  }

  async snapshot(ref: string): Promise<string> {
    return serialized(this.dir, () => this.index(async (g) => {
      const head = (await git(this.dir, this.access,
        ['rev-parse', '--verify', '--quiet', 'HEAD'], { okCodes: [0, 1] })).trim()
      await g(head ? ['read-tree', head] : ['read-tree', '--empty'])
      await g(['add', '-A', '--', '.'])
      const tree = (await g(['write-tree'])).trim()
      const sha = (await g(['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', 'Gurt checkpoint'])).trim()
      await g(['update-ref', ref, sha])
      return sha
    }))
  }

  async resolve(ref: string): Promise<string> {
    const sha = (await git(this.dir, this.access,
      ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { okCodes: [0, 1] })).trim()
    if (!sha) throw new Error(`No checkpoint: ${ref}`)
    return sha
  }

  async restore(target: string, current: string): Promise<void> {
    await serialized(this.dir, () => this.index(async (g) => {
      await g(['read-tree', current])
      await g(['update-index', '--refresh'])
      // Explicitly protect untracked/ignored paths: read-tree can overwrite
      // them on an unborn branch (its initial-checkout special case).
      const others = (await g(['ls-files', '--others', '-z'])).split('\0').filter(Boolean)
      const targets = (await g(['ls-tree', '-r', '--name-only', '-z', target])).split('\0').filter(Boolean)
      const targetSet = new Set(targets)
      const targetDirs = new Set<string>()
      for (const file of targets) {
        const parts = file.split('/')
        while (parts.length > 1) { parts.pop(); targetDirs.add(parts.join('/')) }
      }
      for (const file of others) {
        const parts = file.split('/')
        let collision = targetDirs.has(file) || targetSet.has(file)
        while (parts.length > 1) { parts.pop(); collision ||= targetSet.has(parts.join('/')) }
        if (collision) throw new Error(`Restore would overwrite an ignored or new untracked file: ${file}`)
      }
      // Two-tree merge refuses local changes and ignored-file collisions.
      // Unlike reset --hard, it also works with an unborn HEAD.
      await g(['read-tree', '-m', '-u', current, target])
    }))
  }

  async prune(session: string, from?: number): Promise<void> {
    await serialized(this.dir, async () => {
      const prefix = checkpointRef(session, '')
      const refs = (await git(this.dir, this.access, ['for-each-ref', '--format=%(refname)', prefix]))
        .trim().split('\n').filter(Boolean)
      const safety = refs.filter((r) => r.slice(prefix.length).startsWith('pre-rewind-')).sort().reverse()
      for (const ref of refs) {
        const key = ref.slice(prefix.length)
        if (from === undefined || (/^\d+$/.test(key) && Number(key) >= from) || safety.indexOf(ref) >= 10)
          await git(this.dir, this.access, ['update-ref', '-d', ref])
      }
    })
  }
}

export async function sessionCheckpoints(info: SessionInfo, allRepos = false): Promise<Checkpoints[]> {
  return Promise.all((allRepos ? info.repos : writeRepos(info)).map(async (repo) => new Checkpoints(
    cloneDir(info.workspace, info.task, repo), await hostGitAccessForRepo(info.workspace, repo))))
}
