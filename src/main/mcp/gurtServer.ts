import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type {
  AcpHttpMcpServer,
  AgentSessionRequest,
  ChangeProposal,
  EnvRef,
  SessionRole
} from '../../shared/types'
import { roleHasTurnContract, spawnableRoles } from '../../shared/types'
import { createLogger } from '../log'

const log = createLogger('mcp')

/**
 * The turn contract: every turn ends with the agent calling `complete` on this
 * server, reporting the proposed commit/PR texts (or that there is nothing to
 * ship / it is blocked). Delivered through MCP init, so nothing is written into
 * the clone or shown to the user in chat.
 */
const EXECUTOR_INSTRUCTIONS =
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
 * A researcher reads and explains; it has no deliverable, so no turn contract
 * either (docs/requirements-session-roles.md §2). What it *can* do is hand work
 * to somebody else — as an inert draft the user launches.
 */
const RESEARCHER_INSTRUCTIONS =
  'You are a RESEARCH session. Every repository is mounted read-only and you\n' +
  'hold no lock on any working tree — chat is your only output format.\n' +
  'Answer in chat: there is nothing to ship, and no `complete` tool to call.\n' +
  'Do not try to edit files, commit, push, or open pull requests — the mount\n' +
  'itself refuses writes.\n' +
  'Hand work off instead of doing it: `create_session` drafts a fully\n' +
  'configured executor (to make a change) or reviewer (to judge one) in this\n' +
  'same task — or, when something surfaces that is beyond this task\'s scope,\n' +
  'in a separate task named via `task` (created on the spot if missing), so\n' +
  'the current discussion stays on topic. A draft never runs by itself — the\n' +
  'user reviews, edits and launches it — so draft freely, and never wait for\n' +
  'one: no result comes back to you.'

/**
 * A reviewer judges one clone's uncommitted changes while holding its lock, so
 * the tree it reads is exactly the tree the user would commit. The verdict is
 * plain prose on purpose: it gates nothing (§2).
 */
const REVIEWER_INSTRUCTIONS =
  'You are a REVIEW session. The repository is mounted read-only, and while\n' +
  'you run nothing else may touch its working tree: the uncommitted changes\n' +
  'you see are exactly what the user would commit.\n' +
  'Judge those changes against the requirements in your prompt and deliver\n' +
  'the verdict as your plain chat reply — what is wrong, where, how severe.\n' +
  'There is no `complete` tool and no structured verdict; nothing is gated on\n' +
  'you, whether to commit anyway is always the user\'s call.\n' +
  'Do not edit, commit, push, or open pull requests. When fixes are needed,\n' +
  'call `create_session` to draft an executor for this same clone with the\n' +
  'findings spelled out in its prompt. That draft only runs once the user\n' +
  'launches it, and your session keeps the clone locked until the user stops\n' +
  'or deletes it — so never wait for the fixer.'

/** Server `instructions` for a session of this role, delivered via MCP init. */
export function instructionsFor(role: SessionRole): string {
  if (role === 'researcher') return RESEARCHER_INSTRUCTIONS
  if (role === 'reviewer') return REVIEWER_INSTRUCTIONS
  return EXECUTOR_INSTRUCTIONS
}

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

/**
 * Strict schema for `create_session`, with the offered `role` narrowed to what
 * the *calling* session may draft — a reviewer only ever drafts the executor
 * that fixes its findings, so `role` is a single-value enum there and the model
 * cannot even express anything else. Exactly one repo: no role that may be
 * drafted is allowed more than one (only a researcher is, and no role may draft
 * a researcher). Only a researcher's schema carries `task` — a reviewer's draft
 * must fix the clone it holds, and that clone lives in the reviewer's own task.
 * Everything omitted is inherited from the calling session, except `env`: that
 * one follows the repo being drafted for, and picking any other container takes
 * an explicit `confirmNonDefaultEnv` — a caller running somewhere ad hoc must
 * not be able to spread that container by simply not thinking about it.
 */
