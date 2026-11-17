import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { createLogger } from '../log'

const log = createLogger('mcp')

/**
 * An http.Server exposing an MCP server at `/mcp/<token>`. Stateless: a fresh
 * MCP server (from `makeServer`) + transport per POST, so no per-session
 * bookkeeping. The token guards the endpoint, which binds a container-reachable
 * interface. `id` names the endpoint in the handler's failure log.
 */
export function buildStatelessMcpHttpServer(
  token: string,
  id: string,
  makeServer: () => McpServer
): Server {
  const prefix = `/mcp/${token}`
  // Sync listener, async handler: node discards a request handler's return
  // value, so an async listener would drop a rejection instead of reporting it.
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!req.url || !req.url.startsWith(prefix)) {
      res.writeHead(404).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    try {
      const server = makeServer()
      // No `sessionIdGenerator` = stateless, which is what a fresh server per
      // POST wants (the SDK reads an absent generator exactly that way).
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
      // The SDK's transport class does not satisfy its own `Transport`
      // interface under exactOptionalPropertyTypes — it declares `onclose?:
      // () => void`, which reads back as `(() => void) | undefined`. The two
      // types are otherwise identical; this is the flag's cost at a
      // third-party boundary, not a widening of ours.
      await server.connect(transport as Transport)
      // Registered only after connect: a client aborting mid-connect would
      // otherwise close the transport under `handleRequest`'s feet. The close
      // promises are caught — a rejection here has nowhere better to go than
      // the log, never the global unhandled-rejection hook.
      res.on('close', () => {
        transport.close().catch(() => {})
        server.close().catch(() => {})
      })
      await transport.handleRequest(req, res)
    } catch (e) {
      log.error('internal.fail', { site: 'mcp-handler', id, err: e })
      if (!res.headersSent) res.writeHead(500).end()
    }
  }
  return createServer((req, res) => void handle(req, res))
}
