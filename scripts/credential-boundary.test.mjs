// The credential boundary of the operator's write surface
// (docs/requirements-session-operator.md §5.2, acceptance §12 item 5): no
// write sets or changes a `credentialId`, no write changes the `url` of a
// credentialed entity, no create carries a link — each REFUSED (not held),
// with a sentence naming Settings, and the file on disk untouched.
//
//   node --test scripts/credential-boundary.test.mjs
import { test, after } from 'node:test'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { operatorHarness } from './lib/operator-harness.mjs'

const h = await operatorHarness('credb', (root) => {
  fs.mkdirSync(path.join(root, 'w', 't'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'w', 'workspace.json'),
    JSON.stringify({
      repos: [
        { name: 'linked', url: 'https://github.com/o/linked.git', credentialId: 'git-1' },
        { name: 'plain', url: 'https://github.com/o/plain.git' }
      ],
      envs: [],
      mcpServers: [
        { id: 'linear', url: 'https://mcp.linear.app/mcp', credentialId: 'mcp-1' },
        { id: 'open', url: 'https://mcp.example/mcp' },
        { id: 'localcred', kind: 'command', command: '/bin/echo', credentialId: 'mcp-1', credentialEnvVar: 'TOKEN' }
      ]
    })
  )
  fs.writeFileSync(path.join(root, 'w', 't', 'task.json'), JSON.stringify({}))
  fs.writeFileSync(
    path.join(root, 'agents.json'),
    JSON.stringify({ a1: { kind: 'claude-code', label: 'Claude', credentialId: 'agent-1' } })
  )
  fs.writeFileSync(
    path.join(root, 'credentials.json'),
    JSON.stringify({
      credentials: [
        { id: 'git-1', label: 'gh', kind: 'git-token', hosts: ['github.com'], data: { token: 'ghp_aaaaaaaaaaaaaaaaaaaa' } },
        { id: 'mcp-1', label: 'linear', kind: 'mcp-token', hosts: [], data: { secret: 'lin_bbbbbbbbbbbbbbbbbbbb' } },
        { id: 'agent-1', label: 'claude', kind: 'agent-token', hosts: [], data: { secret: 'sk-ccccccccccccccccccc' } }
      ]
    })
  )
})
after(() => h.close())

const wsFile = () => fs.readFileSync(path.join(h.GURT_ROOT, 'w', 'workspace.json'), 'utf8')
const agentsFile = () => fs.readFileSync(path.join(h.GURT_ROOT, 'agents.json'), 'utf8')

/** Call a write and assert it was refused — not held — with Settings named
 *  and nothing on disk changed. */
async function refused(tool, args, entity) {
  const ws = wsFile()
  const agents = agentsFile()
  const r = await h.call(tool, { ...args, rev: await h.rev(entity) })
  assert.ok(r.isError, `${tool} refused: ${r.text}`)
  assert.match(r.text, /refused, not held/)
  assert.match(r.text, /Settings/)
  assert.equal(wsFile(), ws, 'workspace.json untouched')
  assert.equal(agentsFile(), agents, 'agents.json untouched')
  assert.equal(h.admin.writes.pending('w', entity), undefined, 'nothing held either')
}

// --- no create carries a link ---------------------------------------------------

test('add_repo with a credential link is refused', () =>
  refused('add_repo', { repo: { name: 'evil', url: 'https://evil.example/r.git', credentialId: 'git-1' } }, 'repo:evil'))

test('add_mcp_server with a credential link is refused (the attack needing no edit)', () =>
  refused('add_mcp_server', { entry: { id: 'evil', url: 'https://evil.example/mcp', credentialId: 'mcp-1' } }, 'mcp:evil'))

test('set_agents adding an agent with a credential link is refused', () =>
  refused(
    'set_agents',
    { agents: { a1: { kind: 'claude-code', label: 'Claude', credentialId: 'agent-1' }, a2: { kind: 'claude-code', label: 'x', credentialId: 'agent-1' } } },
    'agents'
  ))

// --- no write sets or changes a credentialId --------------------------------------

test('update_repo setting a link on an unlinked repo is refused', () =>
  refused('update_repo', { repo: { name: 'plain', url: 'https://github.com/o/plain.git', credentialId: 'git-1' } }, 'repo:plain'))

test('update_repo clearing a link is refused', () =>
  refused('update_repo', { repo: { name: 'linked', url: 'https://github.com/o/linked.git' } }, 'repo:linked'))

test('update_mcp_server re-linking is refused', () =>
  refused('update_mcp_server', { entry: { id: 'open', url: 'https://mcp.example/mcp', credentialId: 'mcp-1' } }, 'mcp:open'))

test('set_agents re-linking an agent is refused', () =>
  refused('set_agents', { agents: { a1: { kind: 'claude-code', label: 'Claude', credentialId: 'mcp-1' } } }, 'agents'))

// --- no write re-points a credentialed entity --------------------------------------

test('update_repo changing the url of a credentialed repo is refused', () =>
  refused('update_repo', { repo: { name: 'linked', url: 'https://evil.example/linked.git', credentialId: 'git-1' } }, 'repo:linked'))

test('update_mcp_server changing the url of a credentialed entry is refused', () =>
  refused('update_mcp_server', { entry: { id: 'linear', url: 'https://evil.example/mcp', credentialId: 'mcp-1' } }, 'mcp:linear'))

test('update_mcp_server changing what a credentialed local entry runs is refused', () =>
  refused(
    'update_mcp_server',
    { entry: { id: 'localcred', kind: 'command', command: '/bin/cat', credentialId: 'mcp-1', credentialEnvVar: 'TOKEN' } },
    'mcp:localcred'
  ))

test('update_mcp_server changing a credentialed entry’s kind is refused', () =>
  refused('update_mcp_server', { entry: { id: 'linear', kind: 'command', command: '/bin/echo', credentialId: 'mcp-1', credentialEnvVar: 'T' } }, 'mcp:linear'))

// --- and what is still allowed ------------------------------------------------------

test('edits that keep the link and the url go through', async () => {
  const r = await h.call('update_mcp_server', {
    entry: { id: 'linear', label: 'Linear', url: 'https://mcp.linear.app/mcp', credentialId: 'mcp-1' },
    rev: await h.rev('mcp:linear')
  })
  assert.ok(!r.isError, r.text)
  const agents = await h.call('set_agents', {
    agents: { a1: { kind: 'claude-code', label: 'Renamed', credentialId: 'agent-1' } },
    rev: await h.rev('agents')
  })
  assert.ok(!agents.isError, agents.text)
  assert.equal(JSON.parse(agentsFile()).a1.label, 'Renamed')
})

test('re-pointing an unlinked repo is an ordinary edit', async () => {
  const r = await h.call('update_repo', { repo: { name: 'plain', url: 'https://github.com/o/plain2.git' }, rev: await h.rev('repo:plain') })
  assert.ok(!r.isError, r.text)
})

test('no write result carries a credential value', async () => {
  const r = await h.call('get_revisions', {})
  assert.ok(!r.isError, r.text)
  for (const v of ['ghp_aaaaaaaaaaaaaaaaaaaa', 'lin_bbbbbbbbbbbbbbbbbbbb', 'sk-ccccccccccccccccccc'])
    assert.ok(!r.text.includes(v))
})
