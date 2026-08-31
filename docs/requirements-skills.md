# Requirements: Claude Code skills

Status: implemented · Target: gurt Electron MVP (this repo)

This document is a work order for an implementing agent, and the as-built
record of what landed. It is modelled on the MCP registry
(`requirements-mcp-proxy.md` §3, `requirements-mcp-stdio.md`) on purpose:
a skill is the *second* thing a session picks from a workspace-scoped
registry, and every decision below that could be borrowed from MCP was
borrowed rather than reinvented. Key code: `src/shared/skills.ts` (the
entry model, the frontmatter schema, the validator),
`src/main/store.ts` (the on-disk registry and its CRUD),
`src/main/sessions.ts` (`materializeSkills`, called from `startSession`),
`src/main/provision.ts` / `src/main/containers.ts` (the read-only bind
and the link into the container's home),
`src/renderer/src/useSkills.ts`,
`src/renderer/src/components/ConfigTab.tsx` (the per-draft picker) and
`src/renderer/src/components/SettingsPage.tsx` (the registry editor).

## 1. Motivation

A **skill** is Claude Code's unit of reusable procedure: a directory
holding `SKILL.md` — YAML frontmatter (`name`, `description`) over a
markdown body — plus whatever supporting files it references. Claude
Code loads the descriptions of every skill it can see, and pulls a body
in only when the description matches the task. That "cheap to offer,
expensive only when used" shape is what makes a *set* of them worth
curating.

Today a gurt session sees exactly the skills its repo happens to carry
in `.claude/skills`. Everything a team would want to share across
repositories — a review checklist, a deploy runbook, the house style for
a migration — has nowhere to live, and nothing about a session records
which procedures it was given. Two sessions on the same repo are
indistinguishable in their skill surface, which is precisely the knob a
user reaches for when one of them keeps doing the wrong thing.

So: **a skill is workspace data, picked per session, delivered as
files.** The registry is gurt's; the selection is the session's record of
what the user asked for; the delivery is a read-only bind mount.

## 2. The contract

**gurt's metadata never lands in the working tree.** This is the
invariant everything else here bends around. A skill is stored under
`~/.gurt/<ws>/skills/<name>/`, materialized into the session's own
scratch directory under `~/.gurt/<ws>/<task>/.multirepo/<sessionId>/skills/`,
and mounted into the container from there. No step writes into a clone,
and `git status` in a session's repo is unchanged by this feature
existing.

**The selection is fixed at start.** A draft's skills are editable; a
session that has left `draft` shows them read-only. The files are
already mounted by then, and a picker that pretended otherwise would be
lying about what the agent can see.

**What is not selected is not there.** Delivery is a bind of a directory
gurt materialized, so a skill the user turned off is physically absent
from the container — not merely unmentioned. There is no in-container
switch for the agent to talk itself past.

**It works for every role.** A researcher's repo mounts are read-only
and its `onCreate`/`updateContent`/`postCreate` hooks are stripped
(`provision.ts`, see `requirements-session-roles.md`), so any delivery
mechanism built on lifecycle hooks would silently skip exactly the roles
most likely to want a read-only procedure. A mount runs before any hook
does and does not care whether hooks exist.

## 3. Non-goals

**Skills that live in the repository are not gurt's.** A clone's own
`.claude/skills` is the repo's business: gurt does not list it, does not
merge it into the picker, and — above all — does not disable it. Doing
any of those would mean writing into the working tree, which §2 forbids,
and would make "what skills does this session have" a question with two
different answers depending on who was asked. The picker offers gurt's
registry; the repo offers the repo's; the agent sees the union, and the
union is Claude Code's own composition rule, not something gurt invents.

**No skill authoring beyond a text field.** The Settings editor is a
name and a `SKILL.md` textarea. Supporting files are listed if they are
there (put beside `SKILL.md` by hand) but not edited here.

**No skill marketplace, no fetch-by-URL, no versioning.** A skill is a
directory the user owns.

## 4. The model

### 4.1 On disk

```
~/.gurt/<ws>/skills/<name>/SKILL.md      # required
~/.gurt/<ws>/skills/<name>/<anything>    # optional supporting files
```

`<name>` is the directory name *and* the selection key *and* the
frontmatter's `name` — all three must agree, and the save path rejects a
draft where they do not. `skills` is added to `RESERVED_NAMES.task` in
`store.ts`, so no task may be created that would collide with the
registry directory (the same rule `.devcontainers` already gets).

The registry is the directory listing. There is no index file: a skill
is a directory with a readable `SKILL.md`, and one whose frontmatter
does not parse is reported as an entry with a `problem` rather than
being hidden — a skill that disappeared from the picker because a colon
was missing would be unfixable from inside gurt.

### 4.2 In `workspace.json`

```jsonc
{ "defaultSkills": ["review-checklist", "house-style"] }
```

Names, not objects: the entry itself is on disk, and a stale name here is
the same "selected but unavailable" case §4.4 already has to handle.
Modelled on `defaultAgent` — a workspace-level statement about what
every new draft starts with, seeded into the draft in `ConfigTab.tsx`
the same way the default agent is, and thereafter the user's to change.
Seeding in the renderer rather than in `createSession` is deliberate: the
draft is where a default becomes a *visible* choice, so what the user
sees before pressing Run is the whole truth about what will be mounted.

### 4.3 In the session

```ts
interface SkillSelection { name: string }
interface SessionInfo { skills?: SkillSelection[] }
```

A one-field record where a bare `string[]` would do, because it sits
beside `McpSelection` and is read by the same kind of code; the shape is
what lets `resolveSkillSelection` and `resolveMcpSelection` be the same
function twice. Absent means "never chosen" and is what the draft's
seeding effect keys on; `[]` means "chosen to be empty" and is not
re-seeded.

`skills` is carried by `SessionDraftPatch`, by `createSession`, by
`duplicateSession` (which copies field by field, so this one has to be
added by hand) and by the persisted record.

### 4.4 An id that stopped resolving

Same rule as MCP, for the same reason: a selected name that no longer
names anything is **kept**, not dropped. `resolveSkillSelection` pairs
each selection with the entry it resolves to now, or with `undefined`.
The draft picker renders the unresolvable ones as an error row with a
`remove` button (`SkillMissingRow`, modelled on `McpMissingRow`); the
start path drops them from the materialization with a line in the
session's provision log. Silently swallowing the name would re-save the
draft without it and lose the user's record of what they asked for.

## 5. Delivery

At `startSession`, before the container is resolved:

1. `materializeSkills` wipes and recreates
   `~/.gurt/<ws>/<task>/.multirepo/<sessionId>/skills/` and copies each
   *resolvable* selected skill directory into it. Copied, not
   symlinked: the mount must be a stable directory whose content cannot
   change under a running session because someone edited the registry.
2. Any name that did not resolve is reported on the session's provision
   log (`[skills] …`), the way `resolveProxyPlan`'s errors are.
3. Provisioning binds that directory **read-only** at `/gurt/skills` in
   the container, and — right after `up` — links it into the agent's
   home:

   ```sh
   mkdir -p "$HOME/.claude" && rm -rf "$HOME/.claude/skills" \
     && ln -s /gurt/skills "$HOME/.claude/skills"
   ```

   The two-step exists because `$HOME` is not knowable at mount time: a
   devcontainer's `mounts` are evaluated to create the container, so
   `${containerEnv:HOME}` is not available there, and the remote user
   (and therefore the home directory) is the image's choice. The link is
   made by gurt through `devcontainer exec`, not by a lifecycle hook, so
   §2's "works for every role" holds — read-only roles have their hooks
   stripped, but nothing strips a command gurt runs itself.

   A session that selected no skill gets neither the mount nor the link,
   and its container config is byte-for-byte what it is today.

### 5.1 Where the merged config goes

Adding a mount means the env's shared `--override-config` is no longer
enough — the session needs a merged copy. That copy already exists for
multi-repo and read-only sessions
(`.multirepo/<sessionId>/devcontainer.json`), derived from the wrapper
workspace dir's parent. It is now addressed directly as the session's
scratch dir (`store.sessionScratchDir`), so a plain single-repo executor
that only needs the skills mount gets a per-session config at the same
path instead of one shared by every session of the task. The path is
unchanged for the sessions that already had one.

`devcontainerUp` grows a second mount list beside `extraMounts`:
`hostMounts`, entries of `{ hostDir, target, readonly }` with an
**absolute container target**. Kept separate rather than folded into
`extraMounts` because two pieces of repo-specific logic key off that
list — a single entry re-points `workspaceFolder` at it, and any
read-only entry strips the create-time hooks — and a read-only skills
bind must trigger neither.

### 5.2 Re-starting a draft

Editing a draft's `skills` releases its container, the way editing
`repos`, `env` or `role` does: a failed start can leave a container
provisioned against the old mount list, and the mount list is decided at
create time.

## 6. MCP `create_session`

The tool schema grows an optional `skills: string[]`. Omitted, it is
**inherited from the spawner**, exactly as `mcp` is: a session drafted by
an agent runs with the procedures the drafting session was given unless
the agent deliberately narrows them. Present, it replaces the set
outright — including with `[]`, which is how an agent says "none".

Names are agent input and therefore untrusted: they are validated at the
boundary (`SkillsSelection` shape and name syntax), but a name that
validates and does not resolve is not an error at draft time — it is the
§4.4 case, visible in the draft's picker as an error row, which is where
a user can act on it.

## 7. UI

**Config tab, draft** — a `SKILLS` block in the Advanced panel, beside
`MCP SERVERS`: one row per offered skill (dot, name, description,
`off`/`on` menu), then a row per unresolvable selection. Identical
mechanics to `McpRow`/`McpMissingRow`; a skill has no modes, so it is
the two-option variant.

**Config tab, live** — the enabled skills of a started session, as tags
in the frozen summary beside the MCP ones, and named by the same "fixed
once a session leaves draft" note.

**Settings → Skills** — the workspace's registry: a list, a `+ Add`
button, and a modal with the name, a `SKILL.md` textarea validated on
save, an "enabled by default" toggle writing `defaultSkills`, and a
delete blocked while any session selects it (`tasksUsingSkill`, the
`tasksUsingMcp` rule). The supporting files found beside `SKILL.md` are
listed, read-only.

## 8. Tests

`scripts/skills-selection.test.mjs`, modelled on
`scripts/mcp-selection.test.mjs`: entries read off disk, a selection
resolved (order, dedup, orphans kept), persistence and duplication of
the selection, inheritance through `create_session`, the `defaultSkills`
seed, and the delete block.