function createSessionSchema(roles: SessionRole[], crossTask: boolean) {
  return z.strictObject({
    role: z.enum(roles as [SessionRole, ...SessionRole[]]),
    repos: z
      .array(z.string().min(1))
      .length(1)
      .describe('exactly one repo name, as registered in the workspace'),
    prompt: z.string().min(1).describe("the drafted session's start prompt — its whole input"),
    ...(crossTask
      ? {
          task: z
            .string()
            .min(1)
            .optional()
            .describe(
              "task to draft into, created if missing; defaults to this session's task — " +
                "use it to spin work outside this task's scope into its own task"
            )
        }
      : {}),
    title: z.string().min(1).max(80).optional().describe('display title, e.g. "fix review findings"'),
    env: z
      .string()
      .min(1)
      .optional()
      .describe(
        "env definition name. OMIT IT unless you have a reason not to: it then resolves to " +
          "the target repo's own default environment, which is where that repo is meant to " +
          'run — NOT to whatever environment this session happens to be running in. Naming ' +
          "any other env requires confirmNonDefaultEnv: true."
      ),
    confirmNonDefaultEnv: z
      .boolean()
      .optional()
      .describe(
        "confirms that `env` deliberately names a container other than the target repo's " +
          'default. Set it only when running this repo somewhere other than its default is ' +
          'the actual intent — if the mismatch is a surprise, drop `env` instead and take ' +
          "the repo's default."
      ),
    agent: z.string().min(1).optional().describe("agent instance id; defaults to this session's"),
    autoAllow: z.boolean().optional().describe('auto-allow the tool calls of the drafted session'),
    skills: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "skill names to mount in the drafted session, from this workspace's registry. " +
          "OMIT IT to inherit this session's own skills, which is usually right. Pass a " +
          'list to narrow or replace them; pass [] for none.'
      ),
    configValues: z
      .record(z.string(), z.union([z.string(), z.boolean()]))
      .optional()
      .describe('agent config picks (model, effort, …) keyed by option id')
  })
}

/** The draft `create_session` produced — echoed back so the agent can name it. */
export interface AgentSessionDraft {
  sessionId: string
  title: string
}

/** What the host does with a tool call; re-resolved on every re-attach so the
 *  server always routes into the live session manager. */
export interface GurtHooks {
  /** Fixed for the life of the session — it decides the tool set below. */
  role: SessionRole
  onComplete: (p: ChangeProposal) => void
  onCreateSession: (req: AgentSessionRequest) => Promise<AgentSessionDraft>
}

/** Build the MCP server for one role: `complete` for an executor,
 *  `create_session` for the roles that fan out, and role-matched instructions. */
function makeMcpServer(hooks: GurtHooks): McpServer {
  const server = new McpServer(
    { name: 'gurt', version: '0.1.0' },
    { instructions: instructionsFor(hooks.role) }
  )
  if (roleHasTurnContract(hooks.role))
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
        hooks.onComplete(input)
        return { content: [{ type: 'text' as const, text: `complete: ${input.outcome} recorded` }] }
      }
    )
  const roles = spawnableRoles(hooks.role)
  // Cross-task drafting is the researcher's fan-out only: it locks no clone and
  // may spin out-of-scope work into a task of its own (created if missing).
  const crossTask = hooks.role === 'researcher'
  if (roles.length)
    server.registerTool(
      'create_session',
      {
        description:
          'Draft another session in this task' +
          (crossTask ? ' (or another task, via `task` — created if missing)' : '') +
          ', fully configured, to do work you must not do ' +
          `yourself (allowed roles: ${roles.join(', ')}). The draft does NOT run: the user ` +
          'reviews, edits or launches it, and that is the approval step. Nothing comes back ' +
          'to you — never wait for the session you drafted.',
        inputSchema: createSessionSchema(roles, crossTask)
      },
      async (raw) => {
        // The SDK has already validated `raw` against the schema above; it
        // infers only `{}` from one built at runtime, so name the shape once
        // here instead of asserting at each use.
        const input = raw as AgentSessionRequest
        try {
          const draft = await hooks.onCreateSession(input)
          const where = input.task ? ` in task "${input.task}"` : ''
          return {
            content: [
              {
                type: 'text' as const,
                text: `create_session: drafted ${input.role} "${draft.title}" (${draft.sessionId})${where} — waiting for the user to launch it`
              }
            ]
          }
        } catch (e) {
          // Host-side rules (role gating, unknown repo/env) are not expressible
          // in the schema — report them the same way a schema failure reads, so
          // the agent can correct itself at the tool layer.
          return {
            isError: true,
            content: [
              { type: 'text' as const, text: e instanceof Error ? e.message : String(e) }
            ]
          }
        }
      }
    )
  return server
}

