// The base image's virtual env: the one env that is not a workspace entry.
// It resolves to an image-only `EnvConfig` from the app-level setting
// (`store.getBaseImage`), read fresh so a changed setting applies to the next
// session start.
import type { EnvConfig } from '../shared/types'
import { BASE_ENV_NAME } from '../shared/types'
import { getBaseImage } from './store'

/** The env of this name, or undefined when the name is not a virtual one.
 *  Every place a session's env is resolved asks this after the workspace
 *  registry. */
export async function bundledEnv(name: string): Promise<EnvConfig | undefined> {
  if (name === BASE_ENV_NAME) return { name, image: await getBaseImage() }
  return undefined
}
