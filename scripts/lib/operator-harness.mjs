// Shared setup for the operator write-surface tests
// (scripts/held-fields.test.mjs, scripts/credential-boundary.test.mjs): a
// throwaway GURT_ROOT seeded by the caller, the real kernel and admin surface
// bundled from src/, an operator session with auto-allow on, and that
// session's `gurt` MCP server driven over real HTTP — the shape
// admin-surface.test.mjs uses for the read half.
import { bundle } from './bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

/**
 * @param {string} name   temp-dir prefix
 * @param {(root: string) => void} seed   writes the initial ~/.gurt contents
 */
export async function operatorHarness(name, seed) {
  const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `gurt-${name}-`))
  process.env.GURT_ROOT = GURT_ROOT
  process.env.GURT_FORCE_PLAINTEXT = '1'
  seed(GURT_ROOT)
  // The seeded config is the user's: journal it as a UI baseline, so the
  // journal oracle never reads the fixture as an operator change.
  {
    const git = (...a) =>
      execFileSync('git', ['-C', GURT_ROOT, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a])
    git('init', '-q')
    for (const f of ['agents.json', 'w/workspace.json'])
      if (fs.existsSync(path.join(GURT_ROOT, f))) git('add', f)
    git('commit', '-q', '--no-verify', '--author', 'gurt-ui <user@gurt.local>', '-m', 'seed')
  }

  const outfile = path.join(os.tmpdir(), `gurt-${name}-${process.pid}.mjs`)
  await bundle({
    stdin: {
      contents:
        `export { createKernel } from ${S('src/main/kernel.ts')}\n` +
        `export { createAdminSurface } from ${S('src/main/adminSurface.ts')}\n` +
        `export { buildGurtHttpServer } from ${S('src/main/mcp/gurtServer.ts')}\n`,
      resolveDir: ROOT,
      loader: 'ts',
      sourcefile: 'entry.ts'
    },
    external: ['electron'],
    outfile
  })
  const m = await import(pathToFileURL(outfile).href)

  const kernel = m.createKernel()
  await kernel.ready
  const admin = m.createAdminSurface(kernel)

  // An operator configured exactly as a real one will be (§4.4(b)):
  // auto-allow on.
  const op = kernel.sessions.createSession(
    { workspace: 'w', task: 't', env: 'operator' },
    [], 'a1', 'configure things', 'draft', [], true, {}, 'operator'
  )

  const TOKEN = 'test-token'
  const server = m.buildGurtHttpServer(TOKEN, {
    role: 'operator',
    onComplete: () => {},
    onCreateSession: async () => ({ sessionId: 'x', title: 'x' }),
    admin: admin.bind('w', op.id)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/mcp/${TOKEN}`

  let id = 0
  /** Call a tool; returns { isError, text, json }. */
  async function call(toolName, args = {}) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: toolName, arguments: args } })
    })
    const body = await res.json()
    if (body.error) return { isError: true, text: body.error.message ?? '', json: undefined }
    const text = (body.result.content ?? []).map((c) => c.text).join('\n')
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return { isError: body.result.isError === true, text, json }
  }

  /** The current revision of one entity, read the way the agent reads it. */
  async function rev(entity) {
    const r = await call('get_revisions', { entities: [entity] })
    if (r.isError) throw new Error(r.text)
    return r.json[entity]
  }

  const workspace = () => JSON.parse(fs.readFileSync(path.join(GURT_ROOT, 'w', 'workspace.json'), 'utf8'))
  const agents = () => JSON.parse(fs.readFileSync(path.join(GURT_ROOT, 'agents.json'), 'utf8'))

  /** Resolves with the next gurt confirmation raised in the operator's
   *  timeline (polling — the entry lands asynchronously inside the tool call).
   *  Each is returned once: a cancelled one keeps no `chosen`, and must not be
   *  mistaken for the next. */
  const seen = new Set()
  async function nextConfirmation() {
    for (let i = 0; i < 200; i++) {
      const entries = kernel.sessions.snapshot(op.id)?.entries ?? []
      const e = entries.find((x) => x.kind === 'permission' && x.detail && !x.chosen && !seen.has(x.id))
      if (e) {
        seen.add(e.id)
        return e
      }
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error('no confirmation was raised')
  }

  /** The user editing workspace.json by hand, journaled as the UI would be —
   *  so the journal oracle attributes it to them, not to the next operator
   *  commit that would otherwise sweep it up. */
  function userEdit(mutate) {
    const ws = workspace()
    mutate(ws)
    fs.writeFileSync(path.join(GURT_ROOT, 'w', 'workspace.json'), JSON.stringify(ws))
    const git = (...a) => execFileSync('git', ['-C', GURT_ROOT, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a])
    if (!fs.existsSync(path.join(GURT_ROOT, '.git'))) return
    git('add', '-A')
    git('commit', '-q', '--no-verify', '--allow-empty', '--author', 'gurt-ui <user@gurt.local>', '-m', 'user edit')
  }

  function close() {
    server.close()
    server.closeAllConnections()
    fs.rmSync(outfile, { force: true })
    fs.rmSync(GURT_ROOT, { recursive: true, force: true })
  }

  return { GURT_ROOT, kernel, admin, op, call, rev, workspace, agents, nextConfirmation, userEdit, close }
}
