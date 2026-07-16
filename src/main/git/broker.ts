// Host git broker: one HTTP service per running env, following mcp/manager.ts —
// bind 0.0.0.0 (container-reachable via host.docker.internal), a random UUID
// token in the path, started with the env and stopped with it. Resolves
// credentials per request (§3.1, §4). Never logs secrets.
//
// The ssh-agent TCP bridge (§4.2) is phase 2 and not implemented here yet; the
// per-env, single-service shape leaves room for it on the same listener.
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { EnvRef, RepoConfig } from '../../shared/types'
import { resolveCredential } from '../../shared/credentials'
import { DEFAULT_TOKEN_USER } from '../../shared/credentials'
import { canonicalRepoId } from '../../shared/repoId'
import { envKey } from '../../shared/keys'
import { getWorkspace } from '../store'
import { listCredentials } from '../credentials'
import { providerForHost } from './providers'

interface Running {
  http: Server
  descriptor: { url: string }
}

/** One broker per env, reused across the env's sessions. */
const running = new Map<string, Running>()

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '0.0.0.0', () => resolve((server.address() as AddressInfo).port))
    server.on('error', reject)
  })
}

async function envRepo(ref: EnvRef): Promise<RepoConfig | undefined> {
  return (await getWorkspace(ref.workspace)).repos.find((r) => r.name === ref.repo)
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
async function handleCredential(ref: EnvRef, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const fields = parseFields(await readBody(req))
  const protocol = fields.protocol
  if ((protocol !== 'https' && protocol !== 'http') || !fields.host) {
    res.writeHead(204).end()
    return
  }
  const repo = await envRepo(ref)
  if (!repo) {
    res.writeHead(204).end()
    return
  }
  const resolved = resolveCredential(await listCredentials(), repo, fields.host)
  if (resolved.entry?.kind === 'git-token' && resolved.entry.data.secret) {
    const user = resolved.entry.data.username || DEFAULT_TOKEN_USER
    const payload = `username=${user}\npassword=${resolved.entry.data.secret}\n`
    res.writeHead(200, { 'content-type': 'text/plain' }).end(payload)
    return
  }
  // git-host / unimplemented kinds / no match → git falls through and fails cleanly.
  res.writeHead(204).end()
}

/** GET /forge-env — the forge CLI env map from the env repo's provider. */
async function handleForgeEnv(ref: EnvRef, res: ServerResponse): Promise<void> {
  const repo = await envRepo(ref)
  const host = repo ? canonicalRepoId(repo.url)?.host : undefined
  if (!repo || !host) {
    res.writeHead(204).end()
    return
  }
  const provider = providerForHost(host)
  if (!provider) {
    res.writeHead(204).end()
    return
  }
  const resolved = resolveCredential(await listCredentials(), repo, host)
  const env = resolved.entry ? await provider.forgeEnv(resolved.entry, host) : null
  if (!env) {
    res.writeHead(204).end()
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(env))
}

function buildServer(ref: EnvRef, token: string): Server {
  const prefix = `/git/${token}`
  return createServer(async (req, res) => {
    try {
      const url = req.url ?? ''
      if (!url.startsWith(prefix)) {
        res.writeHead(404).end()
        return
      }
      const sub = url.slice(prefix.length)
      if (sub === '/credential' && req.method === 'POST') return await handleCredential(ref, req, res)
      if (sub === '/forge-env' && req.method === 'GET') return await handleForgeEnv(ref, res)
      res.writeHead(404).end()
    } catch (e) {
      console.error('[git broker]', e)
      if (!res.headersSent) res.writeHead(500).end()
    }
  })
}

/** Ensure the env's broker is running and return its container-reachable URL. */
export async function resolveGitBroker(ref: EnvRef): Promise<{ url: string }> {
  const key = envKey(ref)
  const existing = running.get(key)
  if (existing) return existing.descriptor
  const token = randomUUID()
  const http = buildServer(ref, token)
  const port = await listen(http)
  const descriptor = { url: `http://host.docker.internal:${port}/git/${token}` }
  running.set(key, { http, descriptor })
  return descriptor
}

/** Tear down an env's broker (env stop/delete). */
export function stopGitBroker(ref: EnvRef): void {
  const key = envKey(ref)
  const rec = running.get(key)
  if (!rec) return
  rec.http.close()
  running.delete(key)
}
