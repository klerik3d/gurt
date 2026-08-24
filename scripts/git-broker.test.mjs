// The git credential brokers (§4 container, §8 host) and the shims that talk to
// them, end to end over loopback — no docker, no network, no electron.
//
// What this file exists to pin down is one sentence: a stored secret leaves the
// main process ONLY as the body of an HTTP response, to a caller that already
// knows the broker's per-session path token, and it reaches the process that
// asked for it without ever passing through an argv, an env var or a log line.
// Everything below is a way of trying to get a secret out some other way and
// asserting that nothing comes back.
//
// The real modules are bundled with esbuild and driven for real:
//   git/broker.ts  — both brokers, reached with node:http on 127.0.0.1;
//   git/env.ts     — the host-side resolution (managed/ambient/blocked);
//   git/shims.ts   — the container credential helper and the host one, each
//                    spawned as an actual child process and made to fill a
//                    credential against a live broker.
//
// git-logic.test.mjs already covers config.ts + providers.ts as pure functions;
// nothing here re-asserts those tables, only what the brokers do with them.
//
//   node scripts/git-broker.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

// store.ts / log.ts read GURT_ROOT / GURT_LOG at module load — set before the
// bundle is imported. DBG is the loudest the app ever gets: if a secret or a
// broker token can reach the log at all, it reaches it at this level.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-git-broker-'))
process.env.GURT_ROOT = GURT_ROOT
process.env.GURT_LOG = 'debug'

// Distinctive, long enough to be redactable (log.ts's MIN_SECRET_LEN), and
// unlike anything the code produces on its own.
const GH_SECRET = 'ghp-SESSION-BROKER-SECRET-1a2b3c4d5e6f'
const GL_SECRET = 'glpat-UNVERIFIED-ENTRY-SECRET-9z8y7x6w'
const AGENT_SECRET = 'sk-ant-AGENT-TOKEN-SECRET-5f4e3d2c1b0a'
const ALL_SECRETS = [GH_SECRET, GL_SECRET, AGENT_SECRET]

const IDENTITY = { gitName: 'Octo Cat', gitEmail: '42+octo@users.noreply.github.com' }
const CREDENTIALS = [
  // Verified (§3.2 stamped identity) — the only entry that may ever be served.
  {
    id: 'cred-gh',
    label: 'github pat',
    kind: 'git-token',
    hosts: ['github.com'],
    data: { secret: GH_SECRET, username: 'octo', ...IDENTITY }
  },
  // git-token with no stamped identity: resolution errors, so nothing serves it.
  {
    id: 'cred-unverified',
    label: 'gitlab pat',
    kind: 'git-token',
    hosts: ['gitlab.com'],
    data: { secret: GL_SECRET }
  },
  // Explicit ambient opt-in — carries no secret at all.
  { id: 'cred-host', label: 'host auth', kind: 'git-host', hosts: ['bitbucket.org'], data: {} },
  // An agent secret is not a git credential, whatever its `hosts` say.
  {
    id: 'cred-agent',
    label: 'claude token',
    kind: 'agent-token',
    hosts: ['github.com'],
    data: { secret: AGENT_SECRET }
  }
]
fs.writeFileSync(
  path.join(GURT_ROOT, 'credentials.json'),
  JSON.stringify({ version: 2, credentials: CREDENTIALS }, null, 2) + '\n'
)

