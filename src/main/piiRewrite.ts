// The host's rewrite endpoint for a masking session's MCP traffic
// (docs/requirements-pii-mask.md §9.2).
//
// Every MCP descriptor the agent holds is a URL on the session's proxy, so the
// proxy is the one place MCP requests and responses can be rewritten — and it
// is a stock-alpine container that holds neither the table nor a detector. It
// asks the host instead: `POST <url>/reveal` for text on its way *to* an MCP
// server, `POST <url>/encode` for text on its way back to the agent. The host
// stays the single owner of the table and the detectors.
//
// The URL carries a token minted per session and written only into the proxy's
// own scope file. The agent can route to this port (it is `host.docker.internal`
// like the MCP listeners) but cannot call it: without the token every path is a
// 404, and `reveal` is exactly an oracle for what a token stands for.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createLogger } from './log'
import type { PiiMask } from './pii'

const log = createLogger('pii')

/** One request carries one MCP message's strings — small; this bounds a bug. */
const MAX_BODY = 32 * 1024 * 1024
/** Strings encoded at once: a detector may be a network call. */
const CONCURRENCY = 8

interface Entry {
  token: Buffer
  mask: PiiMask
}

const sessions = new Map<string, Entry>()
let listening: Promise<number> | undefined
let server: Server | undefined

const bearer = (token: Buffer): string => token.toString('base64url')

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (d: Buffer) => {
      size += d.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(d)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Encode every string, a few at a time, one detector call per distinct value. */
async function encodeAll(entry: Entry, sessionId: string, strings: string[]): Promise<string[]> {
  const distinct = [...new Set(strings)]
  const done = new Map<string, string>()
  let next = 0
  const worker = async (): Promise<void> => {
    for (let i = next++; i < distinct.length; i = next++) {
      const s = distinct[i]!
      done.set(s, s.length < 3 ? s : await entry.mask.encode(sessionId, s))
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, distinct.length) }, worker))
  return strings.map((s) => done.get(s) ?? s)
}

function findSession(token: string): [string, Entry] | undefined {
  const given = Buffer.from(token)
  for (const [id, entry] of sessions) {
    const want = Buffer.from(bearer(entry.token))
    if (given.length === want.length && timingSafeEqual(given, want)) return [id, entry]
  }
  return undefined
}

function start(): Promise<number> {
  server = createServer((req, res) => {
    void (async () => {
      const m = /^\/pii\/([A-Za-z0-9_-]+)\/(reveal|encode)$/.exec(req.url ?? '')
      const found = m && req.method === 'POST' ? findSession(m[1]!) : undefined
      if (!m || !found) {
        res.writeHead(404).end()
        return
      }
      const [sessionId, entry] = found
      try {
        const body = JSON.parse(await readBody(req)) as { strings?: unknown }
        if (!Array.isArray(body.strings) || body.strings.some((s) => typeof s !== 'string'))
          throw new Error('strings must be an array of strings')
        const input = body.strings as string[]
        const strings =
          m[2] === 'reveal'
            ? input.map((s) => entry.mask.decode(sessionId, s))
            : await encodeAll(entry, sessionId, input)
        const out = JSON.stringify({ strings })
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) })
        res.end(out)
      } catch (e) {
        // Fail closed on the proxy's side too: an encode that failed (detector
        // down) must be an error the proxy reports, never a pass-through.
        log.warn('pii.rewrite-failed', { s: sessionId, op: m[2], err: e })
        if (!res.headersSent) res.writeHead(500).end()
      }
    })()
  })
  return new Promise((resolve, reject) => {
    server!.once('error', reject)
    // 0.0.0.0, like the MCP listeners: the proxy container reaches it through
    // host.docker.internal.
    server!.listen(0, '0.0.0.0', () => {
      server!.removeListener('error', reject)
      server!.on('error', (e) => log.error('internal.fail', { site: 'pii-rewrite', err: e }))
      resolve((server!.address() as AddressInfo).port)
    })
  })
}

/**
 * Register a masking session and return the URL its proxy rewrites through
 * (`<url>/reveal`, `<url>/encode`). Idempotent: a re-attach keeps the token the
 * running proxy already has.
 */
export async function servePiiRewrite(sessionId: string, mask: PiiMask): Promise<string> {
  let entry = sessions.get(sessionId)
  if (!entry) {
    entry = { token: randomBytes(32), mask }
    sessions.set(sessionId, entry)
  } else entry.mask = mask
  listening ??= start().catch((e: unknown) => {
    listening = undefined
    throw e
  })
  const port = await listening
  return `http://host.docker.internal:${port}/pii/${bearer(entry.token)}`
}

/** The session is gone (or stopped masking): its token stops working. */
export function stopPiiRewrite(sessionId: string): void {
  sessions.delete(sessionId)
  if (sessions.size === 0 && server) {
    server.close()
    server.closeAllConnections()
    server = undefined
    listening = undefined
  }
}
