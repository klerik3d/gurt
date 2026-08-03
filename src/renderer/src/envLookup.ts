import type { EnvState, SessionInfo, Tree } from '../../shared/types'

/** Find a session's env instance in the tree (undefined before its first `up`). */
export function findEnvState(tree: Tree | null | undefined, info: SessionInfo): EnvState | undefined {
  return tree?.workspaces
    .find((w) => w.name === info.workspace)
    ?.tasks.find((t) => t.name === info.task)
    ?.envs.find((e) => e.env === info.env)
}
