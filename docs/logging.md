# Logging

gurt writes one local log. It is a diagnostic artifact for the person running
the app — nothing is uploaded, and nothing leaves the machine.

Key code: `src/main/log.ts` (core), `src/renderer/src/log.ts` (renderer
wrapper), the bus tap in `src/main/kernel.ts`, the IPC wrapper in
`src/main/ipc.ts`.

## Where it lives

```
~/.gurt/logs/                     # honours GURT_ROOT; dir mode 0700
  gurt.log                        # the app log, current generation
  gurt.log.1 … gurt.log.5         # rotated generations (6 files max)
  session-<id>.log                # per-session subprocess output
```

Files are created 0600. ⌘K → **Open logs folder** reveals the directory.

**`gurt.log`** is the app's own lifecycle: sessions, containers, processes,
IPC. Rotated at **10 MB** — `gurt.log` → `.1`, `.1…4` shift up by one, `.5` is
deleted. The size is checked when the file is opened and before every write, so
a run that ends just under the limit does not append to an oversized file on the
next start.

**`session-<id>.log`** is one session's subprocess output: the devcontainer CLI,
docker, git, and the ACP adapter's stderr (prefixed `[agent]`). It is not
rotated — it belongs to one session and is deleted with it. It is capped at
**20 MB**, after which one `[log capped]` line is written and the rest dropped.
`<id>` is reduced to `[a-zA-Z0-9-]`; provisioning that is not session-scoped
(the Settings image pre-build, key `env-build:<ws>/<env>`) gets its own file the
same way, deleted when its env is. Orphan containers reaped by the boot
reconcile have no session to own a file — their docker output goes to the app
log at DBG instead.

## Levels

```
GURT_LOG=debug|info|warn|error   # overrides the default
```

Default: `debug` in development (`!app.isPackaged`, plus every record mirrored
to the terminal that started the app), `info` in a packaged build. A headless
embedder that imports the kernel without Electron behaves like production. The
level is resolved once at startup and checked *before* any context is
serialized, so a disabled `debug` call costs one comparison. The renderer
mirrors the threshold over the bridge (one sync fetch at preload) and filters
before the IPC send — main still validates and filters everything it receives;
the mirror is an optimization, never the authority.

Not implemented on purpose: switching the level at runtime, an ACP frame trace
mode, an in-memory ring buffer, JSONL output, log upload.

## Record format

One record is exactly one line:

```
2026-08-04T12:00:00.123Z INF m [sessions] agent.spawn {"s":"abc123","pid":4242}
```

| field   | meaning                                                          |
| ------- | ---------------------------------------------------------------- |
| time    | UTC ISO 8601 with milliseconds                                    |
| level   | `DBG` · `INF` · `WRN` · `ERR`                                     |
| process | `m` main · `r` renderer                                           |
| scope   | subsystem, `[a-z0-9-]{1,32}`                                      |
| message | a slug from the dictionary below (one-off warnings may be prose)  |
| ctx     | optional JSON object                                              |

A record is truncated at 8 KB.

### ctx keys

| key      | meaning                                                        |
| -------- | -------------------------------------------------------------- |
| `s`      | session id                                                      |
| `c`      | container id                                                    |
| `ms`     | duration in milliseconds                                        |
| `reason` | why this happened                                               |
| `err`    | `{name, message, code}`; `stack` is added at ERR level only     |
| `site`   | which internal call site failed (`internal.fail` only)          |

## What the log contains — and what it never contains

Written: lifecycle transitions, process command lines and exit codes, timings,
ports, ids, error messages.

**Never written, anywhere:**

- chat and prompt content, and the session timeline (`session.log` records);
- JSON-RPC params — a frame is logged as method, id, direction and byte size;
- a subprocess's full environment (only the *names* of variables gurt adds);
- credentials.

Redaction is enforced centrally, on every line that reaches a file:

- **Value-based.** Every secret in the credential store is registered with the
  logger at startup and refreshed on every save, then replaced wherever it
  appears — raw, base64 and base64url-encoded. A call site does not have to
  know that a string was a secret. Secrets shorter than 6 characters are the one
  exception — not redacted, since below that length a "secret" is more likely
  an ordinary word than a credential.
