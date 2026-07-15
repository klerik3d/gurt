import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { McpMode } from '../../shared/types'

const pexec = promisify(execFile)

/** A tool result the SDK understands. */
type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

/**
 * gurt's main process is launched from the GUI, whose PATH often lacks the
 * Homebrew/usr-local dirs where `git`/`gh` live. Augment it so the tools resolve.
 */
function hostEnv(): NodeJS.ProcessEnv {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin']
  const path = [process.env.PATH, ...extra].filter(Boolean).join(':')
  return { ...process.env, PATH: path }
}

/** Run a host command in the clone and flatten stdout+stderr into a tool result. */
async function runTool(cmd: string, args: string[], cwd: string): Promise<ToolResult> {
  try {
    const { stdout, stderr } = await pexec(cmd, args, {
      cwd,
      env: hostEnv(),
      maxBuffer: 10 * 1024 * 1024
    })
    const text = [stdout, stderr].map((s) => s.trim()).filter(Boolean).join('\n') || `${cmd} ok`
    return { content: [{ type: 'text', text }] }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    const text =
      [err.stdout, err.stderr, err.message].map((s) => s?.trim()).filter(Boolean).join('\n') ||
      'command failed'
    return { content: [{ type: 'text', text }], isError: true }
  }
}

/**
 * Server-level guidance the client surfaces to the model. It steers the agent
 * to these tools for anything touching `origin`, because the container has no
 * git credentials — a shell `git pull`/`git push`/`gh` would fail — while these
 * tools run on the host with the user's real auth. Delivered through MCP init,
 * so nothing is written into the clone or shown to the user.
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
    'Do NOT run git or gh in the shell for remote operations: this container has ' +
    'no credentials for origin, so shell `git pull`/`git push`/`gh pr create` will ' +
    'fail. These tools run on the host with the real auth. Shell git is still fine ' +
    'for purely local work (status, diff, add, commit, branch).' +
    writeNote
  )
}

/** Build the MCP server for one clone; write tools are only registered in full mode. */
function makeMcpServer(dir: string, mode: McpMode): McpServer {
  const server = new McpServer(
    { name: 'gurt-github', version: '0.1.0' },
    { instructions: serverInstructions(mode) }
  )

  server.registerTool(
    'git_pull',
    {
      description:
        'Fast-forward pull the current branch from origin. Use this instead of a ' +
        'shell `git pull`, which has no credentials here and will fail.'
    },
    () => runTool('git', ['-C', dir, 'pull', '--ff-only'], dir)
  )

  if (mode === 'full') {
    server.registerTool(
      'git_push',
      {
        description:
          'Push the current branch to origin, setting upstream. Use this instead of ' +
          'a shell `git push`, which has no credentials here and will fail.'
      },
      () => runTool('git', ['-C', dir, 'push', '-u', 'origin', 'HEAD'], dir)
    )
    server.registerTool(
      'create_pull_request',
      {
        description:
          'Push the current branch to origin and open a GitHub pull request with the ' +
          'gh CLI. Use this instead of a shell `git push` + `gh pr create`, which have ' +
          'no credentials here and will fail.',
        inputSchema: {
          title: z.string().describe('Pull request title'),
          body: z.string().optional().describe('Pull request body (markdown)')
        }
      },
      async ({ title, body }) => {
        const push = await runTool('git', ['-C', dir, 'push', '-u', 'origin', 'HEAD'], dir)
        if (push.isError) return push
        // `gh` infers head from the current branch and base from the repo default.
        return runTool('gh', ['pr', 'create', '--title', title, '--body', body ?? ''], dir)
      }
    )
  }

  return server
}

/**
 * An http.Server exposing the github MCP for `dir` at `/mcp/<token>`. Stateless:
 * a fresh MCP server + transport per POST, so no per-session bookkeeping. The
 * token guards the endpoint, which must bind a container-reachable interface.
 */
export function buildGithubHttpServer(dir: string, mode: McpMode, token: string): Server {
  const prefix = `/mcp/${token}`
  return createServer(async (req, res) => {
    if (!req.url || !req.url.startsWith(prefix)) {
      res.writeHead(404).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    try {
      const server = makeMcpServer(dir, mode)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req, res)
    } catch (e) {
      console.error('[mcp github]', e)
      if (!res.headersSent) res.writeHead(500).end()
    }
  })
}
