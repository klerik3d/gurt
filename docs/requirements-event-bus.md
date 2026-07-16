# Requirements: domain event bus

Status: draft for review · Owner: klerik3d · Target: gurt Electron PoC (this repo)

This document is a work order for an implementing agent. Read `README.md`
first. Key code: `src/main/{kernel,envs,sessions,ipc}.ts`,
`src/renderer/src/App.tsx`. Do not change the contract described here
without asking the owner. Depends on: `requirements-kernel.md` (merged
first).

## 1. Motivation

The only eventing today is two coarse UI channels (`tree-changed`,
`session-changed`). Domain moments are reconstructed by consumers: the
renderer diffs `busy` flags to detect "agent turn ended" (`busyRef` in
`App.tsx`), main hard-wires `checkEnvIdle` into SessionManager. Every
planned subscriber (orchestrator, inter-agent message log, extensions)
would repeat this. The bus is the substrate the future inter-agent
communication layer rides on.

## 2. Event map — `src/shared/events.ts`

Shared, so forwarded events are typed in the renderer too:

```ts
export interface DomainEvents {
  /** Tree-shape change: ws/task/repo CRUD, env status, session list/state. */
  'tree.changed': void
  'env.status': { ref: EnvRef; status: EnvStatus }
  /** User or agent activity on an env — postpones idle auto-stop. */
  'env.activity': { ref: EnvRef }
  'session.state': { sessionId: string; ref: EnvRef; state: SessionState }
  'session.turn': { sessionId: string; ref: EnvRef; phase: 'started' | 'ended' }
  'session.awaiting': { sessionId: string; ref: EnvRef; awaiting: boolean }
  /** Coarse "snapshot changed" — the UI's re-render trigger. */
  'session.changed': { sessionId: string }
  'provision.log': { key: string; line: string }
}
```

## 3. Bus — `src/main/bus.ts`

```ts
export interface Bus {
  emit<K extends keyof DomainEvents>(type: K, payload: DomainEvents[K]): void
  on<K extends keyof DomainEvents>(type: K, fn: (p: DomainEvents[K]) => void): () => void
}
export function createBus(): Bus
```

Synchronous dispatch in subscription order. A throwing handler is caught
and `console.error`-ed; it never breaks the emitter or other handlers.

## 4. Wiring

- `createBus()` in `kernel.ts`; `Kernel` gains `bus: Bus`. The temporary
  `KernelEvents` interface from requirements-kernel.md is **deleted** —
  `createKernel()` takes no events argument.
- **SessionManager**: constructor gains `bus`. `SessionEvents` keeps only
  its capability half (`resolveEnv`, `installAdapter`, `resolveMcpServers`,
  `stopMcpServers`, `envStatus`, `persist`); the notification half
  (`onSessionsChanged`, `onSessionChanged`, `onEnvIdle`, `onEnvActive`) is
  removed. Where those fired, emit: `tree.changed`, `session.changed`,
  `session.state` (on every state transition), `session.turn`
  (started = prompt begins, ended = `runPrompt` finally), `session.awaiting`
  (pendingPermissions 0↔1+), `env.activity` (was `onEnvActive`).
  `checkEnvIdle` is deleted from SessionManager.
- **EnvManager**: emits `env.status` + `tree.changed` on status writes,
  `provision.log` instead of the injected `log`, `env.activity` from
  `activity()` pings. `noteActive`/`noteIdle` stay methods (called by the
  policy below), not events.
- **Idle auto-stop policy** becomes a plain subscriber in `kernel.ts`:
  on `session.turn` phase=ended or `session.awaiting` awaiting=false → if
  `sessions.isEnvIdle(ref)` then `envs.noteIdle(ref)`; on `env.activity`
  or `session.turn` phase=started → `envs.noteActive(ref)`. Behavior must
  match today (30s, re-verified before stop).
- **ipc.ts** forwards bus → renderer channels: `tree.changed` →
  `tree-changed`; `session.changed` → snapshot + `session-changed`;
  `provision.log` → `provision-log`. New forwarded channel in `GurtEvents`:
  `'session-turn': DomainEvents['session.turn']`.
- **App.tsx**: delete `busyRef`; refresh the task's changes on
  `gurt.on('session-turn', …)` with `phase === 'ended'` instead.

## 5. Non-goals

- Persisting events, replay, a renderer-side generic bus, inter-agent
  messages (they ride this bus in a later slice), changing what
  `SessionSnapshot` carries.

## 6. Acceptance

1. Full smoke suite passes unchanged.
2. `App.tsx` contains no busy-diffing; changes panel still refreshes at
   the end of an agent turn (covered by smoke7's post-turn refresh path —
   verify manually if the smoke doesn't exercise it).
3. Idle auto-stop parity: env stops ~30s after the last turn ends; typing
   in the composer postpones it.
4. `grep -rn "onSessionsChanged\|onEnvIdle\|onEnvActive" src` → empty.
