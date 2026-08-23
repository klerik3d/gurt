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
  id: string
  mode: McpMode
  http: Server
  /** Resolves to the ACP descriptor once the server is listening. */
  ready: Promise<AcpHttpMcpServer>
  /** Set once `ready` resolves — the stop log needs the port without the
   *  descriptor's URL, which carries the session's bearer token. */
  port?: number
}

/** One host MCP server per (session, mcp id). Servers operate on the session's
 *  clone, and are torn down with the session's container. */
const running = new Map<string, Running>()

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    // 0.0.0.0 (not loopback) so the container can reach it via host.docker.internal.
    server.listen(0, '0.0.0.0', () => {
      // The startup reject is done its job; a *runtime* server error after this
      // would otherwise call a settled promise's reject and vanish.
      server.removeListener('error', reject)
      server.on('error', (e) => log.error('internal.fail', { site: 'mcp-server', err: e }))
      resolve((server.address() as AddressInfo).port)
    })
  })
}

/** Build and start one server. The record is complete before any await, so the
 *  caller can enter it into `running` ahead of the listen — two concurrent
 *  resolves for one key must share one server, not race a second into a leak. */
function startServer(
  sessionId: string,
  ref: EnvRef,
  repo: string,
  id: string,
  mode: McpMode
): Running {
  const dir = cloneDir(ref.workspace, ref.task, repo)
  const token = randomUUID()
  // Only github is implemented; the registry is the extension point for more.
  const http = buildGithubHttpServer(ref, repo, dir, mode, token)
  const rec = { id, mode, http } as Running
  rec.ready = listen(http).then((port): AcpHttpMcpServer => {
    rec.port = port
    log.info('mcp.start', { id, s: sessionId, mode, port })
    return {
      type: 'http',
      name: id,
      // host.docker.internal resolves to the host from Docker Desktop containers.
      url: `http://host.docker.internal:${port}/mcp/${token}`,
      headers: []
    }
  })
  return rec
}

function stopServer(sessionId: string, key: string, rec: Running): void {
  rec.http.close()
  // `close()` only stops new connections — a keep-alive socket would keep the
  // listener alive past the session it served.
  rec.http.closeAllConnections()
  log.info('mcp.stop', { id: rec.id, s: sessionId, mode: rec.mode, port: rec.port })
  running.delete(key)
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
      stopServer(sessionId, key, rec)
      rec = undefined
    }
    if (!rec) {
      const started = startServer(sessionId, ref, repo, sel.id, sel.mode)
      rec = started
      running.set(key, started)
      // A failed listen must not poison the key for every later resolve.
      started.ready.catch(() => {
        if (running.get(key) === started) running.delete(key)
      })
    }
    out.push(await rec.ready)
  }
  return out
}

/** Tear down every host MCP server of a session (its container is going away). */
export function stopMcpServers(sessionId: string): void {
  const prefix = `${sessionId}::`
  for (const [key, rec] of running) {
    if (!key.startsWith(prefix)) continue
    stopServer(sessionId, key, rec)
  }
}
