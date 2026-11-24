// `CheckPort` (t3v2 §4.2, §7) over the existing CheckRunner: the repo's check
// command in the executor's container, login shell, /workspaces/<repo>, tail
// ring 60 lines / 8 KB, 20-minute timeout. Killing a check is stopping the
// executor's container, confirmed by an inspect (CheckRunner does both).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { CheckPort } from '../../rpm/main'
import type { CheckRun } from '../../rpm/core'
import { CheckRunner, type CheckResult } from '../reviewCheck'
import type { ContainerManager } from '../containers'
import type { SessionManager } from '../sessions'
import { wsDir } from '../store'
import type { RepoConfig } from '../../shared/types'

/** A workspace's repos as configured now. Synchronous because `commands` is. */
export type ReposOf = (ws: string) => Pick<RepoConfig, 'name' | 'check'>[]

/** workspace.json read as `getWorkspace` reads it, minus everything but the repos. */
export const readReposSync: ReposOf = (ws) => {
  try {
    const raw = JSON.parse(readFileSync(path.join(wsDir(ws), 'workspace.json'), 'utf8')) as { repos?: unknown }
    return Array.isArray(raw.repos) ? (raw.repos as Pick<RepoConfig, 'name' | 'check'>[]) : []
  } catch {
    return []
  }
}

const toRun = (r: CheckResult): CheckRun => ({
  repo: r.repo,
  command: r.command,
  code: r.code,
  ms: r.ms,
  tail: r.tail,
  ...(r.timedOut ? { timedOut: true } : {})
})

/**
 * `done` resolves with the run when the shell exited by itself, timed out
 * (`timedOut`, code -1; the container was stopped and confirmed) or was stopped
 * through `stop()` (code -1). It REJECTS when the check could not run (the
 * container would not come up, exec failed) or a stop could not be confirmed —
 * the engine writes `fail check-error` for that (t3v2 §7).
 */
export function createCheckPort(
  containers: Pick<ContainerManager, 'spawnExec' | 'stop' | 'isRunning' | 'status'>,
  sessions: Pick<SessionManager, 'ensureContainerUp'>,
  reposOf: ReposOf = readReposSync
): CheckPort {
  const runners = new Map<string, CheckRunner>()
  let seq = 0
  const runnerOf = (id: string): CheckRunner => {
    let r = runners.get(id)
    if (!r) {
      r = new CheckRunner({
        exec: (argv, cwd) => containers.spawnExec(id, argv, cwd),
        ensureContainerUp: async () => {
          if (containers.status(id) !== 'running') await sessions.ensureContainerUp(id)
        },
        stopContainer: () => containers.stop(id, 'idle', true),
        containerRunning: () => containers.isRunning(id)
      })
      // TODO(rpm): runners of deleted executors stay in the map until restart.
      runners.set(id, r)
    }
    return r
  }

  return {
    run(executor, repo, command) {
      const runner = runnerOf(executor)
      const intent = `rpm.${++seq}`
      const done = runner.run({ intent, repo, command }).then((run): CheckRun => {
        switch (run.status) {
          case 'finished':
          case 'stopped':
            return toRun(run.result)
          case 'unconfirmed':
            throw new Error(run.detail)
          case 'failed-to-run':
            throw new Error(run.error)
        }
      })
      return {
        done,
        stop: async () => {
          const s = await runner.cancel(intent)
          return s.ok ? { ok: true } : { ok: false, detail: s.detail }
        }
      }
    },

    commands(ws, repos) {
      const config = reposOf(ws)
      const out: { repo: string; command: string }[] = []
      for (const repo of repos) {
        const command = config.find((r) => r.name === repo)?.check
        if (typeof command === 'string' && command.trim()) out.push({ repo, command: command.trim() })
      }
      return out
    }
  }
}
