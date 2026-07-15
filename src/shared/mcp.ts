// MCP registry — pure data, shared by main and renderer.
//
// Each MCP server here runs on the *host* (inside gurt's main process) and is
// reached by the in-container agent over HTTP via `host.docker.internal`. This
// keeps host credentials (git ssh key, gh login) out of the container.

export interface McpToolInfo {
  name: string
  /** Mutates the repo or its remote — omitted from the agent in read-only mode. */
  write: boolean
  summary: string
}

export interface McpDef {
  id: string
  label: string
  description: string
  /** Tools exposed to the agent; write tools are dropped in read-only mode. */
  tools: McpToolInfo[]
}

export const MCP_DEFS: McpDef[] = [
  {
    id: 'github',
    label: 'github',
    description: 'Pull, push and open pull requests on the host using your system git/gh auth.',
    tools: [
      { name: 'git_pull', write: false, summary: 'Fast-forward pull the current branch' },
      { name: 'git_push', write: true, summary: 'Push the current branch to origin' },
      { name: 'create_pull_request', write: true, summary: 'Open a pull request via gh' }
    ]
  }
]

export const mcpDef = (id: string): McpDef | undefined => MCP_DEFS.find((m) => m.id === id)