- **Key deny-list.** A ctx key containing `token`, `authorization`, `password`,
  `secret`, `apikey`, `passphrase`, `credential`, `cookie` or `bearer`
  (case-insensitive, `-`/`_` stripped before matching — so `api_key` and
  `apiKey` both hit `apikey`; substring, at any depth) is written as
  `[redacted]`.
- **URLs.** `scheme://user:pass@host` becomes `scheme://[redacted]@host`.
- **Streams** (agent stderr, devcontainer output) are line-buffered before
  redaction — a secret split across two chunks is never forwarded in halves.
  Exception: a single line with no `\n` for 32 KB is force-flushed as a partial
  line rather than buffered forever, which could in principle split a secret
  positioned right at that boundary — accepted because real process output
  does not run this long without a newline.

Sanitization runs alongside it: ANSI escapes are stripped, control characters
escaped, and `\n` written as `\\n`, so one record stays one line.

## Slug dictionary

| slug                      | level | ctx                                                       |
| ------------------------- | ----- | --------------------------------------------------------- |
| `app.start`               | INF   | `gurt`, `electron`, `node`, `platform`, `docker`, `root`, `logs`, `level` |
| `app.quit`                | INF   | —                                                          |
| `app.crash`               | ERR   | `reason` (`uncaughtException` \| `unhandledRejection`), `err` |
| `log.dropped`             | WRN   | `n`, `s` (session file only)                               |
| `session.state`           | INF   | `s`, `task`, `state`, `reason`, `err`                      |
| `session.queued`          | INF   | `s`, `reason`, `by`                                        |
| `session.turn`            | INF   | `s`, `phase`                                               |
| `session.awaiting`        | INF   | `s`, `awaiting`                                            |
| `session.adapterExited`   | INF   | `s`                                                        |
| `session.proposal`        | INF   | `s`, `repos`                                               |
| `session.drafted`         | INF   | `s` (the new draft), `by` (the session whose agent asked), `role` |
| `external.stub`           | INF   | `type`, `s`                                                |
| `session.end`             | INF   | `s`, `turns`, `ms`, `stopReason`, `exitCode`               |
| `agent.spawn`             | INF   | `s`, `cmd`, `pid`, `c`, `env` (injected variable *names*)   |
| `agent.exit`              | INF   | `s`, `pid`, `code`, `signal`, `ms`                         |
| `proc.spawn`              | DBG † | `cmd`, `argv`, `pid`                                       |
| `proc.exit`               | DBG † | `cmd`, `pid`, `code`, `ms`                                 |
| `provision.phase`         | INF   | `s`, `phase` (`clone` \| `image` \| `up`), `ms`            |
| `provision.fail`          | ERR   | `s`, `phase`, `code`, `err`                                |
| `container.status`        | INF   | `s`, `status`, `reason`                                    |
| `container.stop` / `.remove` | INF | `s`, `c`, `reason`, `ms`                                  |
| `reconcile.done`          | INF   | `fixed`, `orphans`                                         |
| `mcp.start` / `mcp.stop`  | INF   | `id`, `s`, `mode` (the granted access level, or the session's role for `gurt`), `port` |
| `mcp.listen`              | INF   | `id`, `kind`, `port` — a local (stdio) server's bridge is up; the port, never the URL, which carries its token |
| `mcp.install`             | INF   | `id`, `package` (`name@version`) — an `npm` MCP entry being installed under `~/.gurt/mcp` |
| `mcp.exit`                | WRN   | `id`, `command`, `code`, `signal` — a local MCP server died and gurt did not ask it to |
| `mcp.fail`                | ERR   | `id`, `kind`, `err` — a local MCP server could not be started; the session log only says the id is unroutable |
| `mcp.out`                 | DBG   | `id`, `stream`, `line` — a local MCP server's own stdout/stderr. Its **environment** is never logged at any level: that is where the credential lands |
| `mcp.probe`               | INF   | `id`, `kind`, `ok`, `tools` (how many, never their names), `err`, `ms` — a user pressed Test in the MCP editor and gurt started the entry to see what it answers. The launch transcript it shows the user is the server's own output: displayed there, never written here |
| `gitbroker.start` / `.stop` | INF | `s`, `port`                                                |
| `ipc.call`                | DBG   | `method`, `ms`, `args`                                     |
| `ipc.fail`                | ERR   | `method`, `ms`, `err`, `args` (DBG only)                   |
| `rpc.msg`                 | DBG   | `s`, `dir`, `method`, `id`, `bytes`                        |
| `rpc.oversize`            | WRN   | `s`, `chars`, `cap` — an over-cap frame dropped whole; sizes only, never the frame |
| `window.error` / `window.unhandledrejection` | ERR | `message`, `source`, `line`, `err`       |
| `internal.fail`           | ERR   | `site`, `err`, plus whatever identifiers (`s`, `ws`, `task`, …) the failed operation carried |

† The devcontainer CLI traces at **INF** — it is rare, slow, and usually the
thing being diagnosed. The host probes below it (`git`, `docker`, `tar`) run
several times per panel refresh and trace at DBG; a *failing* exit is always
logged at WRN, whichever command it was.

`session.state`'s `reason` names the trigger: `created`, `user`, `scheduler`,
`start-failed` (with `err`). `container.status`'s `reason` is one of `idle`
(auto-stop), `queue` (auto-stop cut short — a queued session needs this
container's clone), `user` (a start or stop asked for by the user or the
scheduler), `task-deleted`, `session-deleted`, `error`, `reconcile`.

`internal.fail` is the catch-all for a background operation's rejection —
persistence, reconcile, a bus handler, a subprocess wrapper — anywhere there is
no user-facing error path to carry it instead. `site` names the call site
(`container-release`, `session-persist`, `bus-handler`, …) so records from the
one slug stay distinguishable.

`ipc.call`/`ipc.fail` log the call's arguments, redacted, at DBG. Methods whose
arguments carry prose — `sessionPrompt`, `createSession`, `changesCommit`,
`setCredentials`, … — log an argument *count* instead, never the values.

## Robustness

One serialized writer per file, appending to an open fd with `O_APPEND`. The
queue holds 1000 records; anything beyond that is dropped and reported as one
`log.dropped {n}` record. The renderer channel is validated (level, scope,
size) and rate-limited to 200 records/s; the excess is counted the same way.

The logger never throws and never logs through itself. A sink that cannot be
opened or written (permissions, a full disk) is switched off for the rest of the
run and reported once on `console.error` — the app keeps working with no log
rather than failing with one. Open question: the report is once per *process*,
so the first broken sink silences reports about any file that breaks later;
once per *file* would be more informative (see `internalFailure` in
`src/main/log.ts`).

`before-quit` flushes synchronously. `uncaughtException` in the main process
writes `app.crash`, flushes the same way, shows a crash popup (replacing
Electron's default one, which our handler suppresses) and exits — resuming
after one is unsafe. The popup's single **Send Report to Developer** button is
a stub: nothing is collected or sent anywhere yet; the click is followed by a
short beat and the exit. When an upload endpoint exists, that is where the log
gets packed and sent — under the hood, behind the same button.
`unhandledRejection` writes the same record and flushes, and the app keeps
running (Electron's own default for rejections).

## Tests

```
node scripts/log.test.mjs          # writer, rotation, sanitization, redaction, drops
node scripts/line-buffer.test.mjs  # a secret split across two stream chunks
node scripts/smoke-logging.mjs     # the live app: banner, IPC, renderer transport
```

`smoke-logging.mjs` needs a display (`DISPLAY=:99`), like the other smoke
scripts. Between them they cover: a stored credential never appearing in the log
in any encoding, a message with newlines and ANSI staying one sanitized line, a
renderer flood leaving the app responsive with `log.dropped` recorded, rotation
producing `gurt.log.1` and at most six files, and an unwritable log file leaving
the app fully functional. A `kill -9` mid-turn (`agent.exit` + `session.end`
with a non-zero `exitCode`) needs a live agent; the code path's exit-code
mapping is covered by `scripts/turn-contract.test.mjs`.
