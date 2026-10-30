// The ACP client methods gurt answers for a masking session (fs/*, terminal/*;
// docs/requirements-pii-mask.md §9), without a container or an agent: the
// handlers are given an `exec` that runs the argv locally, so what is verified
// is the barrier itself — what the agent is handed is encoded, what it sends is
// revealed — over real files and real processes.
//
//   node scripts/acp-client.test.mjs
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-acp-client-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await build({
  stdin: {
    contents:
      `export { createAcpClient } from ${S('src/main/acpClient.ts')}\n` +
      `export { RpcError } from ${S('src/main/jsonrpc.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  mainFields: ['module', 'main'],
  outfile,
  logLevel: 'silent'
})
const m = await import(pathToFileURL(outfile).href)

/** The error is an RpcError carrying this JSON-RPC code. */
const isRpc = (e, code) => e instanceof m.RpcError && 'code' in e && e.code === code

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-acp-client-'))
const REAL = 'jane@example.com'
const TOKEN = '[email:1]'

let encodeFails = false
const calls = []
const client = m.createAcpClient({
  session: 's1',
  agent: 'test',
  cwd: dir,
  // The container is the local machine here: same argv, same env.
  exec: (argv, env) =>
    spawn(argv[0], argv.slice(1), { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] }),
  encode: async (text) => {
    calls.push(text)
    if (encodeFails) throw new Error('detector is down')
    return text.split(REAL).join(TOKEN)
  },
  reveal: (text) => text.split(TOKEN).join(REAL)
})
const h = client.handlers
const file = (name) => path.join(dir, name)

// --- fs/read_text_file: what the agent is handed is encoded ------------------
fs.writeFileSync(file('a.txt'), `line1\nmail ${REAL}\nline3\n`)
{
  const r = await h['fs/read_text_file']({ sessionId: 'x', path: file('a.txt') })
  assert.equal(r.content, `line1\nmail ${TOKEN}\nline3\n`, 'the real value never reaches the agent')
  assert.ok(!r.content.includes(REAL))

  const part = await h['fs/read_text_file']({ sessionId: 'x', path: file('a.txt'), line: 2, limit: 1 })
  assert.equal(part.content, `mail ${TOKEN}`, 'line/limit select a window (1-based)')

  const rel = await h['fs/read_text_file']({ sessionId: 'x', path: 'a.txt' })
  assert.equal(rel.content, r.content, 'a relative path resolves against the agent cwd')
}

// A missing file is ACP's "resource not found", not a generic failure.
await assert.rejects(
  h['fs/read_text_file']({ sessionId: 'x', path: file('nope.txt') }),
  (e) => isRpc(e, -32002)
)
await assert.rejects(h['fs/read_text_file']({ sessionId: 'x' }), (e) => isRpc(e, -32602), 'bad params')

// Fail closed: a detector that is down must not turn into cleartext.
encodeFails = true
await assert.rejects(h['fs/read_text_file']({ sessionId: 'x', path: file('a.txt') }), /detector is down/)
encodeFails = false

// --- fs/write_text_file: what the agent sends is revealed --------------------
{
  const res = await h['fs/write_text_file']({
    sessionId: 'x',
    path: file('sub/dir/b.txt'),
    content: `to: ${TOKEN}\n`
  })
  assert.equal(res, null)
  assert.equal(
    fs.readFileSync(file('sub/dir/b.txt'), 'utf8'),
    `to: ${REAL}\n`,
    'tokens become the real value on disk, parent directories are created'
  )

  // The full round trip an editor-style agent does: read, change one line, write
  // back. Everything it did not touch comes back byte-identical.
  const read = await h['fs/read_text_file']({ sessionId: 'x', path: file('a.txt') })
  await h['fs/write_text_file']({
    sessionId: 'x',
    path: file('a.txt'),
    content: read.content.replace('line1', 'LINE1')
  })
  assert.equal(fs.readFileSync(file('a.txt'), 'utf8'), `LINE1\nmail ${REAL}\nline3\n`)
}

// Content with no token and an unknown token both pass through untouched.
await h['fs/write_text_file']({ sessionId: 'x', path: file('c.txt'), content: 'plain [email:99]\n' })
assert.equal(fs.readFileSync(file('c.txt'), 'utf8'), 'plain [email:99]\n')

// --- terminal/*: command in, output out --------------------------------------
const waitExit = (terminalId) => h['terminal/wait_for_exit']({ sessionId: 'x', terminalId })
const outputOf = (terminalId) => h['terminal/output']({ sessionId: 'x', terminalId })

{
  // Tokens in the command line and in env are revealed before anything runs;
  // the output that comes back is encoded again.
  const { terminalId } = await h['terminal/create']({
    sessionId: 'x',
    command: 'echo',
    args: [`hello ${TOKEN}`]
  })
  assert.deepEqual(await waitExit(terminalId), { exitCode: 0, signal: null })
  const out = await outputOf(terminalId)
  assert.equal(out.output, `hello ${TOKEN}\n`)
  assert.equal(out.truncated, false)
  assert.deepEqual(out.exitStatus, { exitCode: 0, signal: null })
  await h['terminal/release']({ sessionId: 'x', terminalId })
  await assert.rejects(outputOf(terminalId), (e) => isRpc(e, -32002), 'a released terminal is gone')
}

{
  // A whole command line with no args goes through a shell; cwd and env apply;
  // a non-zero exit is reported, not thrown.
  const { terminalId } = await h['terminal/create']({
    sessionId: 'x',
    command: 'pwd; echo "$WHO"; exit 3',
    cwd: path.join(dir, 'sub'),
    env: [{ name: 'WHO', value: TOKEN }]
  })
  assert.deepEqual(await waitExit(terminalId), { exitCode: 3, signal: null })
  const out = await outputOf(terminalId)
  assert.equal(out.output, `${fs.realpathSync(path.join(dir, 'sub'))}\n${TOKEN}\n`)
}

{
  // A running process has a half-written last line; only whole lines go to the
  // detector, so half a value is never shown to the agent.
  const { terminalId } = await h['terminal/create']({
    sessionId: 'x',
    command: 'sh',
    args: ['-c', `printf 'first\\njane@exa'; sleep 0.4; printf 'mple.com\\n'`]
  })
  await new Promise((r) => setTimeout(r, 150))
  const mid = await outputOf(terminalId)
  assert.equal(mid.output, 'first\n', 'the unfinished line is held back')
  assert.equal(mid.exitStatus, undefined)
  await waitExit(terminalId)
  assert.equal((await outputOf(terminalId)).output, `first\n${TOKEN}\n`)
}

{
  // The output limit keeps the tail (ACP: truncate from the beginning).
  const { terminalId } = await h['terminal/create']({
    sessionId: 'x',
    command: 'sh',
    args: ['-c', 'printf 0123456789'],
    outputByteLimit: 4
  })
  await waitExit(terminalId)
  const out = await outputOf(terminalId)
  assert.equal(out.output, '6789')
  assert.equal(out.truncated, true)
}

{
  // kill stops it; the terminal stays readable until released.
  const { terminalId } = await h['terminal/create']({ sessionId: 'x', command: 'sleep', args: ['30'] })
  await h['terminal/kill']({ sessionId: 'x', terminalId })
  const status = await waitExit(terminalId)
  assert.ok(status.signal || status.exitCode !== 0, 'killed, not finished')
  await h['terminal/release']({ sessionId: 'x', terminalId })
}

// A command that cannot even start is an exit, not an unhandled error.
{
  const { terminalId } = await h['terminal/create']({
    sessionId: 'x',
    command: 'definitely-not-a-command-gurt',
    args: ['x']
  })
  const status = await waitExit(terminalId)
  assert.notEqual(status.exitCode, 0)
}

// dispose() stops what is still running.
{
  const { terminalId } = await h['terminal/create']({ sessionId: 'x', command: 'sleep', args: ['30'] })
  client.dispose()
  await assert.rejects(outputOf(terminalId), (e) => isRpc(e, -32002))
}

fs.rmSync(dir, { recursive: true, force: true })
fs.rmSync(outfile, { force: true })
console.log('acp-client.test.mjs: ok')
