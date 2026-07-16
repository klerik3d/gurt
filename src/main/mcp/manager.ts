import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { AcpHttpMcpServer, EnvRef, McpMode, McpSelection } from '../../shared/types'
import { mcpDef } from '../../shared/mcp'
import { envKey, mcpServerKey } from '../../shared/keys'
import { cloneDir } from '../store'
import { buildGithubHttpServer } from './githubServer'

interface Running {
  mode: McpMode
  http: Server
  descriptor: AcpHttpMcpServer
}

/** One host MCP server per (env, mcp id), reused across the env's sessions. */
const running = new Map<string, Running>()

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    // 0.0.0.0 (not loopback) so the container can reach it via host.docker.internal.
    server.listen(0, '0.0.0.0', () => resolve((server.address() as AddressInfo).port))
    server.on('error', reject)
  })
}

async function startServer(ref: EnvRef, id: string, mode: McpMode): Promise<Running> {
  const dir = cloneDir(ref.workspace, ref.task, ref.repo)
  const token = randomUUID()
  // Only github is implemented; the registry is the extension point for more.
  const http = buildGithubHttpServer(dir, mode, token)
  const port = await listen(http)
  return {
    mode,
    http,
    descriptor: {
      type: 'http',
      name: id,
      // host.docker.internal resolves to the host from Docker Desktop containers.
      url: `http://host.docker.internal:${port}/mcp/${token}`,
      headers: []
    }
  }
}

/**
 * Ensure the host MCP servers for `selection` are running for this env and return
 * their ACP descriptors. Restarts a server whose granted mode changed.
 */
export async function resolveMcpServers(
  ref: EnvRef,
  selection: McpSelection[] | undefined
): Promise<AcpHttpMcpServer[]> {
  const out: AcpHttpMcpServer[] = []
  for (const sel of selection ?? []) {
    if (!mcpDef(sel.id)) continue
    const key = mcpServerKey(ref, sel.id)
    let rec = running.get(key)
    if (rec && rec.mode !== sel.mode) {
      rec.http.close()
      running.delete(key)
      rec = undefined
    }
    if (!rec) {
      rec = await startServer(ref, sel.id, sel.mode)
      running.set(key, rec)
    }
    out.push(rec.descriptor)
  }
  return out
}

/** Tear down every host MCP server of an env (env stop/delete). */
export function stopMcpServers(ref: EnvRef): void {
  const prefix = `${envKey(ref)}::`
  for (const [key, rec] of running) {
    if (!key.startsWith(prefix)) continue
    rec.http.close()
    running.delete(key)
  }
}
