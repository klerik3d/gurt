// Host credential broker (§8): one loopback-only, process-lifetime HTTP
// service answering the *host* git credential helper (`shims.ts`'s
// HOST_CRED_HELPER, wired from `env.ts`). Every authenticated git operation
// gurt performs runs through it — which, since the container broker was
// removed, means every authenticated git operation gurt performs at all: the
// github MCP tools (`mcp/githubServer.ts` — git_pull, git_push,
// create_pull_request) are the only authenticated git path there is.
//
// Bound to 127.0.0.1, never 0.0.0.0: this listener is not container-reachable,
// and nothing in a session container knows it exists. The resolved credential
// id + host ride in request headers, set by env.ts from a save-time
// resolution the helper cannot forge its way around (it never sees the id for
// any host but the one it was handed).
//
// Never logs secrets — not the token, not the request, not the URL (which
// carries the broker's bearer token in its path). The port is the only part of
// it that may be logged.
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'
import type { CredentialEntry } from '../../shared/credentials'
import { credentialIdentity, DEFAULT_TOKEN_USER } from '../../shared/credentials'
import { canonicalRepoId } from '../../shared/repoId'
import { listCredentials } from '../credentials'
import { createLogger } from '../log'

const log = createLogger('hostcredbroker')

function listen(server: Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      // The startup reject has done its job; a *runtime* server error after this
      // would otherwise call a settled promise's reject and vanish.
      server.removeListener('error', reject)
      server.on('error', (e) => log.error('internal.fail', { site: 'hostcredbroker-server', err: e }))
      resolve((server.address() as AddressInfo).port)
    })
  })
}

/** A credential fill is a handful of `key=value` lines — anything bigger, or a
 *  client that never ends its body, is a bad client, and a handler must not be
 *  holdable open. */
const BODY_MAX_BYTES = 64 * 1024
const BODY_TIMEOUT_MS = 10_000

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    const timer = setTimeout(() => req.destroy(), BODY_TIMEOUT_MS)
    timer.unref?.()
    const done = (): void => {
      clearTimeout(timer)
      resolve(body)
    }
    req.on('data', (d) => {
      body += d
      if (body.length > BODY_MAX_BYTES) req.destroy()
    })
    req.on('end', done)
    req.on('error', done)
    // `destroy()` may surface as 'close' without 'error'; resolving twice is a no-op.
    req.on('close', done)
  })
}

/**
 * The only two fields of git's credential protocol this broker answers on.
 * A plain object, not an index signature: everything else git may send in a
 * fill — `path`, `wwwauth[]`, and the `username`/`password` of a store/erase —
 * is dropped at the parse below instead of travelling any further into the
 * process. Nothing parsed here is ever logged.
 */
const CREDENTIAL_FIELDS = z.object({
  protocol: z.string().optional(),
  host: z.string().optional()
})

/** Parse git credential fill lines (`key=value`) into the fields we serve. */
function parseFields(body: string): z.infer<typeof CREDENTIAL_FIELDS> {
  const out: Record<string, string> = {}
  for (const line of body.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return CREDENTIAL_FIELDS.parse(out)
}

/** The in-flight (or completed) startup, not the result — two concurrent first
 *  callers must share one server, so the cache is set before the first await. */
let hostBroker: Promise<{ url: string }> | null = null

/** Whether an entry's own `hosts` cover `host`. Entries are read the way §3.2's
 *  verification lookup reads them — canonicalized, bare hosts passing through —
 *  so a `hosts` field holding a full repo URL still scopes what it names. */
function coversHost(entry: CredentialEntry, host: string): boolean {
  const want = host.trim().toLowerCase()
  return entry.hosts.some((raw) => (canonicalRepoId(raw)?.host ?? raw.trim().toLowerCase()) === want)
}

/** POST /host/<token>/credential — answer the host helper's git credential
 *  fill for https/http only, scoped to the header-carried entry id + host. */
async function handleHostCredential(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const fields = parseFields(await readBody(req))
  if (fields.protocol !== 'https' && fields.protocol !== 'http') {
    res.writeHead(204).end()
    return
  }
  const credId = req.headers['x-gurt-cred-id']
  const credHost = req.headers['x-gurt-cred-host']
  if (typeof credId !== 'string' || typeof credHost !== 'string' || fields.host !== credHost) {
    res.writeHead(204).end()
    return
  }
  const entry = (await listCredentials()).find((c) => c.id === credId)
  // The two gates `resolveCredential` applies, re-checked here against the
  // entry itself: §3.2 — a git-token with no stamped identity is an errored
  // resolution and serves nothing — and the §8 scoping rule, that a managed
  // helper is answered only for a host this entry covers. The headers attest a
  // save-time resolution (env.ts), but the broker does not take that
  // attestation as the only thing standing between a caller and a secret.
  if (
    !entry ||
    entry.kind !== 'git-token' ||
    !entry.data['secret'] ||
    !credentialIdentity(entry) ||
    !coversHost(entry, credHost)
  ) {
    res.writeHead(204).end()
    return
  }
  const user = entry.data['username'] || DEFAULT_TOKEN_USER
  const payload = `username=${user}\npassword=${entry.data['secret']}\n`
  res.writeHead(200, { 'content-type': 'text/plain' }).end(payload)
}

function buildHostServer(token: string): Server {
  const prefix = `/host/${token}`
  // The listener itself is sync: node ignores whatever a request handler
  // returns, so an async one would drop a rejection on the floor. Everything
  // below already answers inside the try, and `void` is the explicit hand-off.
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = req.url ?? ''
      if (!url.startsWith(prefix)) {
        res.writeHead(404).end()
        return
      }
      const sub = url.slice(prefix.length)
      if (sub === '/credential' && req.method === 'POST') return await handleHostCredential(req, res)
      res.writeHead(404).end()
    } catch (e) {
      // The error only — never the request itself (headers/fields/payload carry
      // a credential id and, on success, a secret).
      log.error('internal.fail', { site: 'hostcredbroker-request', err: e })
      if (!res.headersSent) res.writeHead(500).end()
    }
  }
  return createServer((req, res) => void handle(req, res))
}

/** Ensure the host-local credential broker is running and return its URL.
 *  Lazy: started on first use, lives until the app exits (no per-session
 *  teardown — it serves every host git call gurt makes). */
export function ensureHostCredBroker(): Promise<{ url: string }> {
  if (!hostBroker) {
    hostBroker = (async () => {
      const token = randomUUID()
      const http = buildHostServer(token)
      const port = await listen(http, '127.0.0.1')
      log.info('hostcredbroker.start', { port })
      return { url: `http://127.0.0.1:${port}/host/${token}` }
    })().catch((e: unknown) => {
      hostBroker = null // a failed start must not poison every later call
      throw e
    })
  }
  return hostBroker
}
