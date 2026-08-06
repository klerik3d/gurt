import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { AcpHttpMcpServer, EnvRef, McpMode, McpSelection } from '../../shared/types'
import { mcpDef } from '../../shared/mcp'
import { mcpServerKey } from '../../shared/keys'
import { cloneDir } from '../store'
import { createLogger } from '../log'
import { buildGithubHttpServer } from './githubServer'

const log = createLogger('mcp')

interface Running {
  mode: McpMode
  port: number
  http: Server
  descriptor: AcpHttpMcpServer
}

/** One host MCP server per (session, mcp id). Servers operate on the session's
 *  clone, and are torn down with the session's container. */
const running = new Map<string, Running>()

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    // 0.0.0.0 (not loopback) so the container can reach it via host.docker.internal.
    server.listen(0, '0.0.0.0', () => resolve((server.address() as AddressInfo).port))
    server.on('error', reject)
  })
}

async function startServer(
  sessionId: string,
  ref: EnvRef,
  repo: string,
  id: string,
  mode: McpMode
): Promise<Running> {
  const dir = cloneDir(ref.workspace, ref.task, repo)
  const token = randomUUID()
  // Only github is implemented; the registry is the extension point for more.
  const http = buildGithubHttpServer(ref, repo, dir, mode, token)
  const port = await listen(http)
  log.info('mcp.start', { id, s: sessionId, mode, port })
  return {
    mode,
    port,
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
 * Ensure the host MCP servers for `selection` are running for this session and
 * return their ACP descriptors. Restarts a server whose granted mode changed.
 */
export async function resolveMcpServers(
  ref: EnvRef,
  sessionId: string,
  repo: string | undefined,
  selection: McpSelection[] | undefined
): Promise<AcpHttpMcpServer[]> {
  if (!selection?.length) return []
  // The servers operate on the session's clone; without a repo there is none.
  if (!repo) return []
  const out: AcpHttpMcpServer[] = []
  for (const sel of selection) {
    if (!mcpDef(sel.id)) continue
    const key = mcpServerKey(sessionId, sel.id)
    let rec = running.get(key)
    if (rec && rec.mode !== sel.mode) {
      rec.http.close()
      log.info('mcp.stop', { id: sel.id, s: sessionId, mode: rec.mode, port: rec.port })
      running.delete(key)
      rec = undefined
    }
    if (!rec) {
      rec = await startServer(sessionId, ref, repo, sel.id, sel.mode)
      running.set(key, rec)
    }
    out.push(rec.descriptor)
  }
  return out
}

/** Tear down every host MCP server of a session (its container is going away). */
export function stopMcpServers(sessionId: string): void {
  const prefix = `${sessionId}::`
  for (const [key, rec] of running) {
    if (!key.startsWith(prefix)) continue
    rec.http.close()
    log.info('mcp.stop', { id: rec.descriptor.name, s: sessionId, mode: rec.mode, port: rec.port })
    running.delete(key)
  }
}
