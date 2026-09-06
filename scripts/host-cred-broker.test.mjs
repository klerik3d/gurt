// The host credential broker (§8) and the helper that talks to it, end to end
// over loopback — no docker, no network, no electron.
//
// Since the container-side broker was removed (docs/requirements-mcp-proxy.md
// §10.2) this is the *only* place a stored git secret is ever served, and it is
// reachable only from the host: nothing in a session container knows it exists.
//
// What this file exists to pin down is one sentence: a stored secret leaves the
// main process ONLY as the body of an HTTP response, to a loopback caller that
// already knows the broker's path token AND names the credential it was scoped
// to, and it reaches the process that asked for it without ever passing through
// an argv, an env var or a log line. Everything below is a way of trying to get
// a secret out some other way and asserting that nothing comes back.
//
// The real modules are bundled with esbuild and driven for real:
//   git/hostCredBroker.ts — the broker, reached with node:http on 127.0.0.1;
//   git/env.ts            — the host-side resolution (managed/ambient/blocked);
//   git/shims.ts          — the host credential helper, spawned as an actual
//                           child process and made to fill against the broker.
//
// git-logic.test.mjs already covers config.ts as pure functions; nothing here
// re-asserts those tables, only what the broker does with them.
//
//   node scripts/host-cred-broker.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

// store.ts / log.ts read GURT_ROOT / GURT_LOG at module load — set before the
// bundle is imported. DBG is the loudest the app ever gets: if a secret or a
// broker token can reach the log at all, it reaches it at this level.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-hostcred-'))
process.env.GURT_ROOT = GURT_ROOT
process.env.GURT_LOG = 'debug'

// Distinctive, long enough to be redactable (log.ts's MIN_SECRET_LEN), and
// unlike anything the code produces on its own.
const GH_SECRET = 'ghp-HOST-BROKER-SECRET-1a2b3c4d5e6f'
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

const outfile = path.join(os.tmpdir(), `gurt-hostcred-${process.pid}.mjs`)
await bundle({
  stdin: {
    contents: `
      export { ensureHostCredBroker } from ${S('src/main/git/hostCredBroker.ts')}
      export { hostGitAccess } from ${S('src/main/git/env.ts')}
      export { ensureHostCredHelper, hostCredHelperPath } from ${S('src/main/git/shims.ts')}
      export { BLOCKED_SSH_COMMAND } from ${S('src/main/git/config.ts')}
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

// Bound by one test and read by later ones: node:test runs the tests in a file
// one at a time, in declaration order.
let managed, hostBroker, blocked, r, child

// The host credential broker is a process-lifetime singleton with no teardown
// (by design: it serves every session's host git access until the app quits),
// so its listener would keep this process alive forever. Nothing is pending once
// the tests are done — the log is flushed below — so its handle is unref'd
// rather than exiting explicitly, which would paper over a failing test.
after(() => {
  m.flushSync()
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
  // `_getActiveHandles` is undocumented, but the module never hands the host
  // listener out, so there is no public reference to unref.
  const handles = /** @type {any} */ (process)._getActiveHandles?.() ?? []
  for (const h of handles) if (h?.constructor?.name === 'Server') h.unref()
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
    },
    // §3.2 and the §8 scoping rule, re-checked here and not only in env.ts.
    {
      what: 'an unverified entry (§3.2), handed by id',
      headers: { 'x-gurt-cred-id': 'cred-unverified', 'x-gurt-cred-host': 'gitlab.com' },
      body: fill({ protocol: 'https', host: 'gitlab.com' })
    },
    {
      what: 'an entry whose own hosts do not cover the requested host',
      headers: { 'x-gurt-cred-id': 'cred-gh', 'x-gurt-cred-host': 'gitlab.com' },
      body: fill({ protocol: 'https', host: 'gitlab.com' })
    }
  ]) {
    const res = await request(`${hostBroker.url}/credential`, { method: 'POST', headers, body })
    assert.equal(res.status, 204, `${what} → 204`)
    assert.equal(res.body, '', `${what} serves nothing`)
  }

  // The unverified-entry and out-of-scope-host rows above are the host broker's
  // own echelon, not a restatement of env.ts: unreachable through GURT_CRED_ID
  // (hostGitAccess blocks both before setting it, asserted above), they hold
  // even for a caller that forges the headers outright.

  // The host broker's token gates it exactly like the session one.
  for (const url of [
    `http://127.0.0.1:${hostPort}/credential`,
    `http://127.0.0.1:${hostPort}/host/00000000-0000-4000-8000-000000000000/credential`,
    // The retired container broker's route must not exist here either.
    `http://127.0.0.1:${hostPort}/git/00000000-0000-4000-8000-000000000000/credential`
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
// Nothing above reached the log
// ==========================================================================
test('no secret, no bearer token and no fill content in gurt.log', async () => {
  const logFile = path.join(GURT_ROOT, 'logs', 'gurt.log')
  const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')
  // `flushSync()` is the crash path: it writes what is still *queued*, and a
  // batch already handed to an in-flight async drain is neither queued nor on
  // disk yet. So it is not a barrier — call it to push the queue, then wait on
  // the records themselves. The wait ends on the condition, never on a fixed
  // delay, and the cap is a failure path rather than a timing assumption.
  const hostPort = new URL(hostBroker.url).port
  const TRACES = ['hostcredbroker.start', `"port":${hostPort}`]
  let gurtLog = ''
  for (let i = 0; i < 1000; i++) {
    m.flushSync()
    gurtLog = readLog()
    if (TRACES.every((t) => gurtLog.includes(t))) break
    await new Promise((r) => setTimeout(r, 5))
  }
  const lines = gurtLog.split('\n').filter(Boolean)

  // The assertion is only worth something if the broker logged at all.
  const brokerLines = lines.filter((l) => /\[hostcredbroker\]/.test(l))
  assert.ok(
    brokerLines.some((l) => l.includes('hostcredbroker.start')),
    'the host broker traces its start'
  )
  assert.ok(brokerLines.some((l) => l.includes(`"port":${hostPort}`)), 'the port is logged')

  for (const secret of ALL_SECRETS)
    assert.ok(!gurtLog.includes(secret), 'no stored secret is anywhere in gurt.log')
  // Not merely redacted — nothing secret-shaped ever reached a broker record.
  // (log.ts redacts stored secrets by value, so the check above would pass even
  // on a leak; this one fails on the leak that redaction papered over.)
  const redacted = brokerLines.filter((l) => l.includes('[redacted]'))
  assert.deepEqual(redacted, [], 'no broker record had to be redacted')

  // The bearer token is NOT a registered secret, so this is a live assertion:
  // the URL's path is what authorizes a fill, and only its port may be logged.
  const hostToken = new URL(hostBroker.url).pathname.slice('/host/'.length)
  assert.ok(hostToken.length > 16, 'the token under test is a real one')
  assert.ok(!gurtLog.includes(hostToken), 'the host broker token never reaches gurt.log')
  assert.ok(!gurtLog.includes(`/host/${hostToken}`), "the broker's URL never reaches gurt.log")
  // …and neither does anything a fill body carried.
  assert.ok(!gurtLog.includes('PLANTED'), 'nothing from a fill body reaches gurt.log')
})
