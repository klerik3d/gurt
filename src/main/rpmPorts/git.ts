// `GitPort` (t3v2 §4.2). Why git here never reads the clone's own .git
// metadata: docs/requirements-git-access.md §12.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { GitPort } from '../../rpm/main'
import type { FileChange, RepoTree } from '../../rpm/core'
import { run } from '../provision'
import { cloneDir } from '../store'

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** HEAD's commit read from the clone's files, without running git on them:
 *  `.git/HEAD`, then the loose ref, then `packed-refs`. '' — unborn or unreadable.
 *  TODO(rpm): a reftable clone reads as unborn. */
async function readHead(gitDir: string): Promise<string> {
  const read = (f: string): Promise<string> => fs.readFile(path.join(gitDir, f), 'utf8').catch(() => '')
  const head = (await read('HEAD')).trim()
  if (SHA.test(head)) return head
  const ref = /^ref: (refs\/[^\s]+)$/.exec(head)?.[1]
  if (!ref || ref.split('/').includes('..')) return ''
  const loose = (await read(ref)).trim()
  if (SHA.test(loose)) return loose
  for (const line of (await read('packed-refs')).split('\n')) {
    const [sha, name] = line.trim().split(' ')
    if (name === ref && sha && SHA.test(sha)) return sha
  }
  return ''
}

type Git = (args: string[], okCodes?: number[]) => Promise<string>

/** Run `fn` with git bound to a throwaway git dir over the clone's work tree. */
async function isolated<T>(clone: string, fn: (g: Git, head: string) => Promise<T>): Promise<T> {
  const cloneGit = path.join(clone, '.git')
  // TODO(rpm): a `.git` file (linked worktree, submodule) is not followed.
  if (!(await fs.stat(cloneGit)).isDirectory()) throw new Error(`${clone}: .git is not a directory`)
  const head = await readHead(cloneGit)
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'gurt-rpm-git-'))
  try {
    const gitDir = path.join(scratch, 'git')
    const hooks = path.join(scratch, 'no-hooks')
    await fs.mkdir(hooks)
    const plain: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' }
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) plain[k] = v
    const env = { ...plain, GIT_DIR: gitDir, GIT_WORK_TREE: clone, GIT_INDEX_FILE: path.join(gitDir, 'index') }
    const g: Git = (args, okCodes) =>
      run('git', ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${hooks}`, ...args], () => {}, { cwd: clone, env, ...(okCodes ? { okCodes } : {}) })
    const format = head.length === 64 ? ['--object-format=sha256'] : []
    await run('git', ['init', '-q', '--bare', '--template=', ...format, gitDir], () => {}, { env: plain })
    await g(['config', 'core.bare', 'false'])
    await fs.mkdir(path.join(gitDir, 'info'), { recursive: true })
    await fs.writeFile(path.join(gitDir, 'objects', 'info', 'alternates'), path.join(cloneGit, 'objects') + '\n')
    await fs.copyFile(path.join(cloneGit, 'info', 'exclude'), path.join(gitDir, 'info', 'exclude')).catch(() => {})
    return await fn(g, head)
  } finally {
    await fs.rm(scratch, { recursive: true, force: true })
  }
}

/** HEAD and the working tree's tree id, as a commit (`add -A`) would record it. */
async function workTree(g: Git, head: string): Promise<{ head: string; tree: string }> {
  const commit = head ? (await g(['rev-parse', '--verify', '--quiet', `${head}^{commit}`], [0, 1])).trim() : ''
  await g(commit ? ['read-tree', commit] : ['read-tree', '--empty'])
  await g(['add', '-A'])
  return { head: commit, tree: (await g(['write-tree'])).trim() }
}

const status = (code: string): FileChange['status'] =>
  code === 'R' ? 'R' : code === 'A' || code === 'C' ? 'A' : code === 'D' ? 'D' : 'M'

/** `--name-status -z`: `X NUL path NUL`, or `Rnn NUL old NUL new NUL` for a rename. */
function parseNameStatus(out: string): FileChange[] {
  const parts = out.split('\0')
  const files: FileChange[] = []
  for (let i = 0; i < parts.length; ) {
    const code = parts[i]?.[0]
    if (!code) break
    const two = code === 'R' || code === 'C'
    const p = parts[two ? i + 2 : i + 1]
    if (p) files.push({ path: p, status: status(code) })
    i += two ? 3 : 2
  }
  return files
}

export function createGitPort(): GitPort {
  return {
    async trees(ws, task, repos): Promise<RepoTree[]> {
      const names = [...new Set(repos)].sort()
      return Promise.all(names.map(async (repo) => ({ repo, ...(await isolated(cloneDir(ws, task, repo), workTree)) })))
    },

    async diff(ws, task, repo, base, maxChars) {
      if (!/^[0-9a-f]{4,64}$/i.test(base)) throw new Error(`not a commit sha: "${base}"`)
      return isolated(cloneDir(ws, task, repo), async (g, head) => {
        const { tree } = await workTree(g, head)
        const opts = ['--no-ext-diff', '--no-textconv', '--no-color', '-M']
        const text = await g(['diff', ...opts, base, tree])
        const names = await g(['diff', ...opts, '--name-status', '-z', base, tree])
        // TODO(rpm): a huge diff is read whole before the cut; fine for now.
        const truncated = text.length > maxChars
        return { text: truncated ? text.slice(0, maxChars) : text, truncated, files: parseNameStatus(names) }
      })
    }
  }
}