/**
 * An http.Server exposing the `gurt` MCP at `/mcp/<token>`. Stateless: a fresh
 * MCP server + transport per POST. The token guards the endpoint, which binds a
 * container-reachable interface. Mirrors `githubServer.ts`.
 */
export function buildGurtHttpServer(token: string, hooks: GurtHooks): Server {
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
      const server = makeMcpServer(hooks)
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
      log.error('internal.fail', { site: 'mcp-handler', id: 'gurt', err: e })
      if (!res.headersSent) res.writeHead(500).end()
    }
  }
  return createServer((req, res) => void handle(req, res))
}

interface RunningGurt {
  http: Server
  /** Resolves to the ACP descriptor once the server is listening. */
  ready: Promise<AcpHttpMcpServer>
  /** Set once `ready` resolves — the stop log needs the port without re-deriving
   *  it from the descriptor's URL, which carries the session's bearer token. */
  port?: number
  ref: EnvRef
  /** Latest hooks for this session — replaced on re-ensure (re-attach). The
   *  role inside them never changes; a role edit (only possible while the
   *  session is a draft) replaces the whole server instead. */
  hooks: GurtHooks
}

/** One `gurt` server per session (not per env), so proposals are attributed to a
 *  session without trusting the agent to name itself. Keyed by sessionId. */
const running = new Map<string, RunningGurt>()

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    // 0.0.0.0 (not loopback) so the container can reach it via host.docker.internal.
    server.listen(0, '0.0.0.0', () => {
      // The startup reject is done its job; a *runtime* server error after this
      // would otherwise call a settled promise's reject and vanish.
      server.removeListener('error', reject)
      server.on('error', (e) => log.error('internal.fail', { site: 'gurt-server', err: e }))
      resolve((server.address() as AddressInfo).port)
    })
  })
}

/** Ensure the per-session `gurt` server is running; return its ACP descriptor.
 *  The tool set follows `hooks.role`, so a session whose (draft) role has since
 *  changed gets a fresh server rather than the previous role's tools. */
export async function ensureGurtServer(
  ref: EnvRef,
  sessionId: string,
  hooks: GurtHooks
): Promise<AcpHttpMcpServer> {
  const existing = running.get(sessionId)
  if (existing && existing.hooks.role === hooks.role) {
    // Re-attach hands us fresh closures; keep the newest so the server routes
    // to the live session manager.
    existing.hooks = hooks
    existing.ref = ref
    return existing.ready
  }
  if (existing) stopGurtServer(sessionId)
  const token = randomUUID()
  const rec = { ref, hooks } as RunningGurt
  rec.http = buildGurtHttpServer(token, {
    role: hooks.role,
    onComplete: (p) => rec.hooks.onComplete(p),
    onCreateSession: (req) => rec.hooks.onCreateSession(req)
  })
  // The record enters the map before any await, so a concurrent ensure for the
  // same session reuses this server instead of racing a second one into a leak.
  rec.ready = listen(rec.http).then(
    (port): AcpHttpMcpServer => {
      rec.port = port
      log.info('mcp.start', { id: 'gurt', s: sessionId, mode: hooks.role, port })
      return {
        type: 'http',
        name: 'gurt',
        // host.docker.internal resolves to the host from Docker Desktop containers.
        url: `http://host.docker.internal:${port}/mcp/${token}`,
        headers: []
      }
    },
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
  // `close()` only stops new connections — a keep-alive socket would keep the
  // listener alive past the session it served.
  rec.http.closeAllConnections()
  log.info('mcp.stop', { id: 'gurt', s: sessionId, mode: rec.hooks.role, port: rec.port })
  running.delete(sessionId)
}
