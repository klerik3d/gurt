// The session proxy, driven for real over loopback (docs/requirements-mcp-proxy.md
// §4, §5): MCP routing with credential injection, the token guard, forward-proxy
// egress and CONNECT tunnelling under the allow list, and — the property the
// whole design rests on — a config reload that changes the scope *in place*,
// while the token the agent already holds keeps working.
//
// No docker, no electron, no bundling: `resources/proxy/gurt-proxy.mjs` is the
// dependency-free file the container mounts, so the test runs exactly it. Three
// fixtures stand in for the world: an upstream MCP server that answers a POST
// with an SSE stream, an origin HTTP server, and a TCP echo server behind
// CONNECT. Pure-function coverage (the matcher, the parsers) is
// proxy-policy.test.mjs.
//
// A fourth fixture is the *resolver* (`RESOLVES`), which is what makes the
// built-in denylist testable at all: the interesting cases are a benign name
// that answers with 169.254.169.254 and an entry that must connect anyway, and
// neither can be arranged with real DNS. Every fixture in this file listens on
// loopback, which the built-in denylist refuses — so the base scope allows
// 127.0.0.1 explicitly, exactly as a user would have to. That is rule 2, so the
// base scope is a *restricted* one; `openConfig()` is the rule-1 scope the
// built-in denylist tests need, and nothing on loopback is reachable under it.
//
//   node scripts/proxy-server.test.mjs
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import dns from 'node:dns'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createProxy } from '../resources/proxy/gurt-proxy.mjs'

const TOKEN = 'PROXY-SESSION-TOKEN-0123456789abcdef'
const UPSTREAM_SECRET = 'Bearer mcp-upstream-secret-a1b2c3'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-proxy-'))
const configPath = path.join(dir, 'proxy.json')

/** Every log record the proxy emitted, in order — the observability contract is
 *  asserted at the end, over the whole run. */
const records = []

/** Requests the upstream MCP server saw: what the proxy actually sent on. */
const upstreamSeen = []

// -- fixtures ---------------------------------------------------------------

/** Upstream MCP server. POST answers with SSE (streamable HTTP's shape), so a
 *  buffering proxy would show up as a hang rather than as a wrong byte. */
const upstream = http.createServer((req, res) => {
  upstreamSeen.push({ method: req.method, url: req.url, headers: req.headers })
  if (req.method === 'DELETE') {
    res.writeHead(204).end()
    return
  }
  if (req.method === 'POST') {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      upstreamSeen[upstreamSeen.length - 1].body = Buffer.concat(chunks).toString('utf8')
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'up-1' })
      res.write('event: message\ndata: {"first":true}\n\n')
      // Second event much later: if anything buffers, the client sees nothing
      // until this one lands.
      setTimeout(() => {
        res.write('event: message\ndata: {"second":true}\n\n')
        res.end()
      }, 150)
    })
    return
  }
  res.writeHead(200, { 'content-type': 'text/plain' }).end('upstream get')
})

/** A plain origin, for the forward-proxy (absolute-form) path. */
const origin = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' }).end(`origin ${req.url}`)
})

/** Something to tunnel to. Echoes, so the test can prove bytes cross both ways.
 *  On 0.0.0.0, not loopback: the private-range case reaches it on this machine's
 *  own RFC1918 address, which is the only genuinely private address a test can
 *  count on being routable. */
const echo = net.createServer((socket) => socket.pipe(socket))

/**
 * The names this proxy can resolve, and to what. Injected, because every
 * property the built-in denylist has is a property of the *address* a name
 * answers with — and the whole point is that the name says nothing about it.
 *
 * `host.docker.internal` is loopback here for the same reason it is the docker
 * host in a container: it is the machine the proxy is running on.
 */
