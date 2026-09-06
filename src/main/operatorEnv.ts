// The bundled default operator environment
// (docs/requirements-session-operator.md §2.2). It is code, not user data —
// the `MCP_DEFS` precedent: it ships beside the app under `resources/env/`,
// next to `resources/proxy/gurt-proxy.mjs`, and resolves through the same
// dev-vs-packaged path split. Its name (`OPERATOR_ENV_NAME`) is reserved in
// the store validator because it shares the env name space with workspace
// envs; an operator pointed at a workspace env instead (`operatorEnv`) is an
// ordinary session on an ordinary env.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EnvConfig } from '../shared/types'
import { OPERATOR_ENV_NAME } from '../shared/types'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

/**
 * Host path of the bundled env's devcontainer.json, following
 * `proxyScriptPath()`'s dev-vs-packaged split: in a packaged build the app
 * lives inside app.asar, which only Electron's own fs can read — the path is
 * redirected to the unpacked mirror (`asarUnpack` in electron-builder.yml
 * already carries `resources/**`).
 *
 * `GURT_OPERATOR_ENV` overrides it — how the headless tests point a bundled
 * module (whose `import.meta.url` is a temp file) at a config they control,
 * the same seam `GURT_PROXY_SCRIPT` gives the proxy.
 */
export function operatorEnvPath(): string {
  const override = process.env['GURT_OPERATOR_ENV']
  if (override) return override
  return path
    .join(moduleDir, '..', '..', 'resources', 'env', 'devcontainer.json')
    .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
}

/** The bundled default env as an `EnvConfig` — image-only by construction
 *  (§2.2), read fresh so a packaged update's new pin is picked up without
 *  cache invalidation to get wrong. */
export async function bundledOperatorEnv(): Promise<EnvConfig> {
  return {
    name: OPERATOR_ENV_NAME,
    devcontainer: await fs.readFile(operatorEnvPath(), 'utf8')
  }
}
