// `StorePort` (t3v2 §4.2, §8.1): RPM's directory inside the scope's own dir, so
// a rename or an archive of the scope carries it along. `rpm` is a reserved
// repo name (store.ts RESERVED_NAMES) — a repo clone can never take the path.
import path from 'node:path'
import type { StorePort } from '../../rpm/main'
import { taskDir } from '../store'

export function createStorePort(): StorePort {
  return { dir: (ws, task) => path.join(taskDir(ws, task), 'rpm') }
}