const RESOLVES = new Map([
  ['host.docker.internal', ['127.0.0.1']],
  ['gateway.docker.internal', ['127.0.0.1']],
  // A name whose owner points it at the cloud metadata service. Nothing about
  // the label says so, which is the attack.
  ['metadata.rebind.test', ['169.254.169.254']],
  ['intranet.rebind.test', ['192.168.77.7']],
  // Benign-looking, and lands on this machine — the shape of "the user really
  // did mean this one", and of the rebind if they did not.
  ['pinned.rebind.test', ['127.0.0.1']]
])

/** This machine's own RFC1918 address, if it has one. A container has an eth0
 *  in 172.17/16 and a laptop a 10./192.168. one; a machine with neither cannot
 *  reach a private address at all, so the one test that needs to is skipped. */
const privateIpv4 = () =>
  Object.values(os.networkInterfaces())
    .flat()
    .find(
      (a) =>
        a &&
        a.family === 'IPv4' &&
        !a.internal &&
        /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)
    )?.address ?? null

const PRIVATE = privateIpv4()

const listen = (server, host = '127.0.0.1') =>
  new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)))

let upstreamPort
let originPort
let echoPort
let proxy
let proxyPort

/** Write the config the way the host does — temp file + rename, so the watcher
 *  can never read a half-written scope — then wait for the poll to pick it up. */
async function pushConfig(config) {
  const tmp = `${configPath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(config))
  fs.renameSync(tmp, configPath)
  await waitFor(() => scopeSummary(proxy.current()) === scopeSummary(config))
}

/** What a caller can compare across the file/parsed boundary: the ids, where
 *  they point, and the policy. */
const scopeSummary = (config) =>
  config &&
  JSON.stringify({
    mcp: Object.keys(config.mcp ?? {})
      .sort()
      .map((id) => `${id}=${config.mcp[id].url}`),
    policy: config.network?.policy ?? { allow: [] },
    internal: config.network?.internal === true
  })

async function waitFor(predicate, ms = 3000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('timed out waiting for the proxy to converge')
}

const baseConfig = (patch = {}) => ({
  version: 1,
  session: 's-proxy-test',
  token: TOKEN,
  mcp: {
    linear: {
      kind: 'registry',
      url: `http://127.0.0.1:${upstreamPort}/upstream/mcp`,
      headers: [
        { name: 'Authorization', value: UPSTREAM_SECRET },
        { name: 'X-Static', value: 'from-registry' }
      ]
    },
    github: { kind: 'host', url: `http://127.0.0.1:${upstreamPort}/host/mcp` }
  },
  // Every fixture in this file is on loopback, which the built-in denylist
  // refuses — so the base scope names 127.0.0.1, exactly as a user pointing a
  // session at a local service would have to. That one entry is rule 2: this
  // scope reaches 127.0.0.1 and nothing else at all.
  network: { internal: false, policy: { allow: ['127.0.0.1'] } },
  ...patch
})

/** The rule-1 scope: an empty allow list, i.e. the open internet minus the
 *  built-in denylist. Nothing in this file is reachable under it — which is the
 *  point, since every fixture is on a denied address. */
const openConfig = (patch = {}) => baseConfig({ network: { internal: false, policy: { allow: [] } }, ...patch })

// -- client helpers ---------------------------------------------------------

/**
 * One request to the proxy. `reqPath` is origin-form for MCP, absolute-form for
 * the forward-proxy path — exactly as it goes on the wire.
 *
 * @param {string} reqPath
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} [opts]
 */
function call(reqPath, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: proxyPort, method, path: reqPath, headers },
      (res) => {
        const chunks = []
        let firstChunkAt = 0
        res.on('data', (c) => {
          if (!firstChunkAt) firstChunkAt = Date.now()
          chunks.push(c)
        })
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            firstChunkAt,
            endedAt: Date.now()
          })
        )
      }
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

/** A CONNECT through the proxy: resolves `{ status, tunnel }` when established,
 *  or `{ status, body }` when the proxy refused before the tunnel existed.
 *
 *  Node hands a CONNECT reply to the `connect` listener whatever its status —
 *  llhttp cannot know a refusal from a tunnel — so the refusal body arrives as
 *  the head buffer plus whatever follows on the socket. */
