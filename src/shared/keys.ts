// Centralized entity-key derivation, shared by main and renderer.
//
// Names double as disk paths and as identity, so the `${ws}/${task}` template
// used to be hand-built in several files. Keeping every derivation here makes a
// future name→id migration a one-file change.
//
// Everything bound to a *container* — the ACP adapter, the MCP servers, the git
// broker, the provisioning log — is keyed by session id and nothing else. That
// is not a naming convention but the invariant the model rests on: a container
// belongs to exactly one session, so a key that outlives the session cannot
// address a container that outlived it either.

export const taskKey = (ws: string, task: string): string => `${ws}/${task}`

/** One host MCP server per (session, mcp id). */
export const mcpServerKey = (sessionId: string, mcpId: string): string =>
  `${sessionId}::${mcpId}`
