// The proxy's PII rewrite of MCP traffic (docs/requirements-pii-mask.md §9.2),
// driven over loopback with the real `resources/proxy/gurt-proxy.mjs`.
//
// Three fixtures: a fake *host* that answers `/reveal` and `/encode` from a one
// row table (what src/main/piiRewrite.ts does with the real one), a fake
// upstream MCP server that echoes what it received and answers in JSON, SSE and
// plain text, and the proxy between them and the "agent" (this file).
//
//   node --test scripts/proxy-pii.test.mjs
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createProxy, encodeRoots, revealRoots, rewriteMessages } from '../resources/proxy/gurt-proxy.mjs'

const TOKEN = 'PROXY-PII-TOKEN-0123456789abcdef'
const REAL = 'jane@example.com'
const TOKEN_TEXT = '[email:1]'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-proxy-pii-'))
const configPath = path.join(dir, 'proxy.json')

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
const readAll = (req) =>
  new Promise((r) => {
    const c = []
    req.on('data', (d) => c.push(d))
    req.on('end', () => r(Buffer.concat(c).toString('utf8')))
  })

// -- the fake host ----------------------------------------------------------
let hostDown = false
const hostCalls = []
const host = http.createServer(async (req, res) => {
  const { strings } = JSON.parse(await readAll(req))
  const op = req.url.split('/').pop()
  hostCalls.push({ op, strings })
  if (hostDown) return res.writeHead(500).end()
  const out = strings.map((s) =>
    op === 'reveal' ? s.split(TOKEN_TEXT).join(REAL) : s.split(REAL).join(TOKEN_TEXT)
  )
  const body = JSON.stringify({ strings: out })
  res.writeHead(200, { 'content-type': 'application/json' }).end(body)
})

// -- the fake upstream MCP server ---------------------------------------------
const seen = []
const upstream = http.createServer(async (req, res) => {
  const body = await readAll(req)
  seen.push({ method: req.method, headers: req.headers, body })
  if (req.url.startsWith('/sse')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    // One event split across two writes, then a server-initiated log message.
    const evt = `event: message\ndata: ${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: `mail ${REAL}` }], isError: false }
    })}\n\n`
    res.write(evt.slice(0, 40))
    setTimeout(() => {
      res.write(evt.slice(40))
      res.write(
        `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { data: `log ${REAL}` } })}\n\n`
      )
      res.end()
    }, 50)
    return
  }
  if (req.url.startsWith('/text')) return res.writeHead(500, { 'content-type': 'text/plain' }).end(`boom for ${REAL}`)
  if (req.url.startsWith('/zip')) return res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }).end('x')
  const msg = JSON.parse(body || '{}')
  res.writeHead(200, { 'content-type': 'application/json' }).end(
    JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [{ type: 'text', text: `echo ${JSON.stringify(msg.params)} / real ${REAL}` }],
        tools: [{ name: `tool-${REAL}` }]
      }
    })
  )
})

let proxy
let proxyPort
let hostPort
let upstreamPort

const config = (pii = true) => ({
  version: 1,
  session: 's-pii',
  token: TOKEN,
  mcp: {
    a: { kind: 'registry', url: `http://127.0.0.1:${upstreamPort}/json` },
    sse: { kind: 'registry', url: `http://127.0.0.1:${upstreamPort}/sse` },
    text: { kind: 'registry', url: `http://127.0.0.1:${upstreamPort}/text` },
    zip: { kind: 'registry', url: `http://127.0.0.1:${upstreamPort}/zip` }
  },
  network: { internal: false, policy: { allow: [] } },
  ...(pii ? { pii: { url: `http://127.0.0.1:${hostPort}/pii/secret` } } : {})
})

