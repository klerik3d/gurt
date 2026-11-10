import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { EnvRef, McpMode } from '../../shared/types'
import type { HostGitAccess } from '../git/env'
import { openPullRequest, requireForgeAccess, runHost } from '../git/pullRequest'
import { createLogger } from '../log'

const log = createLogger('mcp')

/** A tool result the SDK understands. */
type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const errorResult = (text: string): ToolResult => ({
  content: [{ type: 'text', text }],
  isError: true
})

/** Run a host command in the clone and flatten stdout+stderr into a tool result
 *  (the shared runner lives in git/pullRequest.ts: the review loop's delivery
 *  runs the same code). */
async function runTool(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<ToolResult> {
  const r = await runHost(cmd, args, cwd, env)
  return { content: [{ type: 'text', text: r.text }], ...(r.ok ? {} : { isError: true }) }
}

/**
 * Resolve the git access for this env's repo at call time, refusing blocked
 * resolutions. Same policy as everywhere in the app: these tools run with the
 * repo's gurt-managed credential, or with ambient host auth only when an
 * explicit `git-host` credential says so — never as a silent fallback.
 */
async function requireGitAccess(ref: EnvRef, repo: string): Promise<HostGitAccess | ToolResult> {
  const got = await requireForgeAccess(ref.workspace, repo)
  return 'error' in got ? errorResult(got.error) : got.access
}

const isToolResult = (v: HostGitAccess | ToolResult): v is ToolResult => 'content' in v

/**
 * Server-level guidance the client surfaces to the model. It steers the agent
 * to these tools for anything touching `origin`, because the container has no
 * git credentials — a shell `git pull`/`git push`/`gh` would fail — while these
 * tools run on the host with the repo's configured credential. Delivered
 * through MCP init, so nothing is written into the clone or shown to the user.
 */
function serverInstructions(mode: McpMode): string {
  const remoteOps =
    mode === 'full'
      ? 'pulling, pushing, and opening pull requests'
      : 'pulling from origin'
  const writeNote =
    mode === 'full'
      ? ''
      : ' This session is read-only: there is no push/PR tool, so do not attempt to publish changes.'
  return (
    `Use these tools for any git operation against origin (${remoteOps}). ` +
    'Do NOT run git or gh in the shell for remote operations: this container never ' +
    'holds credentials for origin and has no way to obtain them, so shell ' +
    '`git pull`/`git push`/`gh pr create` cannot succeed — and `gh` is not installed. ' +
    'These tools are the only authenticated path to origin; they run on the host, on ' +
    'the same clone, with the credential configured for this repo. Shell git is still ' +
    'fine for everything local: status, diff, add, commit, branch, log.' +
    writeNote
  )
}

/** Build the MCP server for one clone; write tools are only registered in full mode. */
function makeMcpServer(ref: EnvRef, repo: string, dir: string, mode: McpMode): McpServer {
  const server = new McpServer(
    { name: 'gurt-github', version: '0.1.0' },
    { instructions: serverInstructions(mode) }
  )

  const gitTool = async (args: string[]): Promise<ToolResult> => {
    const access = await requireGitAccess(ref, repo)
    if (isToolResult(access)) return access
    return runTool('git', ['-C', dir, ...access.gitArgs, ...args], dir, access.env)
  }

  server.registerTool(
    'git_pull',
    {
      description:
        'Fast-forward pull the current branch from origin. Use this instead of a ' +
        'shell `git pull`, which has no credentials here and will fail.'
    },
    () => gitTool(['pull', '--ff-only'])
  )

  if (mode === 'full') {
    server.registerTool(
      'git_push',
      {
        description:
          'Push the current branch to origin, setting upstream. Use this instead of ' +
          'a shell `git push`, which has no credentials here and will fail.'
      },
      () => gitTool(['push', '-u', 'origin', 'HEAD'])
    )
    server.registerTool(
      'create_pull_request',
      {
        description:
          'Push the current branch to origin and open a GitHub pull request with the ' +
          'gh CLI. Use this instead of a shell `git push` + `gh pr create` — this ' +
          'container has no credentials for origin and no gh at all.',
        inputSchema: {
          title: z.string().describe('Pull request title'),
          body: z.string().optional().describe('Pull request body (markdown)')
        }
      },
      async ({ title, body }) => {
        // Push, then `gh pr create`; a local repo is refused before the push
        // (git/pullRequest.ts) — the review loop's delivery calls the same function.
        const r = await openPullRequest(ref.workspace, repo, dir, { title, body })
        return r.ok ? { content: [{ type: 'text', text: r.text }] } : errorResult(r.text)
      }
    )
  }

  return server
}

/**
 * An http.Server exposing the github MCP for `ref`'s clone at `/mcp/<token>`.
 * Stateless: a fresh MCP server + transport per POST, so no per-session
 * bookkeeping; credentials resolve per tool call, so store edits apply live.
 * The token guards the endpoint, which must bind a container-reachable interface.
 */
export function buildGithubHttpServer(
  ref: EnvRef,
  repo: string,
  dir: string,
  mode: McpMode,
  token: string
): Server {
  const prefix = `/mcp/${token}`
  // Sync listener, async handler: node discards a request handler's return
  // value, so an async listener would drop a rejection instead of reporting it.
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!req.url || !req.url.startsWith(prefix)) {
      res.writeHead(404).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    try {
      const server = makeMcpServer(ref, repo, dir, mode)
      // No `sessionIdGenerator` = stateless, which is what a fresh server per
      // POST wants (the SDK reads an absent generator exactly that way).
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
      // The SDK's transport class does not satisfy its own `Transport`
      // interface under exactOptionalPropertyTypes — it declares `onclose?:
      // () => void`, which reads back as `(() => void) | undefined`. The two
      // types are otherwise identical; this is the flag's cost at a
      // third-party boundary, not a widening of ours.
      await server.connect(transport as Transport)
      // Registered only after connect: a client aborting mid-connect would
      // otherwise close the transport under `handleRequest`'s feet. The close
      // promises are caught — a rejection here has nowhere better to go than
      // the log, never the global unhandled-rejection hook.
      res.on('close', () => {
        transport.close().catch(() => {})
        server.close().catch(() => {})
      })
      await transport.handleRequest(req, res)
    } catch (e) {
      log.error('internal.fail', { site: 'mcp-handler', id: 'github', err: e })
      if (!res.headersSent) res.writeHead(500).end()
    }
  }
  return createServer((req, res) => void handle(req, res))
}