const outfile = path.join(os.tmpdir(), `gurt-git-broker-${process.pid}.mjs`)
await bundle({
  stdin: {
    contents: `
      export { resolveGitBroker, stopGitBroker, ensureHostCredBroker } from ${S('src/main/git/broker.ts')}
      export { hostGitAccess } from ${S('src/main/git/env.ts')}
      export {
        CONTAINER_SHIMS, BASE_SHIMS, shimInstallScript,
        ensureHostCredHelper, hostCredHelperPath
      } from ${S('src/main/git/shims.ts')}
      export { BLOCKED_SSH_COMMAND, CRED_HELPER_BIN, SHIM_DIR } from ${S('src/main/git/config.ts')}
      export { flushSync } from ${S('src/main/log.ts')}
    `,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})

const m = await import(pathToFileURL(outfile).href)

const repo = (url, credentialId) => ({ name: 'app', url, devcontainer: '', credentialId })
const GH_REPO = repo('https://github.com/octo/app.git')

/** One request per socket (`agent: false`): no pooled keep-alive connection can
 *  outlive a `server.close()` and make the shutdown assertions ambiguous. */
function request(url, { method = 'GET', body = '', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method, agent: false, headers: { 'content-length': Buffer.byteLength(body), ...headers } },
      (res) => {
        let out = ''
        res.setEncoding('utf8')
        res.on('data', (d) => (out += d))
        res.on('end', () => resolve({ status: res.statusCode, body: out }))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

/** A git credential-fill body: `key=value` lines, as git writes them. */
const fill = (fields) =>
  Object.entries(fields)
    .map(([k, v]) => `${k}=${v}\n`)
    .join('')

/** The broker URL as the host can reach it: the descriptor is written for a
 *  container, where `host.docker.internal` is the host — here it is loopback.
 *  Substituting it also proves the listener really is on 0.0.0.0 (§4): a
 *  127.0.0.1-bound server would not answer the same port through this name. */
const reachable = (url) => url.replace('host.docker.internal', '127.0.0.1')

/** Poll (bounded, no fixed sleep) until nothing is listening on `port`. */
async function awaitRefused(port) {
  for (let i = 0; i < 200; i++) {
    const refused = await new Promise((resolve) => {
      const sock = net.connect({ port, host: '127.0.0.1' })
      sock.on('connect', () => {
        sock.destroy()
        resolve(false)
      })
      sock.on('error', () => resolve(true))
    })
    if (refused) return true
    await new Promise((r) => setImmediate(r))
  }
  return false
}

/** Run `argv` as a child, feed it `stdin`, resolve with its output + exit code. */
function runChild(argv, { env = process.env, stdin = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(stdin)
  })
}

/** Assert no stored secret appears anywhere in `value` (deep-stringified). */
function noSecretIn(value, what) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  for (const secret of ALL_SECRETS)
    assert.ok(!text.includes(secret), `a stored secret leaked into ${what}`)
}

const started = []

// Bound by one test and read by later ones: node:test runs the tests in a file
// one at a time, in declaration order.
let b1, u1, token1, b2, base1, guessed, managed, hostBroker, blocked, b1b, r, child

// The host credential broker is a process-lifetime singleton with no teardown
// (by design: it serves every session's host git access until the app quits),
// so its listener would keep this process alive forever. Nothing is pending once
// the tests are done — the log is flushed below — so its handle is unref'd
// rather than exiting explicitly, which would paper over a failing test.
after(() => {
  for (const id of started) m.stopGitBroker(id)
  m.flushSync()
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
  // `_getActiveHandles` is undocumented, but the module never hands the host
  // listener out, so there is no public reference to unref.
  const handles = /** @type {any} */ (process)._getActiveHandles?.() ?? []
  for (const h of handles) if (h?.constructor?.name === 'Server') h.unref()
})

// ==========================================================================
// §4 — the per-session container broker
// ==========================================================================
test('per-session broker: own listener, own random token', async () => {
  b1 = await m.resolveGitBroker('sess-1', GH_REPO)
  started.push('sess-1')
  u1 = new URL(b1.url)
  assert.equal(u1.protocol, 'http:')
  assert.equal(u1.hostname, 'host.docker.internal', 'the descriptor is written for the container')
  token1 = u1.pathname.replace(/^\/git\//, '')
  assert.match(
    token1,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'the path carries a random UUID bearer token'
  )
  assert.notEqual(token1, 'sess-1', 'the token is not derived from the session id')

  // One broker per session: a second resolve returns the very same descriptor
  // (same port, same token) rather than leaking a second listener per start.
  assert.equal((await m.resolveGitBroker('sess-1', GH_REPO)).url, b1.url, 'one broker per session')

  b2 = await m.resolveGitBroker('sess-2', GH_REPO)
  started.push('sess-2')
  assert.notEqual(new URL(b2.url).pathname, u1.pathname, 'each session gets its own token')
  assert.notEqual(new URL(b2.url).port, u1.port, 'each session gets its own listener')


  base1 = reachable(b1.url)
})

// --- the credential fill, which is the only way a secret may come out ---
test('credential fill answers on the stored entry, ignoring every other field', async () => {
  r = await request(`${base1}/credential`, {
    method: 'POST',
    body: fill({ protocol: 'https', host: 'github.com' })
  })
  assert.equal(r.status, 200)
  assert.equal(r.body, `username=octo\npassword=${GH_SECRET}\n`, 'the fill serves the credential')

  // Everything else git may send in a fill is dropped at the parse. A `store`
  // carrying an attacker-chosen username/password must not be echoed back, and
  // `path`/`wwwauth[]` must not change the answer.
  r = await request(`${base1}/credential`, {
    method: 'POST',
    body: fill({
      protocol: 'https',
      host: 'github.com',
      path: 'octo/app.git',
      'wwwauth[]': 'Basic realm="x"',
      username: 'attacker',
      password: 'PLANTED'
    })
  })
  assert.equal(r.status, 200)
  assert.equal(r.body, `username=octo\npassword=${GH_SECRET}\n`, 'extra fill fields are ignored')
})

// --- the token is the whole authorization ---
test('the path token is the whole authorization; every other path 404s', async () => {
  guessed = `http://127.0.0.1:${u1.port}`
  for (const [what, url] of [
    ['no token at all', `${guessed}/credential`],
    ['a wrong token', `${guessed}/git/00000000-0000-4000-8000-000000000000/credential`],
    ["another session's token", `${guessed}${new URL(b2.url).pathname}/credential`],
    ['a prefix of the token', `${guessed}/git/${token1.slice(0, -1)}/credential`],
    ['a longer token with the real one as its prefix', `${guessed}/git/${token1}x/credential`],
    ['the real token below another path', `${guessed}/decoy/git/${token1}/credential`],
    ['the real token with a query tacked on', `${guessed}/git/${token1}/credential?x=1`]
  ]) {
    const res = await request(url, {
      method: 'POST',
      body: fill({ protocol: 'https', host: 'github.com' })
    })
    assert.equal(res.status, 404, `${what} is refused`)
    noSecretIn(res.body, `the ${what} response`)
  }
})

// --- non-answers serve nothing (204, never a partial credential) ---
test('unverified / cross-host / non-http fills serve nothing (204)', async () => {
  for (const [what, body] of [
    ['ssh (not an http transport)', fill({ protocol: 'ssh', host: 'github.com' })],
    ['a missing protocol', fill({ host: 'github.com' })],
    ['a missing host', fill({ protocol: 'https' })],
    ['an unknown host', fill({ protocol: 'https', host: 'evil.example' })],
    ['a host with no verified entry', fill({ protocol: 'https', host: 'gitlab.com' })],
    ['an empty body', '']
  ]) {
    const res = await request(`${base1}/credential`, { method: 'POST', body })
    assert.equal(res.status, 204, `${what} → 204`)
    assert.equal(res.body, '', `${what} serves no payload`)
  }


  // The agent-token entry lists github.com, and its secret must still never be
  // reachable through a git credential fill — covered by the 200 above serving
  // the git-token, and asserted here as a whole-transcript property.
  assert.ok(!(await request(`${base1}/credential`, {
    method: 'POST',
    body: fill({ protocol: 'https', host: 'github.com' })
  })).body.includes(AGENT_SECRET), 'an agent-token secret is never served as a git credential')
})

// --- method/route discipline ---
test('method/route discipline', async () => {
  for (const [what, url, method] of [
    ['GET on /credential', `${base1}/credential`, 'GET'],
    ['POST on /forge-env', `${base1}/forge-env`, 'POST'],
    ['an unknown route', `${base1}/anything`, 'GET']
  ]) {
    const res = await request(url, { method, body: '' })
    assert.equal(res.status, 404, `${what} is refused`)
  }
})

// --- /forge-env: the CLI env map, secret-bearing, same token gate ---
test('/forge-env serves the provider map behind the same token', async () => {
  r = await request(`${base1}/forge-env`)
  assert.equal(r.status, 200)
  assert.deepEqual(JSON.parse(r.body), { GH_TOKEN: GH_SECRET }, 'the forge env is served')
  const forgeGuess = await request(`${guessed}/git/00000000-0000-4000-8000-000000000000/forge-env`)
  assert.equal(forgeGuess.status, 404, 'the forge env needs the token too')
  noSecretIn(forgeGuess.body, 'an untokenized /forge-env response')

  // A repo whose host has no forge provider serves nothing.
  await m.resolveGitBroker('sess-gl', repo('https://gitlab.com/octo/app.git'))
  started.push('sess-gl')
  const glBase = reachable((await m.resolveGitBroker('sess-gl', repo('x'))).url)
  const glForge = await request(`${glBase}/forge-env`)
  assert.equal(glForge.status, 204, 'no forge provider → no forge env')
})

// ==========================================================================
// The container credential shim, run for real against the live broker
// ==========================================================================
//
// This is the piece that actually carries a secret across a process boundary
// in production. It is spawned here exactly as the agent's git would spawn
// it: argv `get`, the fill on stdin, the broker URL in GURT_GIT_BROKER.
test('container credential shim fills from the broker, and only from it', async () => {
  const shimFile = path.join(GURT_ROOT, 'gurt-git-credential.cjs')
  fs.writeFileSync(shimFile, m.CONTAINER_SHIMS['gurt-git-credential'])
  const shimArgv = (verb) => [process.execPath, shimFile, verb]
  const shimEnv = (broker) => ({ ...process.env, GURT_GIT_BROKER: broker })

  // The secret is in neither the argv nor the env the shim is launched with —
  // it can only arrive over the broker connection.
  noSecretIn(shimArgv('get'), "the credential shim's argv")
  noSecretIn(shimEnv(base1), "the credential shim's env")

  child = await runChild(shimArgv('get'), {
    env: shimEnv(base1),
    stdin: fill({ protocol: 'https', host: 'github.com' })
  })
  assert.equal(child.code, 0)
  assert.equal(child.stdout, `username=octo\npassword=${GH_SECRET}\n`, 'the shim fills for git')

  // `store` / `erase` are no-ops: the shim never writes a credential anywhere.
  for (const verb of ['store', 'erase']) {
    const res = await runChild(shimArgv(verb), {
      env: shimEnv(base1),
      stdin: fill({ protocol: 'https', host: 'github.com', username: 'u', password: 'PLANTED' })
    })
    assert.equal(res.code, 0, `\`${verb}\` exits clean`)
    assert.equal(res.stdout, '', `\`${verb}\` writes nothing`)
  }

  // A shim pointed at the wrong token, or at no broker at all, fails silently
  // and empty — git then falls through and fails cleanly, it never gets a
  // half-credential or a hint that a broker is there.
  for (const { what, env } of [
    { what: 'a wrong token', env: shimEnv(`${guessed}/git/00000000-0000-4000-8000-000000000000`) },
    { what: 'a dead port', env: shimEnv('http://127.0.0.1:1/git/x') },
    { what: 'no broker in the env', env: shimEnv('') },
    { what: 'a malformed broker URL', env: shimEnv('not a url') }
  ]) {
    const res = await runChild(shimArgv('get'), {
      env,
      stdin: fill({ protocol: 'https', host: 'github.com' })
    })
    assert.equal(res.code, 0, `${what}: the shim still exits 0 (git falls through)`)
    assert.equal(res.stdout, '', `${what}: the shim serves nothing`)
  }
})

// --- the install payload that puts those shims in a container ---
test('shim install payload is base64-framed and shell-safe', () => {
  for (const name of m.BASE_SHIMS)
    assert.ok(m.CONTAINER_SHIMS[name], `BASE_SHIMS entry "${name}" has a source`)
  const script = m.shimInstallScript([...m.BASE_SHIMS, 'nonexistent-shim'])
  assert.ok(!script.includes('nonexistent-shim'), 'an unknown shim name is skipped, not injected')
  for (const name of m.BASE_SHIMS) {
    assert.ok(script.includes(`chmod 755 ${m.SHIM_DIR}/${name}`), `${name} is made executable`)
    const b64 = Buffer.from(m.CONTAINER_SHIMS[name], 'utf8').toString('base64')
    assert.ok(script.includes(b64), `${name} rides in as base64, not as quoted source`)
  }
  // Nothing in the payload can break out of the single-quoted `printf %s '…'`.
  assert.ok(!script.slice(script.indexOf('printf')).includes("\\'"), 'no quote escaping needed')
  assert.equal(
    script.split("'").length % 2,
    1,
    'every single quote in the install payload is balanced'
  )
  noSecretIn(script, 'the shim install payload')
})

// ==========================================================================
// §8 — host git access: the resolution, and what it puts in argv vs. env
// ==========================================================================
test('managed host access carries an id + a broker URL, never a secret', async () => {
  managed = await m.hostGitAccess(GH_REPO, CREDENTIALS)
  assert.equal(managed.mode, 'managed')
  assert.equal(managed.host, 'github.com')
  assert.equal(managed.resolution.entry.id, 'cred-gh')
  // THE argv invariant: git is invoked with these, and `ps` shows them to every
  // user on the box. The credential id and the broker URL may ride there; the
  // secret never may.
  noSecretIn(managed.gitArgs, 'the host git argv')
  noSecretIn(managed.env, 'the host git env')
  const helperCmd = `!ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${m.hostCredHelperPath()}"`
  assert.deepEqual(
    managed.gitArgs.slice(0, 4),
    ['-c', 'credential.helper=', '-c', `credential.helper=${helperCmd}`],
    "the inherited helper is reset, then replaced by gurt's own"
  )
  assert.ok(
    managed.gitArgs.includes('-c') &&
      managed.gitArgs.includes('url.https://github.com/.insteadOf=git@github.com:'),
    'ssh transports are rewritten to https, where the token works'
  )
  assert.ok(managed.gitArgs.includes('user.name=Octo Cat'), 'the verified identity authors commits')
  assert.ok(managed.gitArgs.includes(`user.email=${IDENTITY.gitEmail}`))
  assert.equal(managed.env.GURT_CRED_ID, 'cred-gh', 'the helper is handed an id, not a secret')
  assert.equal(managed.env.GURT_CRED_HOST, 'github.com')
  assert.equal(managed.env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(managed.env.GIT_SSH_COMMAND, m.BLOCKED_SSH_COMMAND, 'ambient ssh is blocked')
  assert.ok(managed.env.GURT_CRED_BROKER.startsWith('http://127.0.0.1:'))
})

test('blocked mode never falls back to ambient auth, and leaks nothing', async () => {
  // Ambient is an explicit kind, never a fallback.
  const ambient = await m.hostGitAccess(repo('https://bitbucket.org/octo/app.git'), CREDENTIALS)
  assert.equal(ambient.mode, 'ambient')
  assert.deepEqual(ambient.gitArgs, [], 'ambient injects no config at all')
  assert.equal(ambient.env.GIT_SSH_COMMAND, undefined, 'ambient may reach the host ssh keys')

  for (const [what, cfg] of [
    ['an unverified entry (§3.2)', repo('https://gitlab.com/octo/app.git')],
    ['a host with no entry', repo('https://example.com/octo/app.git')],
    ['a link to an agent token', repo('https://github.com/octo/app.git', 'cred-agent')],
    ['a dangling link', repo('https://github.com/octo/app.git', 'cred-gone')],
    ['an unparseable URL', repo('/tmp/local/bare.git')]
  ]) {
    const res = await m.hostGitAccess(cfg, CREDENTIALS)
    assert.equal(res.mode, 'blocked', `${what} blocks`)
    assert.ok(res.reason, `${what} explains itself`)
    assert.deepEqual(res.gitArgs, ['-c', 'credential.helper='], `${what} resets every helper`)
    assert.equal(res.env.GIT_SSH_COMMAND, m.BLOCKED_SSH_COMMAND, `${what} blocks ambient ssh`)
    assert.equal(res.env.GURT_CRED_ID, undefined, `${what} hands out no credential id`)
    noSecretIn(res.gitArgs, `the ${what} argv`)
    noSecretIn(res.env, `the ${what} env`)
  }
})

// ==========================================================================
// §8 — the host credential broker, and its helper as a real child process
// ==========================================================================
test('host broker is loopback + token + header scoped, and serves nothing else', async () => {
  hostBroker = await m.ensureHostCredBroker()
  assert.ok(
    hostBroker.url.startsWith('http://127.0.0.1:'),
    'the host broker is loopback-only — never container-reachable'
  )
  assert.equal(
    (await m.ensureHostCredBroker()).url,
    hostBroker.url,
    'the host broker is a single process-lifetime instance'
  )
  assert.equal(managed.env.GURT_CRED_BROKER, hostBroker.url, 'managed access points at it')

  const hostPort = new URL(hostBroker.url).port
  const scoped = { 'x-gurt-cred-id': 'cred-gh', 'x-gurt-cred-host': 'github.com' }
  r = await request(`${hostBroker.url}/credential`, {
    method: 'POST',
    headers: scoped,
    body: fill({ protocol: 'https', host: 'github.com' })
  })
  assert.equal(r.status, 200)
  assert.equal(r.body, `username=octo\npassword=${GH_SECRET}\n`)

  const ghFill = fill({ protocol: 'https', host: 'github.com' })
  for (const { what, headers, body } of [
    { what: 'no scoping headers', headers: {}, body: ghFill },
    {
      what: 'a host the credential was not resolved for (a redirect or submodule)',
      headers: scoped,
      body: fill({ protocol: 'https', host: 'evil.example' })
    },
    {
      what: 'an agent token id',
      headers: { 'x-gurt-cred-id': 'cred-agent', 'x-gurt-cred-host': 'github.com' },
      body: ghFill
    },
    {
      what: 'a dangling id',
      headers: { 'x-gurt-cred-id': 'nope', 'x-gurt-cred-host': 'github.com' },
      body: ghFill
    },
    {
      what: 'only half the scoping (an id with no host)',
      headers: { 'x-gurt-cred-id': 'cred-gh' },
      body: ghFill
    },
    {
      what: 'a non-http protocol',
      headers: scoped,
      body: fill({ protocol: 'ssh', host: 'github.com' })
    }
  ]) {
    const res = await request(`${hostBroker.url}/credential`, { method: 'POST', headers, body })
    assert.equal(res.status, 204, `${what} → 204`)
    assert.equal(res.body, '', `${what} serves nothing`)
  }

  // Note, deliberately not asserted either way: unlike the session broker,
  // `handleHostCredential` does not re-check §3.2 — handed the id of an
  // unverified git-token it would serve that entry's secret. It is not
  // reachable: the only thing that ever sets GURT_CRED_ID is `hostGitAccess`,
  // and an unverified entry blocks there instead (asserted above). Pinning the
  // current 200 here would enshrine a gap; pinning a 204 would fail today. The
  // invariant that holds is the one above — no reachable path yields that id.

  // The host broker's token gates it exactly like the session one.
  for (const url of [
    `http://127.0.0.1:${hostPort}/credential`,
    `http://127.0.0.1:${hostPort}/host/00000000-0000-4000-8000-000000000000/credential`,
    // A session-broker route must not exist on the host broker at all.
    `http://127.0.0.1:${hostPort}${new URL(b1.url).pathname}/credential`
  ]) {
    const res = await request(url, { method: 'POST', headers: scoped, body: fill({ protocol: 'https', host: 'github.com' }) })
    assert.equal(res.status, 404, `${url} is refused`)
    noSecretIn(res.body, 'an untokenized host-broker response')
  }
})

// --- the real host helper, spawned the way git spawns it ---
test('host credential helper round-trips the secret over loopback only', async () => {
  const helperPath = await m.ensureHostCredHelper()
  assert.equal(helperPath, m.hostCredHelperPath())
  assert.equal(await m.ensureHostCredHelper(), helperPath, 'materializing it is idempotent')
  noSecretIn(fs.readFileSync(helperPath, 'utf8'), 'the host helper source on disk')

  const helperArgv = [process.execPath, helperPath, 'get']
  noSecretIn(helperArgv, "the host helper's argv")
  noSecretIn(managed.env, "the host helper's env")

  child = await runChild(helperArgv, {
    env: managed.env,
    stdin: fill({ protocol: 'https', host: 'github.com' })
  })
  assert.equal(child.code, 0, child.stderr)
  assert.equal(
    child.stdout,
    `username=octo\npassword=${GH_SECRET}\n`,
    'the helper receives the secret over the broker, having been given only an id'
  )

  // Same helper, same env, a fill for another host: the broker refuses, so a
  // redirect or a cross-host submodule gets nothing (and does not fall through
  // to ambient auth either — GIT_SSH_COMMAND is blocked above).
  child = await runChild(helperArgv, {
    env: managed.env,
    stdin: fill({ protocol: 'https', host: 'evil.example' })
  })
  assert.equal(child.stdout, '', 'the helper serves nothing for a host it was not scoped to')

  for (const verb of ['store', 'erase']) {
    const res = await runChild([process.execPath, helperPath, verb], {
      env: managed.env,
      stdin: fill({ protocol: 'https', host: 'github.com', username: 'u', password: 'PLANTED' })
    })
    assert.equal(res.code, 0)
    assert.equal(res.stdout, '', `host helper \`${verb}\` writes nothing`)
  }

  // Blocked mode's env has no GURT_CRED_* at all — the same helper binary, run
  // under it, cannot reach the broker even though the broker is up.
  blocked = await m.hostGitAccess(repo('https://example.com/octo/app.git'), CREDENTIALS)
  child = await runChild(helperArgv, {
    env: blocked.env,
    stdin: fill({ protocol: 'https', host: 'github.com' })
  })
  assert.equal(child.stdout, '', 'the helper is inert without the resolved scope in its env')
})

// --- and the whole §8 chain through real git ---
test('real git fills through the host helper in managed mode, nothing in blocked', async () => {
  // `gitArgs` is a shell command string inside a `-c` value inside an argv;
  // nothing but git itself proves the quoting survives (a path with a space in
  // it is the classic break). This is what every host git call does.
  const filled = await runChild(['git', ...managed.gitArgs, 'credential', 'fill'], {
    env: managed.env,
    stdin: fill({ protocol: 'https', host: 'github.com' })
  })
  assert.equal(filled.code, 0, filled.stderr)
  assert.match(filled.stdout, /^username=octo$/m, 'git got the username from gurt')
  assert.match(
    filled.stdout,
    new RegExp(`^password=${GH_SECRET}$`, 'm'),
    'real git fills from the gurt broker, through the helper it was configured with'
  )
  // The same git, for a host that resolved to nothing: no credential, and no
  // fallthrough to whatever the host's own helpers would have answered.
  const blockedFill = await runChild(['git', ...blocked.gitArgs, 'credential', 'fill'], {
    env: blocked.env,
    stdin: fill({ protocol: 'https', host: 'github.com' })
  })
  noSecretIn(blockedFill.stdout, "blocked-mode git's credential fill")
  assert.ok(!/^password=.+$/m.test(blockedFill.stdout), 'blocked mode fills no password')
})

// ==========================================================================
// Teardown: a stopped broker stops answering
// ==========================================================================
test('stopGitBroker closes the listener and is idempotent', async () => {
  m.stopGitBroker('sess-1')
  assert.ok(await awaitRefused(Number(u1.port)), 'the session broker stops listening')
  m.stopGitBroker('sess-1')
  m.stopGitBroker('never-started')
})

test('restarting a session broker invalidates its old token', async () => {
  // A restart mints a fresh token and port: the old descriptor, if it ever
  // escaped into a stale container env, addresses nothing.
  b1b = await m.resolveGitBroker('sess-1', GH_REPO)
  started.push('sess-1')
  assert.notEqual(b1b.url, b1.url, 'a restarted broker is a new token on a new port')
  const stale = await request(`${reachable(b1b.url).replace(new URL(b1b.url).pathname, '')}/git/${token1}/credential`, {
    method: 'POST',
    body: fill({ protocol: 'https', host: 'github.com' })
  })
  assert.equal(stale.status, 404, 'the old token is worthless against the new broker')
})

// ==========================================================================
// Nothing above reached the log
// ==========================================================================
test('no secret, no bearer token and no fill content in gurt.log', () => {
  m.flushSync()
  const logFile = path.join(GURT_ROOT, 'logs', 'gurt.log')
  const gurtLog = fs.readFileSync(logFile, 'utf8')
  const lines = gurtLog.split('\n').filter(Boolean)

  // The assertion is only worth something if these brokers logged at all.
  const brokerLines = lines.filter((l) => /\[(gitbroker|hostcredbroker)\]/.test(l))
  assert.ok(
    brokerLines.some((l) => l.includes('gitbroker.start')),
    'the session broker traces its start'
  )
  assert.ok(
    brokerLines.some((l) => l.includes('gitbroker.stop')),
    'the session broker traces its stop'
  )
  assert.ok(
    brokerLines.some((l) => l.includes('hostcredbroker.start')),
    'the host broker traces its start'
  )
  assert.ok(brokerLines.some((l) => l.includes(`"port":${u1.port}`)), 'the port is logged')

  for (const secret of ALL_SECRETS)
    assert.ok(!gurtLog.includes(secret), 'no stored secret is anywhere in gurt.log')
  // Not merely redacted — nothing secret-shaped ever reached a broker record.
  // (log.ts redacts stored secrets by value, so the check above would pass even
  // on a leak; this one fails on the leak that redaction papered over.)
  const redacted = brokerLines.filter((l) => l.includes('[redacted]'))
  assert.deepEqual(redacted, [], 'no broker record had to be redacted')

  // The bearer token is NOT a registered secret, so this is a live assertion:
  // the URL's path is what authorizes a fill, and only its port may be logged.
  for (const [what, token] of [
    ['a session broker token', token1],
    ['a restarted broker token', new URL(b1b.url).pathname.slice('/git/'.length)],
    ['the host broker token', new URL(hostBroker.url).pathname.slice('/host/'.length)]
  ]) {
    assert.ok(!gurtLog.includes(token), `${what} never reaches gurt.log`)
    assert.ok(!gurtLog.includes(`/git/${token}`), `${what}'s URL never reaches gurt.log`)
  }
  // …and neither does anything a fill body carried.
  assert.ok(!gurtLog.includes('PLANTED'), 'nothing from a fill body reaches gurt.log')
})
