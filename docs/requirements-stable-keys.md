# Requirements: centralized entity keys

Status: draft for review · Owner: klerik3d · Target: gurt Electron PoC (this repo)

This document is a work order for an implementing agent. Read `README.md`
first. Key code: `src/main/sessions.ts`, `src/main/ipc.ts`,
`src/main/mcp/manager.ts`, `src/main/git/broker.ts`,
`src/renderer/src/App.tsx`. Do not change the contract described here
without asking the owner.

## 1. Motivation

The `${ws}/${task}/${repo}` key template is hand-built in 5 files (local
`envKey`/`taskKey`/`connKey`/`serverKey` copies). Names double as disk
paths and as identity. Centralizing key derivation makes a future
name→id migration a one-file change instead of a codebase sweep.

## 2. Decisions

- New `src/shared/keys.ts`:

  ```ts
  export const taskKey = (ws: string, task: string): string    // `${ws}/${task}`
  export const envKey = (ref: EnvRef): string                  // `${ws}/${task}/${repo}`
  export const connKey = (ref: EnvRef, agent: string): string  // `${envKey(ref)}::${agent}` — ACP adapter per (env, agent)
  export const mcpServerKey = (ref: EnvRef, mcpId: string): string // `${envKey(ref)}::${mcpId}`
  ```

- Delete every local key helper and import from `shared/keys`:
  `sessions.ts` (envKey, taskKey, connKey), `ipc.ts` (envKey),
  `mcp/manager.ts` (envKey, serverKey → mcpServerKey),
  `git/broker.ts` (envKey), `App.tsx` (envKey).
- Key formats stay byte-identical to today (the renderer keys its
  provision-log map with `envKey`; persisted data is not keyed).
- Names remain identity and disk path; rename stays unsupported.
- Rule (enforced in review): no inline `${…}/${…}` entity-key templates
  outside `keys.ts`. Check: `grep -rn 'workspace}/' src --include='*.ts*'`
  matches only `keys.ts`.

## 3. Non-goals

- UUIDs for workspace/task/repo, rename support, disk layout changes.

## 4. Acceptance

1. Behavior identical; no persisted-format change.
2. `node scripts/git-logic.test.mjs` passes; `smoke.mjs` and `smoke7.mjs`
   pass (no docker needed).
3. The grep rule above holds.