async function push(cfg) {
  const tmp = `${configPath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(cfg))
  fs.renameSync(tmp, configPath)
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (!!proxy.current()?.pii === !!cfg.pii) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('proxy did not converge')
}

function post(id, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: proxyPort, method: 'POST', path: `/mcp/${TOKEN}/${id}`, headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        const c = []
        res.on('data', (d) => c.push(d))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString('utf8') }))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

before(async () => {
  hostPort = await listen(host)
  upstreamPort = await listen(upstream)
  proxy = createProxy({ configPath, log: () => {}, watchMs: 20 })
  proxyPort = await proxy.listen(0, '127.0.0.1')
  await push(config())
})
after(async () => {
  await proxy.close()
  host.close()
  upstream.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const call = (id, args) => JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'x', arguments: args } })

test('a request is revealed on its way to the server, a JSON result encoded on its way back', async () => {
  seen.length = 0
  const r = await post('a', call('a', { to: TOKEN_TEXT, n: 3, nested: [{ cc: `${TOKEN_TEXT}!` }] }))
  assert.equal(r.status, 200)
  const got = JSON.parse(seen[0].body)
  assert.equal(got.params.arguments.to, REAL, 'the server receives the real value')
  assert.equal(got.params.arguments.nested[0].cc, `${REAL}!`)
  assert.equal(got.params.arguments.n, 3, 'non-strings are untouched')
  assert.ok(!seen[0].body.includes(TOKEN_TEXT))
  assert.equal(seen[0].headers['accept-encoding'], 'identity', 'rewriting needs uncompressed bytes')
  assert.equal(Number(seen[0].headers['content-length']), Buffer.byteLength(seen[0].body), 'length follows the rewrite')

  const out = JSON.parse(r.body)
  assert.ok(!r.body.includes(`real ${REAL}`), 'the agent never receives the real value')
  assert.ok(out.result.content[0].text.endsWith(`real ${TOKEN_TEXT}`))
  assert.equal(out.result.tools[0].name, `tool-${REAL}`, 'a tool listing is protocol, not content — left alone')
  assert.equal(Number(r.headers['content-length']), Buffer.byteLength(r.body))
})

test('an SSE response is encoded event by event, even when an event straddles two writes', async () => {
  const r = await post('sse', call('sse', {}))
  assert.equal(r.status, 200)
  assert.ok(!r.body.includes(REAL), 'no real value in the stream')
  const datas = r.body.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)))
  assert.equal(datas[0].result.content[0].text, `mail ${TOKEN_TEXT}`)
  assert.equal(datas[1].params.data, `log ${TOKEN_TEXT}`, 'a server-initiated message is content too')
  assert.match(r.body, /^event: message\n/, 'other SSE fields ride along')
})

test('a plain-text error body is encoded', async () => {
  const r = await post('text', call('text', {}))
  assert.equal(r.status, 500)
  assert.equal(r.body, `boom for ${TOKEN_TEXT}`)
})

test('a compressed response cannot be rewritten, so it is refused rather than forwarded', async () => {
  const r = await post('zip', call('zip', {}))
  assert.equal(r.status, 502)
})

test('fail closed: with the host down, nothing is forwarded in either direction', async () => {
  hostDown = true
  seen.length = 0
  const r = await post('a', call('a', { to: TOKEN_TEXT }))
  assert.equal(r.status, 502, 'the request is refused, not sent on with a token the server cannot use')
  assert.equal(seen.length, 0, 'it never reached the upstream')
  const s = await post('sse', call('sse', {}))
  assert.ok(!s.body.includes(REAL), 'and a real value never reaches the agent')
  hostDown = false
})

test('a session without a pii scope is piped as before', async () => {
  await push(config(false))
  seen.length = 0
  const r = await post('a', call('a', { to: TOKEN_TEXT }))
  assert.equal(JSON.parse(seen[0].body).params.arguments.to, TOKEN_TEXT, 'untouched')
  assert.ok(r.body.includes(`real ${REAL}`), 'and so is the response')
  assert.equal(seen[0].headers['accept-encoding'], undefined)
  await push(config(true))
})

test('a malformed pii url is a refused scope, not an open one', async () => {
  const before = proxy.current()
  const tmp = `${configPath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ ...config(), pii: { url: 'not a url' } }))
  fs.renameSync(tmp, configPath)
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(proxy.current()?.pii?.url, before.pii.url, 'the last good scope stays')
})

test('the message walkers: what is revealed, what is encoded', async () => {
  const sets = (value, roots) => {
    const strings = []
    return rewriteMessages(value, roots, (s) => {
      strings.push(...s)
      return s
    }).then(() => strings)
  }
  assert.deepEqual(await sets({ a: ['x', { b: 'y' }], n: 1 }, revealRoots), ['x', 'y'])
  assert.deepEqual(
    await sets({ jsonrpc: '2.0', id: 1, result: { content: [{ text: 't' }], tools: [{ name: 'n' }], serverInfo: { name: 's' } } }, encodeRoots),
    ['t']
  )
  assert.deepEqual(await sets({ jsonrpc: '2.0', id: 1, error: { code: 1, message: 'm', data: 'd' } }, encodeRoots), ['m', 'd'])
  assert.deepEqual(await sets([{ method: 'x', params: { p: 'q' } }, { result: { contents: ['c'] } }], encodeRoots), ['q', 'c'])
  await assert.rejects(rewriteMessages({ result: { content: ['x'] } }, encodeRoots, () => ['a', 'b']), /wrong shape/)
})
