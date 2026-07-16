# Requirements: kernel extraction + typed IPC

Status: draft for review · Owner: klerik3d · Target: gurt Electron PoC (this repo)

This document is a work order for an implementing agent. Read `README.md`
first. Key code: `src/main/ipc.ts` (everything moves out of here),
`src/main/{sessions,provision,store,changes}.ts`, `src/preload/*`,
`src/shared/types.ts`. Do not change the contract described here without
asking the owner. Depends on: `requirements-stable-keys.md` (merged first).

## 1. Motivation

`ipc.ts` is simultaneously the composition root, the env-lifecycle manager
(module-level `ensureInFlight`, idle timers, `gitShimsInstalled`), and the
IPC router — all interleaved with `broadcast()` to BrowserWindows. The core
is therefore only callable through the UI. Planned consumers (orchestrator,
inter-agent messaging, headless runs, extensions) need a UI-independent
core API. Separately, every IPC method is hand-duplicated in 4 places
(handle / preload / api.d.ts / renderer).

## 2. Electron-free core

Rule: only `src/main/index.ts` and `src/main/ipc.ts` may import from
`electron`. Check: `grep -rln "from 'electron'" src/main` → exactly those
two files.

- `changes.ts` currently imports `shell`. Replace `openPr` with
  `prUrl(ws, task, repo): Promise<string>` (throws the same "origin is not
  a known forge remote" error when unknown); `shell.openExternal(url)`
  moves to the IPC layer. `openInVscode` keeps its `spawn` (no electron
  dependency).

## 3. EnvManager — `src/main/envs.ts`

One class owning everything env-lifecycle, moved verbatim from `ipc.ts`
(logic changes are out of scope):

```ts
export interface EnvManagerDeps {
  /** SessionManager, resolved lazily — mutual dependency, wired in kernel.ts. */
  sessions(): SessionManager
  log(key: string, line: string): void      // provision-log stream
  changed(): void                            // tree-shape / env-status changed
}

export class EnvManager {
  constructor(deps: EnvManagerDeps)
  ensureRunning(ref: EnvRef): Promise<EnvState>   // was ensureEnvRunning, keeps in-flight dedup
  start(ref: EnvRef): Promise<void>
  stop(ref: EnvRef): Promise<void>                // was stopEnv (incl. broker/shims/idle cleanup)
  remove(ref: EnvRef): Promise<void>              // was deleteEnv
  status(ref: EnvRef): Promise<EnvStatus>
  find(ref: EnvRef): Promise<EnvState | undefined>
  resolveEnv(ref: EnvRef, agentId: string, gitAccess: boolean): Promise<EnvContext>
  installAdapter(ref: EnvRef, ctx: EnvContext): Promise<void>
  teardownTask(ws: string, task: string): Promise<void>  // env half of deleteTask
  noteActive(ref: EnvRef): void               // was cancelIdleStop
  noteIdle(ref: EnvRef): void                 // was scheduleIdleStop (30s auto-stop)
}
```

Module-level state (`ensureInFlight`, `idleTimers`, `gitShimsInstalled`,
`ENV_IDLE_STOP_MS`) becomes instance state.

## 4. Kernel — `src/main/kernel.ts`

Composition root, importable without an Electron app:

```ts
/** Temporary seam; replaced by the event bus in requirements-event-bus.md. */
export interface KernelEvents {
  treeChanged(): void
  sessionChanged(snap: SessionSnapshot): void
  provisionLog(e: { key: string; line: string }): void
}

export interface Kernel {
  envs: EnvManager
  sessions: SessionManager
  tree(): Promise<Tree>                       // store.buildTree + session overlay
  deleteTask(ws: string, task: string): Promise<void>
  taskDirtyRepos(ws: string, task: string): Promise<string[]>
}

export function createKernel(events: KernelEvents): Kernel
```

`createKernel` wires SessionManager's `SessionEvents` (unchanged interface)
to EnvManager/store/mcp/git exactly as `ipc.ts` does today, and runs
`restoreSessions()` fire-and-forget. Store/changes/credentials functions
stay plain module imports — no need to hang them on `Kernel`.

## 5. Typed IPC — `src/shared/api.ts`

One source of truth for the renderer-facing API:

```ts
export interface GurtApi {
  // every method window.gurt has today, same names, same signatures
  getTree(): Promise<Tree>
  getMcpDefs(): Promise<McpDef[]>
  // … (transcribe all of src/preload/index.ts)
  changesOpenPr(ws: string, task: string, repo: string): Promise<void> // impl: prUrl + shell.openExternal
}

/** Runtime list; compile-checked to cover GurtApi exactly. */
export const API_METHODS: readonly (keyof GurtApi)[]

export interface GurtEvents {
  'tree-changed': void
  'session-changed': SessionSnapshot
  'provision-log': { key: string; line: string }
}
```

- main (`ipc.ts`): build `const impl: GurtApi` over the kernel; register
  `for (const m of API_METHODS) ipcMain.handle('api:' + m, (_e, ...a) => impl[m](...a))`.
- preload: `for (const m of API_METHODS) api[m] = (...a) => ipcRenderer.invoke('api:' + m, ...a)`;
  keep the three named subscription wrappers (`onTreeChanged`,
  `onSessionChanged`, `onProvisionLog`) implemented over `GurtEvents`
  channel names, so the **renderer is not touched in this slice**.
- `src/preload/api.d.ts` shrinks to declaring `window.gurt` from
  `GurtApi` + the three wrappers.

After the slice `ipc.ts` contains only: `createKernel` call with
broadcasting `KernelEvents`, the `impl` map, handler registration.
Target ≤ ~100 lines.

## 6. Non-goals

- Event bus (next slice), chat-log format, scheduler changes, any behavior
  or UI change, redesigning method signatures (session:create keeps its 7
  positional args).

## 7. Acceptance

1. Full smoke suite passes unchanged (`smoke.mjs` … `smoke8.mjs`,
   `git-logic.test.mjs`).
2. `grep -rln "from 'electron'" src/main` → `index.ts`, `ipc.ts` only.
3. `ipc.ts` no longer contains env-lifecycle state or logic.
4. Renderer source is byte-identical (except imports if types moved).
