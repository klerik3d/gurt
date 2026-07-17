# Design notes: orchestration (pipelines over sessions)

**Status: UNDER DISCUSSION — NOT approved, DO NOT IMPLEMENT.**
This is a record of design conversation, not a work order. No code, no
requirements doc, no partial slices derive from this file until the owner
turns a piece of it into a `requirements-*.md`. The only implemented seam
so far is the turn contract (`requirements-turn-contract.md`) and its
`session.proposal` event.

## Agreed direction (still revisable)

- **Agents never talk to each other.** All inter-stage communication is
  typed artifacts flowing through the kernel: submitted via host MCP tools
  with server-side (zod) validation, stored in the task store, surfaced as
  bus events. First artifacts: `ChangeProposal` (done), `ReviewVerdict`
  (future: `{ verdict: approve | request_changes, findings: [{ file, line?,
  severity, note }] }`).
- **Stage type ≠ stage binding.** A stage *type* is a fixed kernel-level
  contract (input artifacts → output artifact schema). A *binding* is who
  executes it: agent instance, env, model, settings — per-repo/per-task
  config. Formats are hardcoded; executors are swappable.
- **No universal pipeline.** Routes are named templates per task kind —
  e.g. `change`, `pr-review`, `analyze` — few, hardcoded initially, chosen
  at task start. A bare "just chat" session is the `change` template with
  the minimal stage set, not a separate code path. `pr-review` has no ship
  stages at all (input: PR ref, output: `ReviewVerdict`).
- **Pipelines are data**, not compiled programs: a state machine instance
  in the store. Stages can be attached to a live change mid-task ("I want
  a review after all"). Transitions are bus events; the UI renders state.
- **Loops are built-in retry edges, not a workflow language.** No DAGs, no
  conditionals. `review → request_changes → fix → re-review` with a
  `maxRounds` counter. If a general graph is ever needed, that is a later,
  separate decision.
- **Session reuse rule:** continuity of context → same session (executor
  fix rounds ride a follow-up prompt: keeps context, costs no container
  start); independence → new session (reviewer re-review defaults to a
  fresh session to avoid anchoring; configurable for cost). A dead session
  is replaced by a new one rehydrated from artifacts + session log — one
  more reason artifacts live in the store, not in agent context.
- **Multi-repo:** a preparatory step is a parent task; its output spawns N
  independent per-repo pipelines linked only by a parent id. No
  cross-pipeline logic in the kernel.
- **No auto-ship.** Ship stages (commit / push / PR) always sit behind an
  explicit user action — today's Changes panel is exactly that. If
  automation is ever wanted it is a deliberate per-repo opt-in, never a
  template default. Approval gates are explicit stages, not side dialogs.

## Open questions (why this is not a work order yet)

- Final stage-type vocabulary and the initial template set.
- Binding config shape (where it lives: workspace.json? per task?).
- Review gating semantics: blocking vs advisory, `maxRounds` default.
- How `pr-review` gets its input (clone of a foreign branch? read-only
  fetch into the task env?).
- Parent-task UX for multi-repo fan-out.
- Whether the committer stage stays purely deterministic host code or an
  optional agent is ever allowed to hold write credentials.
