import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { AcpHttpMcpServer, ChangeProposal, EnvRef } from '../../shared/types'
import { envKey } from '../../shared/keys'

/**
 * The turn contract: every turn ends with the agent calling `complete` on this
 * server, reporting the proposed commit/PR texts (or that there is nothing to
 * ship / it is blocked). Delivered through MCP init, so nothing is written into
 * the clone or shown to the user in chat.
 */
const GURT_INSTRUCTIONS =
  'Finish EVERY turn by calling the `complete` tool, after all other work:\n' +
  '- outcome "changes" — the working tree contains work to ship. Include the\n' +
  '  exact commit message you propose (subject, optional body) and, when a\n' +
  '  pull request should follow, the PR title/body.\n' +
  '- outcome "no_changes" — this turn produced nothing to ship.\n' +
  '- outcome "blocked" — you cannot finish; give the reason.\n' +
  'Do not commit, push, or open pull requests yourself — leave the working\n' +
  'tree uncommitted and deliver the texts through `complete`; the user\n' +
  'reviews and ships them. (Exception: the user explicitly attached shipping\n' +
  'tools and asked you to use them.)'

/**
 * Strict schema for the `complete` payload. Unknown keys are rejected; the
 * outcome-dependent rules (commit/pr only with `changes`, reason only with
 * `blocked`) run as a `superRefine` — in zod v4 that keeps the schema a plain
 * object, so the SDK still generates a proper JSON schema for `tools/list`. A
 * validation failure surfaces as an `isError` tool result carrying the zod
 * message, and the `onComplete` callback never fires.
 */
const PROPOSAL_SCHEMA = z
  .strictObject({
    version: z.literal(1),
    outcome: z.enum(['changes', 'no_changes', 'blocked']),
    commit: z
      .strictObject({
        subject: z
          .string()
          .min(1)
          .max(120)
          .refine((s) => !s.includes('\n'), 'commit.subject must be a single line'),
        body: z.string().optional()
      })
      .optional(),
    pr: z.strictObject({ title: z.string(), body: z.string().optional() }).optional(),
    reason: z.string().optional(),
    notes: z.string().optional()
  })
  .superRefine((p, ctx) => {
    if (p.outcome === 'changes') {
      if (!p.commit)
        ctx.addIssue({ code: 'custom', message: 'commit is required when outcome is "changes"' })
    } else if (p.commit) {
      ctx.addIssue({ code: 'custom', message: 'commit is only allowed when outcome is "changes"' })
    }
    if (p.outcome !== 'changes' && p.pr)
      ctx.addIssue({ code: 'custom', message: 'pr is only allowed when outcome is "changes"' })
    if (p.outcome === 'blocked') {
      if (!p.reason)
        ctx.addIssue({ code: 'custom', message: 'reason is required when outcome is "blocked"' })
    } else if (p.reason) {
      ctx.addIssue({ code: 'custom', message: 'reason is only allowed when outcome is "blocked"' })
    }
  })

/** Build the single-tool MCP server; a valid call fires `onComplete` and reports success. */
function makeMcpServer(onComplete: (p: ChangeProposal) => void): McpServer {
  const server = new McpServer(
    { name: 'gurt', version: '0.1.0' },
    { instructions: GURT_INSTRUCTIONS }
  )
  server.registerTool(
    'complete',
    {
      description:
        'Report the outcome of this turn. Call it once, last, after all other work. ' +
        'With outcome "changes" propose the commit (and optional PR) texts; with ' +
        '"no_changes" there is nothing to ship; with "blocked" give the reason.',
      inputSchema: PROPOSAL_SCHEMA
    },
    async (input) => {
      // The SDK has already validated `input` against PROPOSAL_SCHEMA.
      onComplete(input as ChangeProposal)
      return { content: [{ type: 'text' as const, text: `complete: ${input.outcome} recorded` }] }
    }
  )
  return server
}

/**
 * An http.Server exposing the `gurt` MCP at `/mcp/<token>`. Stateless: a fresh
 * MCP server + transport per POST. The token guards the endpoint, which binds a
 * container-reachable interface. Mirrors `githubServer.ts`.
 */
export function buildGurtHttpServer(
  token: string,
  onComplete: (p: ChangeProposal) => void
): Server {
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
      const server = makeMcpServer(onComplete)
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
      console.error('[mcp gurt]', e)
      if (!res.headersSent) res.writeHead(500).end()
    }
  })
}

interface RunningGurt {
  http: Server
  /** Resolves to the ACP descriptor once the server is listening. */
  ready: Promise<AcpHttpMcpServer>
  ref: EnvRef
  /** Latest callback for this session — updated on re-ensure (re-attach). */
  onComplete: (p: ChangeProposal) => void
}

/** One `gurt` server per session (not per env), so proposals are attributed to a
 *  session without trusting the agent to name itself. Keyed by sessionId. */
const running = new Map<string, RunningGurt>()

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    // 0.0.0.0 (not loopback) so the container can reach it via host.docker.internal.
    server.listen(0, '0.0.0.0', () => resolve((server.address() as AddressInfo).port))
    server.on('error', reject)
  })
}

/** Ensure the per-session `gurt` server is running; return its ACP descriptor. */
export async function ensureGurtServer(
  ref: EnvRef,
  sessionId: string,
  onComplete: (p: ChangeProposal) => void
): Promise<AcpHttpMcpServer> {
  const existing = running.get(sessionId)
  if (existing) {
    // Re-attach hands us a fresh closure; keep the newest so the server routes
    // to the live session manager.
    existing.onComplete = onComplete
    existing.ref = ref
    return existing.ready
  }
  const token = randomUUID()
  const rec = { ref, onComplete } as RunningGurt
  rec.http = buildGurtHttpServer(token, (p) => rec.onComplete(p))
  // The record enters the map before any await, so a concurrent ensure for the
  // same session reuses this server instead of racing a second one into a leak.
  rec.ready = listen(rec.http).then(
    (port): AcpHttpMcpServer => ({
      type: 'http',
      name: 'gurt',
      // host.docker.internal resolves to the host from Docker Desktop containers.
      url: `http://host.docker.internal:${port}/mcp/${token}`,
      headers: []
    }),
    (e) => {
      if (running.get(sessionId) === rec) running.delete(sessionId)
      throw e
    }
  )
  running.set(sessionId, rec)
  return rec.ready
}

/** Tear down one session's `gurt` server (session deleted). */
export function stopGurtServer(sessionId: string): void {
  const rec = running.get(sessionId)
  if (!rec) return
  rec.http.close()
  running.delete(sessionId)
}

/** Tear down every `gurt` server of an env (env stop/delete). */
export function stopGurtServersForEnv(ref: EnvRef): void {
  const key = envKey(ref)
  for (const [sessionId, rec] of running) {
    if (envKey(rec.ref) !== key) continue
    rec.http.close()
    running.delete(sessionId)
  }
}