function connect(authority) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: authority })
    const refusal = (status, head, socket) => {
      const chunks = head?.length ? [head] : []
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve({ status, body: Buffer.concat(chunks).toString('utf8') })
      }
      socket.on('data', (c) => chunks.push(c))
      socket.on('end', done)
      socket.on('close', done)
    }
    req.on('connect', (res, socket, head) => {
      if (res.statusCode === 200) resolve({ status: 200, tunnel: socket })
      else refusal(res.statusCode, head, socket)
    })
    req.on('response', (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

before(async () => {
  upstreamPort = await listen(upstream)
  originPort = await listen(origin)
  echoPort = await listen(echo, '0.0.0.0')
  proxy = createProxy({
    configPath,
    log: (rec) => records.push(rec),
    // The real poll is a second; the test wants the same mechanism, faster.
    watchMs: 20,
    // The proxy's only resolver: what it vets is what it dials.
    resolve: async (hostname) =>
      RESOLVES.get(String(hostname).toLowerCase()) ??
      (await dns.promises.lookup(hostname, { all: true, verbatim: true })).map((a) => a.address)
  })
  proxyPort = await proxy.listen(0, '127.0.0.1')
})

after(async () => {
  await proxy.close()
  for (const server of [upstream, origin, echo]) server.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

// -- fail closed ------------------------------------------------------------

test('before any config exists, the proxy answers nothing and tunnels nothing', async () => {
  assert.equal(proxy.current(), null)
  const mcp = await call(`/mcp/${TOKEN}/linear`)
  assert.equal(mcp.status, 503, 'a proxy without a scope fails closed, not open')
  const tunnel = await connect(`127.0.0.1:${echoPort}`)
  assert.equal(tunnel.status, 403)
  assert.equal(tunnel.tunnel, undefined, 'nothing was connected')
  const forward = await call(`http://127.0.0.1:${originPort}/x`)
  assert.equal(forward.status, 403)
})

// -- the token guard --------------------------------------------------------

test('an unknown token is a 404, exactly like an unknown path', async () => {
  await pushConfig(baseConfig())
  const wrong = await call(`/mcp/${TOKEN}-not/linear`)
  assert.equal(wrong.status, 404)
  const empty = await call('/mcp//linear')
  assert.equal(empty.status, 404)
  assert.equal(upstreamSeen.length, 0, 'nothing reached the upstream')
})

test('an id outside the scope is a 404 — and it is logged, because that is a signal', async () => {
  const res = await call(`/mcp/${TOKEN}/not-selected`)
  assert.equal(res.status, 404)
  assert.match(res.body, /not-selected/, 'the agent is told which id failed')
  const denied = records.filter((r) => r.kind === 'mcp' && r.reason === 'unknown-id')
  assert.equal(denied.length, 1)
  assert.equal(denied[0].id, 'not-selected')
})

test('the proxy serves nothing of its own beyond the MCP route', async () => {
  assert.equal((await call('/')).status, 404)
  assert.equal((await call('/mcp')).status, 404)
  const health = await call('/healthz')
  assert.equal(health.status, 200)
  assert.deepEqual(JSON.parse(health.body), { ok: true, scope: true }, 'liveness says whether a scope is loaded, never what is in it')
})

// -- MCP routing ------------------------------------------------------------

test('a scoped id is routed to its upstream with the credential injected', async () => {
  upstreamSeen.length = 0
  const res = await call(`/mcp/${TOKEN}/linear`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': 'client-session-1',
      'last-event-id': '42',
      // What the container might send on its own: a junk credential, a
      // hop-by-hop field, and a header nominated by Connection.
      authorization: 'Bearer container-junk',
      connection: 'keep-alive, x-hop',
      'x-hop': 'should-not-survive',
      'proxy-connection': 'keep-alive'
    },
    body: '{"jsonrpc":"2.0","method":"tools/list","id":1}'
  })

  assert.equal(res.status, 200)
  assert.equal(upstreamSeen.length, 1)
  const seen = upstreamSeen[0]
  assert.equal(seen.url, '/upstream/mcp', "the upstream's own path replaces the route's")
  assert.equal(seen.headers.host, `127.0.0.1:${upstreamPort}`, 'Host is the upstream, not the proxy')
  assert.equal(seen.headers.authorization, UPSTREAM_SECRET, 'the resolved credential wins over whatever the container sent')
  assert.equal(seen.headers['x-static'], 'from-registry')
  assert.equal(seen.headers['mcp-session-id'], 'client-session-1', 'transport headers pass through untouched')
  assert.equal(seen.headers['last-event-id'], '42')
  assert.equal(seen.headers.accept, 'application/json, text/event-stream')
  assert.equal(seen.headers['x-hop'], undefined, 'a field Connection nominates is hop-by-hop too')
  assert.equal(seen.headers['proxy-connection'], undefined)
  assert.equal(seen.body, '{"jsonrpc":"2.0","method":"tools/list","id":1}', 'the request body is piped through')
  assert.equal(res.headers['mcp-session-id'], 'up-1', 'and the response headers come back')
})

test('an SSE response is piped, not buffered — the first event lands long before the last', async () => {
  const res = await call(`/mcp/${TOKEN}/linear`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  })
  assert.match(res.body, /"first":true/)
  assert.match(res.body, /"second":true/)
  // The upstream holds the stream open for 150ms after the first event. A
  // buffering proxy would deliver both at once, at the end.
  assert.ok(
    res.endedAt - res.firstChunkAt > 100,
    `the stream arrived in pieces (first→end ${res.endedAt - res.firstChunkAt}ms)`
  )
})

test('DELETE reaches the upstream, so an MCP session can be closed', async () => {
  upstreamSeen.length = 0
  const res = await call(`/mcp/${TOKEN}/linear`, { method: 'DELETE' })
  assert.equal(res.status, 204)
  assert.equal(upstreamSeen[0].method, 'DELETE')
})

test('a host upstream routes the same way, on the URL that carries the host token', async () => {
  upstreamSeen.length = 0
  const res = await call(`/mcp/${TOKEN}/github`)
  assert.equal(res.status, 200)
  assert.equal(upstreamSeen[0].url, '/host/mcp')
})

test('a client that ignored NO_PROXY still reaches the MCP route', async () => {
  upstreamSeen.length = 0
  // Absolute-form at the proxy itself — the shape curl produces when it applies
  // HTTP_PROXY to a URL that names the proxy.
  const res = await call(`http://127.0.0.1:${proxyPort}/mcp/${TOKEN}/linear`)
  assert.equal(res.status, 200)
  assert.equal(upstreamSeen[0]?.url, '/upstream/mcp')
})

test('an unreachable upstream is a 502, not a hang', async () => {
  const dead = baseConfig()
  dead.mcp.linear = { kind: 'registry', url: 'http://127.0.0.1:1/mcp', headers: [] }
  await pushConfig(dead)
  const res = await call(`/mcp/${TOKEN}/linear`)
  assert.equal(res.status, 502)
  await pushConfig(baseConfig())
})

test('a header the scope cannot send is a 502 for that id, and the proxy survives it', async () => {
  // Node validates header names and values as the upstream request is built —
  // synchronously, inside the request listener. Unguarded, one credential pasted
  // with its line break is not a failed call: it is an uncaught throw, and with
  // it the process, every other MCP route and all of the session's egress.
  //
  // Written and reloaded by hand rather than through pushConfig: headers do not
  // show in the scope summary the poll compares, so there is nothing for it to
  // converge on.
  const poison = (headers) => {
    const config = baseConfig()
    config.mcp.linear.headers = headers
    fs.writeFileSync(configPath, JSON.stringify(config))
    proxy.reload('test')
  }

  poison([{ name: 'Authorization', value: 'Bearer broken\nX-Injected: yes' }])
  const res = await call(`/mcp/${TOKEN}/linear`)
  assert.equal(res.status, 502)
  assert.match(res.body, /cannot be sent/)
  const rec = records.filter((r) => r.kind === 'mcp').at(-1)
  assert.equal(rec.decision, 'error')
  assert.equal(rec.reason, 'bad-header', 'the log says why, because the response must not')

  // A malformed *name* takes the same path (ERR_INVALID_HTTP_TOKEN, same place).
  poison([{ name: 'X Api Key', value: 'k' }])
  assert.equal((await call(`/mcp/${TOKEN}/linear`)).status, 502)

  // The whole point of the guard: still serving, on the same listener.
  assert.equal((await call(`/mcp/${TOKEN}/github`)).status, 200, 'the other routes are untouched')
  assert.equal((await call('/healthz')).status, 200)
  const egress = await call(`http://127.0.0.1:${originPort}/still-here`, {
    headers: { host: `127.0.0.1:${originPort}` }
  })
  assert.equal(egress.status, 200, 'and egress with them')

  // And the id itself recovers as soon as the scope does — no restart.
  fs.writeFileSync(configPath, JSON.stringify(baseConfig()))
  proxy.reload('test')
  assert.equal((await call(`/mcp/${TOKEN}/linear`)).status, 200)
})

// -- egress -----------------------------------------------------------------

test('plain-HTTP egress is forwarded to a destination the allow list names', async () => {
  const res = await call(`http://127.0.0.1:${originPort}/hello?q=1`, {
    headers: { host: `127.0.0.1:${originPort}` }
  })
  assert.equal(res.status, 200)
  assert.equal(res.body, 'origin /hello?q=1', 'path and query reach the origin unchanged')
  const rec = records.filter((r) => r.kind === 'http').at(-1)
  assert.deepEqual(
    { host: rec.host, port: rec.port, decision: rec.decision, status: rec.status },
    { host: '127.0.0.1', port: originPort, decision: 'allow', status: 200 }
  )
})

test('CONNECT tunnels bytes both ways once the policy allows it', async () => {
  const { status, tunnel } = await connect(`127.0.0.1:${echoPort}`)
  assert.equal(status, 200)
  const echoed = await new Promise((resolve, reject) => {
    tunnel.once('data', (c) => resolve(c.toString('utf8')))
    tunnel.on('error', reject)
    tunnel.write('tls-would-go-here')
  })
  assert.equal(echoed, 'tls-would-go-here', 'the tunnel is byte-for-byte; nothing is terminated')
  tunnel.destroy()
  const rec = records.filter((r) => r.kind === 'connect' && r.decision === 'allow').at(-1)
  assert.equal(rec.host, '127.0.0.1')
  assert.equal(rec.port, echoPort)
})

test('a client that resets its connection does not take the proxy down with it', async () => {
  // What curl does with a refused tunnel: read the 403, reset. The socket is
  // detached from the http server by then, so an unhandled 'error' on it is not
  // a failed request — it is the whole session's egress and MCP, gone.
  await pushConfig(baseConfig({ network: { policy: { allow: ['example.com'] } } }))
  for (const readFirst of [true, false]) {
    await new Promise((resolve) => {
      const socket = net.connect(proxyPort, '127.0.0.1', () => {
        socket.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`)
        if (!readFirst) {
          socket.resetAndDestroy()
          setTimeout(resolve, 20)
        }
      })
      if (readFirst)
        socket.once('data', () => {
          socket.resetAndDestroy()
          setTimeout(resolve, 20)
        })
      socket.on('error', () => {})
    })
  }
  // Still serving, on the same listener.
  await pushConfig(baseConfig())
  assert.equal((await call(`/mcp/${TOKEN}/linear`)).status, 200)
})

test('a malformed CONNECT target is refused before anything is dialled', async () => {
  const res = await connect('nonsense:port')
  assert.equal(res.status, 400)
  assert.equal(res.tunnel, undefined)
})

// -- the built-in denylist (§6.4) -------------------------------------------

/** Bytes through a tunnel, so "allowed" means reached and not merely permitted. */
async function echoThrough(tunnel) {
  const back = await new Promise((resolve, reject) => {
    tunnel.once('data', (c) => resolve(c.toString('utf8')))
    tunnel.on('error', reject)
    tunnel.write('through')
  })
  tunnel.destroy()
  return back
}

const lastDeny = (kind) => records.filter((r) => r.kind === kind && r.decision === 'deny').at(-1)

test('the metadata service is refused under an empty allow list — rule 1 is not about this machine', async () => {
  await pushConfig(openConfig())
  assert.deepEqual(proxy.current().network.policy, { allow: [] })
  const res = await connect('169.254.169.254:80')
  assert.equal(res.status, 403)
  assert.equal(res.tunnel, undefined, 'nothing was dialled')
  assert.match(res.body, /link-local/, 'the agent is told what it hit')
  assert.match(res.body, /allow list/, 'and the one way to say yes')
  const rec = lastDeny('connect')
  assert.equal(rec.rule, 'builtin-denylist', 'a distinct reason: this is not the session policy')
  assert.equal(rec.host, '169.254.169.254')
  assert.equal(rec.ip, '169.254.169.254')
})

test('a name that resolves into a denied range is refused — the check is on the address', async () => {
  // Rule 1's machinery, unchanged: an unlisted target is resolved once, every
  // address it answered with is vetted, and the connection is made to the vetted
  // one. The rebinding case is why a hostname check would be theatre — the label
  // is unremarkable and the answer is the metadata service.
  await pushConfig(openConfig())
  const tunnel = await connect('metadata.rebind.test:443')
  assert.equal(tunnel.status, 403)
  assert.equal(tunnel.tunnel, undefined)
  assert.match(tunnel.body, /169\.254\.169\.254/, 'the refusal names the address, not just the label')
  assert.equal(lastDeny('connect').ip, '169.254.169.254')

  const forward = await call('http://intranet.rebind.test/private')
  assert.equal(forward.status, 403, 'the forward path resolves and vets exactly the same way')
  assert.match(forward.body, /192\.168\.77\.7/)
  assert.equal(lastDeny('http').rule, 'builtin-denylist')
})

test('an allow entry beats the built-in denylist, by flipping the session to rule 2', async () => {
  // The one way to reach a built-in-denied destination, and its whole price:
  // naming `host.docker.internal:<port>` opens that target and closes every
  // other one, the rest of the internet included.
  const entry = `host.docker.internal:${echoPort}`
  await pushConfig(baseConfig({ network: { internal: true, policy: { allow: [entry] } } }))
  const open = await connect(entry)
  assert.equal(open.status, 200, 'the user named this host:port, so it connects')
  assert.equal(await echoThrough(open.tunnel), 'through')

  // The port is part of the entry, so the rest of the host is refused — an
  // entry is a sentence about one destination, not about a machine. And the
  // refusal now comes from the list, not from the built-in denylist, which is
  // not consulted at all once the list has entries.
  const other = await connect(`host.docker.internal:${originPort}`)
  assert.equal(other.status, 403, 'another port on the same host is not covered')
  assert.equal(lastDeny('connect').rule, 'allowlist')

  // …and so is everything the list does not name.
  assert.equal((await connect(`127.0.0.1:${echoPort}`)).status, 403, 'rule 2 closes the rest')
  assert.equal(lastDeny('connect').rule, 'allowlist')
})

test('an explicit allow by name beats the address check, which is the point of naming it', async () => {
  // `internal.corp.com` resolving to a private address is the case the override
  // exists for: intended, and indistinguishable from a rebind without the user.
  const target = `pinned.rebind.test:${echoPort}`
  await pushConfig(openConfig())
  const refused = await connect(target)
  assert.equal(refused.status, 403, 'without the entry it is a name that resolves to loopback')
  assert.match(refused.body, /127\.0\.0\.1/)

  await pushConfig(baseConfig({ network: { policy: { allow: ['pinned.rebind.test'] } } }))
  const open = await connect(target)
  assert.equal(open.status, 200, 'the name the user wrote is not resolved back into a refusal')
  assert.equal(await echoThrough(open.tunnel), 'through')
})

test('a private-range target is denied by default and allowed by an explicit entry', async (t) => {
  if (!PRIVATE) {
    // Nothing to reach: without an RFC1918 address of its own, this machine
    // cannot prove the *allow* half, and the deny half is covered above by
    // `intranet.rebind.test`.
    t.skip('this machine has no RFC1918 address to reach itself on')
    return
  }
  await pushConfig(openConfig())
  const refused = await connect(`${PRIVATE}:${echoPort}`)
  assert.equal(refused.status, 403, 'RFC1918 is refused under an empty allow list like everything else here')
  assert.match(refused.body, /private/)
  assert.equal(lastDeny('connect').rule, 'builtin-denylist')

  await pushConfig(baseConfig({ network: { policy: { allow: [`${PRIVATE}:${echoPort}`] } } }))
  const open = await connect(`${PRIVATE}:${echoPort}`)
  assert.equal(open.status, 200)
  assert.equal(await echoThrough(open.tunnel), 'through')
})

test('MCP routing is outside all of it — a registry entry is already an explicit allow', async () => {
  // The two halves of the same scope, pulling opposite ways: a policy that
  // permits no egress at all, and an upstream on the docker host. A user's own
  // MCP server usually lives at exactly this address.
  const scoped = baseConfig({
    network: { internal: true, policy: { allow: ['nothing.example'] } }
  })
  scoped.mcp.selfhosted = {
    kind: 'registry',
    url: `http://host.docker.internal:${upstreamPort}/upstream/mcp`
  }
  await pushConfig(scoped)
  upstreamSeen.length = 0
  const res = await call(`/mcp/${TOKEN}/selfhosted`)
  assert.equal(res.status, 200, 'the MCP route reaches an upstream the egress policy would refuse')
  assert.equal(upstreamSeen[0]?.url, '/upstream/mcp')

  // And the same host, asked for as egress, is still refused.
  assert.equal((await connect(`host.docker.internal:${upstreamPort}`)).status, 403)
  await pushConfig(baseConfig())
})

// -- the reload, which is the point -----------------------------------------

test('an allow list pushed mid-session refuses new egress while the token keeps working', async () => {
  const before = proxy.current().token
  await pushConfig(
    baseConfig({ network: { internal: true, policy: { allow: ['registry.npmjs.org'] } } })
  )
  assert.equal(proxy.current().token, before, 'the scope changed; the token the agent holds did not')

  const refusedConnect = await connect(`127.0.0.1:${echoPort}`)
  assert.equal(refusedConnect.status, 403)
  assert.match(refusedConnect.body, /allow list/, 'the agent is told why, so it stops retrying')
  assert.match(refusedConnect.body, /127\.0\.0\.1/)

  const refusedHttp = await call(`http://127.0.0.1:${originPort}/hello`)
  assert.equal(refusedHttp.status, 403)

  // MCP upstreams are not subject to the egress policy: the user selected them
  // per session, which is a stronger statement of intent than an allow list.
  const mcp = await call(`/mcp/${TOKEN}/linear`)
  assert.equal(mcp.status, 200, 'a selected MCP server is reachable in internal mode')
})

test('adding the host to the allow list unblocks it, with no restart', async () => {
  await pushConfig(
    baseConfig({ network: { internal: true, policy: { allow: ['registry.npmjs.org', '127.0.0.1'] } } })
  )
  const { status, tunnel } = await connect(`127.0.0.1:${echoPort}`)
  assert.equal(status, 200, 'the one-click "allow this host" loop is a file write')
  tunnel.destroy()
})

test('an MCP server switched off mid-session stops resolving', async () => {
  const narrowed = baseConfig()
  delete narrowed.mcp.linear
  await pushConfig(narrowed)
  assert.equal((await call(`/mcp/${TOKEN}/linear`)).status, 404)
  assert.equal((await call(`/mcp/${TOKEN}/github`)).status, 200, 'the rest of the scope is untouched')
  await pushConfig(baseConfig())
})

test('a broken config keeps the last good scope instead of opening or closing the session', async () => {
  const errorsBefore = records.filter((r) => r.kind === 'config' && r.decision === 'error').length
  fs.writeFileSync(configPath, '{ "version": 1, "token": ')
  await waitFor(
    () => records.filter((r) => r.kind === 'config' && r.decision === 'error').length > errorsBefore
  )
  assert.equal((await call(`/mcp/${TOKEN}/linear`)).status, 200, 'the running session is unaffected')
  await pushConfig(baseConfig())
})

test('removing the config revokes the scope and the proxy fails closed again', async () => {
  fs.rmSync(configPath)
  await waitFor(() => proxy.current() === null)
  assert.equal((await call(`/mcp/${TOKEN}/linear`)).status, 503)
  assert.equal((await connect(`127.0.0.1:${echoPort}`)).status, 403)
  assert.ok(records.some((r) => r.kind === 'config' && r.decision === 'revoked'))
})

// -- what the log may say ---------------------------------------------------

test('every record carries what the blocked list needs, and nothing it must not', () => {
  const attempts = records.filter((r) => ['mcp', 'connect', 'http'].includes(r.kind))
  assert.ok(attempts.length > 10)
  for (const rec of attempts) {
    assert.ok(['allow', 'deny', 'error'].includes(rec.decision), `decision on ${JSON.stringify(rec)}`)
    // The one record without a hostname is the one whose target did not parse
    // into one — it is logged all the same, because a client sending garbage at
    // the proxy is worth seeing.
    if (rec.reason !== 'malformed' && (rec.kind !== 'mcp' || rec.decision === 'allow'))
      assert.equal(typeof rec.host, 'string', `hostname on ${JSON.stringify(rec)}`)
    if (rec.kind === 'mcp') assert.equal(typeof rec.id, 'string', 'an MCP record names its id')
  }
  // The lines are JSON, one per attempt, timestamped by the sink the container
  // writes to stdout with.
  const line = JSON.parse(
    JSON.stringify({ t: new Date().toISOString(), ...attempts[0] })
  )
  assert.match(line.t, /^\d{4}-\d\d-\d\dT/)

  // The built-in denylist logs under its own rule, so the UI can say "gurt
  // refused this" rather than "your policy refused this" — a different sentence
  // and a different fix.
  const builtin = attempts.filter((r) => r.rule === 'builtin-denylist')
  assert.ok(builtin.length >= 4, 'every refusal above is in the traffic log')
  assert.ok(
    builtin.every((r) => r.decision === 'deny' && typeof r.host === 'string'),
    'and carries what the blocked list renders'
  )
  assert.ok(
    builtin.some((r) => r.ip === '169.254.169.254'),
    'a name that resolved into a denied range records the address it resolved to'
  )
  assert.ok(
    !attempts.some((r) => r.decision === 'allow' && r.rule === 'builtin-denylist'),
    'the reason only ever rides on a refusal'
  )

  const dump = JSON.stringify(records)
  assert.ok(!dump.includes(TOKEN), 'the session token never reaches a log record')
  assert.ok(!dump.includes(UPSTREAM_SECRET), 'nor does an injected credential')
  assert.ok(!dump.includes('/upstream/mcp'), 'nor does a request path — a URL routinely carries a token')
  assert.ok(!dump.includes('tools/list'), 'nor does a body')
})
