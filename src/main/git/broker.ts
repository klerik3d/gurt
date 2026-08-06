// Host git broker: one HTTP service per session, following mcp/manager.ts —
// bind 0.0.0.0 (container-reachable via host.docker.internal), a random UUID
// token in the path, started with the session's container and stopped with it.
// Resolves credentials per request (§3.1, §4). Never logs secrets.
//
// Keyed by session id because it serves exactly one container. The repo it
// serves is fixed when the broker is created — the session's repo is settled
// before its container is provisioned, so there is nothing to look up per
// request.
//
// The ssh-agent TCP bridge (§4.2) is phase 2 and not implemented here yet; the
// per-session, single-service shape leaves room for it on the same listener.
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { RepoConfig } from '../../shared/types'
import { resolveCredential } from '../../shared/credentials'
import { DEFAULT_TOKEN_USER } from '../../shared/credentials'
import { canonicalRepoId } from '../../shared/repoId'
import { listCredentials } from '../credentials'
import { createLogger } from '../log'
import { providerForHost } from './providers'

const log = createLogger('gitbroker')

interface Running {
  http: Server
  port: number
  descriptor: { url: string }
}

/** One broker per session, keyed by session id. */
const running = new Map<string, Running>()

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '0.0.0.0', () => resolve((server.address() as AddressInfo).port))
    server.on('error', reject)
  })
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => resolve(body))
    req.on('error', () => resolve(body))
  })
}

/** Parse git credential fill lines (`key=value`) into a map. */
function parseFields(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of body.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

/** POST /credential — answer git's credential fill for https/http only. */
async function handleCredential(
  repo: RepoConfig,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const fields = parseFields(await readBody(req))
  const protocol = fields.protocol
  if ((protocol !== 'https' && protocol !== 'http') || !fields.host) {
    res.writeHead(204).end()
    return
  }
  const resolved = resolveCredential(await listCredentials(), repo, fields.host)
  // An errored resolution (e.g. unverified entry, §3.2) serves nothing.
  if (!resolved.error && resolved.entry?.kind === 'git-token' && resolved.entry.data.secret) {
    const user = resolved.entry.data.username || DEFAULT_TOKEN_USER
    const payload = `username=${user}\npassword=${resolved.entry.data.secret}\n`
    res.writeHead(200, { 'content-type': 'text/plain' }).end(payload)
    return
  }
  // git-host / unimplemented kinds / no match → git falls through and fails cleanly.
  res.writeHead(204).end()
}

/** GET /forge-env — the forge CLI env map from the session repo's provider. */
async function handleForgeEnv(repo: RepoConfig, res: ServerResponse): Promise<void> {
  const host = canonicalRepoId(repo.url)?.host
  if (!host) {
    res.writeHead(204).end()
    return
  }
  const provider = providerForHost(host)
  if (!provider) {
    res.writeHead(204).end()
    return
  }
  const resolved = resolveCredential(await listCredentials(), repo, host)
  const env =
    resolved.entry && !resolved.error ? await provider.forgeEnv(resolved.entry, host) : null
  if (!env) {
    res.writeHead(204).end()
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(env))
}

function buildServer(repo: RepoConfig, token: string): Server {
  const prefix = `/git/${token}`
  return createServer(async (req, res) => {
    try {
      const url = req.url ?? ''
      if (!url.startsWith(prefix)) {
        res.writeHead(404).end()
        return
      }
      const sub = url.slice(prefix.length)
      if (sub === '/credential' && req.method === 'POST')
        return await handleCredential(repo, req, res)
      if (sub === '/forge-env' && req.method === 'GET') return await handleForgeEnv(repo, res)
      res.writeHead(404).end()
    } catch (e) {
      log.error('internal.fail', { site: 'gitbroker-request', err: e })
      if (!res.headersSent) res.writeHead(500).end()
    }
  })
}

/** Ensure the session's broker is running and return its container-reachable URL. */
export async function resolveGitBroker(
  sessionId: string,
  repo: RepoConfig
): Promise<{ url: string }> {
  const existing = running.get(sessionId)
  if (existing) return existing.descriptor
  const token = randomUUID()
  const http = buildServer(repo, token)
  const port = await listen(http)
  // The URL carries the broker's bearer token in its path — the port is the
  // only part of it that may be logged.
  log.info('gitbroker.start', { s: sessionId, port })
  const descriptor = { url: `http://host.docker.internal:${port}/git/${token}` }
  running.set(sessionId, { http, port, descriptor })
  return descriptor
}

/** Tear down a session's broker (its container is stopping or going away). */
export function stopGitBroker(sessionId: string): void {
  const rec = running.get(sessionId)
  if (!rec) return
  rec.http.close()
  log.info('gitbroker.stop', { s: sessionId, port: rec.port })
  running.delete(sessionId)
}
