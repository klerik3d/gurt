# Requirements: remote access — the wire contracts

Status: partial — the TypeScript side of §3, §5, §6 and §7's types is
`packages/remote-protocol`; Gurt's host-socket client is in
`src/main/remote/` · Companion to
`requirements-remote-access.md`

That document says *why* and *what*; this one is the contract each party
implements, byte for byte where it matters. Three parties, three
implementations in two languages, so the contract — not any one
implementation — is the source of truth:

- **Gurt** — Electron main, TypeScript (`src/main/remote/`), repository
  `gurt`.
- **Relay** — Go, repository `gurt-relay`. Also the push gateway.
- **App** — React Native, TypeScript, repository `gurt-mobile`.

## 1. Who talks to whom

```
Gurt ──wss /v1/host──▶ relay ◀──wss /v1/client── App
  │                                                │
  └───────────── Noise channel (§6) ───────────────┘
                 JSON-RPC inside (§7)

Gurt ── QR code on screen (§5) ──▶ App            (out of band, once)
Gurt ── PUSH on the host socket (§3.5) ──▶ relay ── APNs / FCM (§8) ──▶ App
```

| Contract | Between | Carried by | Section |
|---|---|---|---|
| Host socket | Gurt ↔ relay | WebSocket, binary | §3 |
| Client socket | App ↔ relay | WebSocket, binary | §4 |
| Relay info | anyone → relay | HTTPS GET | §4.4 |
| Pairing payload | Gurt → App | QR code / `gurt://` URL | §5 |
| Channel | Gurt ↔ App | Noise, inside §3/§4 frames | §6 |
| Application | Gurt ↔ App | JSON-RPC 2.0, inside §6 | §7 |
| Push | Gurt → relay → App | host-socket frames, APNs/FCM | §3.5, §8 |

The relay implements §3, §4 and the sending half of §8, and nothing else.
It never parses §6–§7.

## 2. Common conventions

- **Integers** on the wire are unsigned, big-endian.
- **`b64u`** is base64url without padding (RFC 4648 §5).
- **`hostId`** = lowercase RFC 4648 base32, no padding, of the first 20
  bytes of SHA-256 of the host's Ed25519 relay-identity public key — 32
  characters, `[a-z2-7]`.
- **Protocol versions.** Each layer has its own integer version:
  relay protocol (§3–§4) `1`, channel (§6) `1`, remote API (§7) `1`. A
  party rejects a version it does not support with the error the layer
  defines, never by guessing.
- **Unknown fields** in any JSON object are ignored. Unknown frame types or
  enum values are a protocol error.

## 3. Host socket: Gurt ↔ relay

### 3.1 Connection

Gurt opens `wss://<relay>/v1/host`. Every WebSocket message is one binary
frame; a text message is a protocol error.

```
frame = type:u8 | stream:u32 | payload
```

`stream` is `0` for frames about the connection itself.

| Type | Name | Direction | Payload |
|---|---|---|---|
| `0x01` | `HELLO` | relay → Gurt | `version:u16 \| challenge:32` |
| `0x02` | `REGISTER` | Gurt → relay | `version:u16 \| pubkey:32 \| sig:64` |
| `0x03` | `READY` | relay → Gurt | empty |
| `0x10` | `OPEN` | relay → Gurt | empty |
| `0x11` | `DATA` | both | ≤ 65 536 bytes, opaque |
| `0x12` | `CLOSE` | both | `reason:u16` |
| `0x20` | `PUSH_SET` | Gurt → relay | JSON, §3.5 |
| `0x21` | `PUSH` | Gurt → relay | JSON, §3.5 |
| `0x22` | `PUSH_GONE` | relay → Gurt | JSON, §3.5 |
| `0x23` | `PUSH_ERR` | relay → Gurt | `code:u16` |

### 3.2 Registration

1. The relay sends `HELLO` with the highest relay-protocol version it
   speaks and a fresh random 32-byte challenge.
2. Gurt answers `REGISTER` with the version it will speak, its Ed25519
   public key, and `sig` = Ed25519 signature over
   `utf8("gurt-relay/1 register") | 0x00 | challenge`.
3. The relay checks the signature, derives `hostId` (§2), and answers
   `READY`. From then on clients may reach this host, and Gurt may send
   push frames (§3.5).

Gurt must not send anything but `REGISTER` before `READY`. If the same
`hostId` registers again, the relay closes the older socket with `4409`;
the newer one wins. The relay forgets the older socket's push tokens with
it (§3.5).

### 3.3 Streams

- `OPEN(stream)` — a client connected for this host. Stream ids are chosen
  by the relay, from 1 (stream `0` is the connection itself), unique per host
  socket, never reused while the socket lives. `OPEN`, `DATA` and `CLOSE` on
  stream `0`, or a connection frame on any other stream, are protocol
  errors.
- `DATA(stream, bytes)` — forwarded unchanged in both directions, in
  order.
- `CLOSE(stream, reason)` — either side ends a stream. The relay sends it
  when the client socket closes; Gurt sends it to drop a client, and the
  relay then closes the client socket (§4.2). After `CLOSE`, frames on that
  stream are ignored.

`CLOSE` reasons:

| Code | Meaning |
|---|---|
| `0` | normal |
| `1` | rejected — handshake failed, unknown or revoked device |
| `2` | protocol error |
| `3` | message too large |
| `4` | idle timeout |
| `5` | host going away |
| `6` | rate limited |

### 3.4 Liveness and errors

The relay sends WebSocket pings every 25 s and closes a socket that missed
two. The relay closes the host socket with:

| WS close code | Meaning |
|---|---|
| `4400` | protocol error (bad frame, text message, frame before `READY`) |
| `4401` | bad registration signature |
| `4409` | replaced by a newer registration of the same `hostId` |
| `4426` | version not supported; the reason text lists the supported ones |
| `4429` | rate limited |

Gurt reconnects with exponential backoff (1 s to 60 s, jittered), except
after `4401` and `4426`, which are shown to the user and not retried.

### 3.5 Push frames

All three payloads are UTF-8 JSON on stream `0`.

`PUSH_SET`, Gurt → relay — **the complete set** of push tokens for this
host, replacing whatever the relay held. Gurt sends it right after `READY`
and whenever a device is added, removed, or its token changes:

```json
{ "tokens": [ { "d": "<deviceId>", "p": "apns", "t": "<token>" },
              { "d": "<deviceId>", "p": "fcm",  "t": "<token>" } ] }
```

`p` is `apns` or `fcm`; an unknown value makes the frame malformed
(`PUSH_ERR` 1, like any push payload that does not parse). The relay
holds the set in memory only; nothing is written to disk, so a restart
empties it until the hosts register again. At most 32 tokens per host.

`PUSH`, Gurt → relay — send a notification to every token of this host:

```json
{ "t": "awaiting", "s": "<sessionId>" }
```

`t` is a `NotificationType` (`awaiting`, `proposal`, `error`,
`turn-ended`); a further optional field `"w": true` marks a withdrawal (§8).
A reserved optional field `"p": "<b64u>"` is forwarded by the relay
unchanged in the push's custom data and is unused in version 1; it is where
an encrypted payload will go (remote-access §13 Q9).
The relay builds the APNs/FCM payload itself (§8); the host supplies no
free text.

`PUSH_GONE`, relay → Gurt — the push service said these tokens are no
longer valid (APNs `410`/`BadDeviceToken`, FCM `UNREGISTERED`):

```json
{ "d": ["<deviceId>"] }
```

Gurt drops the tokens and the app registers again at its next connection.

`PUSH_ERR`, relay → Gurt — a `PUSH` or `PUSH_SET` was refused:

| Code | Meaning |
|---|---|
| `1` | malformed |
| `2` | too many tokens |
| `3` | rate limited — the push was dropped, not queued |
| `4` | push not configured on this relay (`/v1/info` `push` is empty) |

Push frames never close the socket; a host over a limit gets `PUSH_ERR`.

## 4. Client socket: App ↔ relay

### 4.1 Connection

The app opens `wss://<relay>/v1/client?host=<hostId>`. One client socket
is exactly one stream, so there is no framing: **each binary WebSocket
message is one `DATA` payload**, in both directions. A text message is a
protocol error.

### 4.2 Lifecycle

- Host not registered → the relay closes at once with `4404`.
- Otherwise the relay sends `OPEN` to the host and forwards from then on.
- The client closes its socket → the relay sends `CLOSE(stream, 0)`.
- The host sends `CLOSE(stream, r)` → the relay closes the client socket
  with `4000 + r`.
- The host socket goes away → the relay closes every client socket of that
  host with `4503`.

| WS close code | Meaning |
|---|---|
| `4000`–`4006` | the host closed the stream; `code − 4000` is the §3.3 reason |
| `4400` | protocol error |
| `4404` | host offline |
| `4408` | no message within 10 s of connecting, or idle for 5 minutes |
| `4413` | message larger than 65 536 bytes |
| `4429` | rate limited |
| `4503` | host went away |

The app reconnects with the same backoff as §3.4, except after `4001`
(rejected), which it shows as "this device is not paired or was revoked".
The app does not hold the socket in the background; it reconnects when it
returns to the foreground (§7.5, §7.6).

### 4.3 Limits (relay defaults, configurable)

The relay is shared by many hosts, so limits are per host and per IP, not
global: at most 16 open streams per host, 8 client sockets per IP, 200
messages per second per stream, and a cap on registered hosts per IP.
Over a limit → `4429`, or `CLOSE(…, 6)` toward the host.

### 4.4 Relay info

`GET https://<relay>/v1/info` →

```json
{ "protocol": [1], "push": ["apns", "fcm"] }
```

`protocol` lists the relay-protocol versions it speaks. `push` lists the
push platforms this instance can send to (empty or absent if none). Gurt's
"Test" button calls this, then registers once.

## 5. Pairing payload: Gurt → App, out of band

The QR code encodes a URL:

```
gurt://pair#<b64u(JSON)>
```

```json
{
  "v": 1,
  "r": "wss://relay.example.org",
  "h": "<hostId>",
  "k": "<b64u host Noise static public key, 32 bytes>",
  "s": "<b64u pairing secret, 32 bytes>",
  "n": "<host display name>"
}
```

- The app scans it with its own camera screen; a phone's system camera
  opens the same URL and hands it to the app through the `gurt://` scheme.
  An app that is not installed does nothing, which the pairing screen says
  in one line ("install the Gurt app first").
- `r` is how the app learns which relay to use; nothing is configured on
  the phone.
- `s` is single-use and valid for 5 minutes. Gurt holds at most one live
  pairing secret.
- A custom-scheme URL can be opened by any app that registers it; this is
  acceptable because the payload alone is not enough to finish pairing
  (§6.3 — the desktop confirms).
- **Re-pointing** (the user switched relays): the URL `gurt://relay#…` with
  the same JSON without `s`. The app applies it only to a host whose `h`
  and `k` it already stores, and only changes `r`.

## 6. Channel: Gurt ↔ App (Noise)

### 6.1 Patterns

| Mode | Noise protocol name | Used for |
|---|---|---|
| `0x01` connect | `Noise_IK_25519_ChaChaPoly_BLAKE2s` | every connection of a paired device |
| `0x02` pair | `Noise_IKpsk1_25519_ChaChaPoly_BLAKE2s` | pairing, PSK = `s` from §5 |

Both are IK: the app already knows the host static key — from the QR code
when pairing, from storage afterwards. In pairing, the PSK is mixed into
the first message, so Gurt rejects a client without the QR secret before
sending anything back.

The app is always the initiator. **The first `DATA` of a stream is
`mode:u8 | noise message 1`**; every later `DATA` is a bare Noise message.
Gurt picks the pattern from `mode`.

```
prologue = utf8("gurt-remote/1 ") | mode:u8 | utf8(" " + hostId)
```

### 6.2 Handshake payloads

JSON, UTF-8, inside the Noise messages:

- **Message 1** (App → Gurt):
  `{"v":1,"app":"<app build version>","platform":"ios"|"android","label":"<device label>"}`.
  `label` is only read in pairing mode, as the default device name.
- **Message 2** (Gurt → App): `{"v":1}`.

Gurt does not answer message 1 at all — it sends `CLOSE(stream, 1)` — when:

- in connect mode, the client static key is not a paired device;
- in pair mode, no pairing secret is live, or the PSK does not match (the
  AEAD fails);
- `v` is not a channel version it supports.

### 6.3 After a pairing handshake

Both sides compute the short code from the final handshake hash `h`:

```
sas = u32(BLAKE2s(h | utf8("gurt-remote/1 sas"))[0..4]) mod 1 000 000
```

shown as six digits, zero-padded. Gurt then sends application
notifications (§7) on the same stream:

- `remote.pairing {"state":"pending"}` — the desktop shows the code and
  asks the user to confirm and name the device;
- then exactly one of `{"state":"accepted","deviceId":"<id>"}`,
  `{"state":"rejected"}` or `{"state":"expired"}`, after which Gurt closes
  the stream with reason `0`.

On `accepted` the app stores the host (§9), registers for push (§7.3) on
its next connection, and reconnects in connect mode. No other method is
served on a pairing stream.

### 6.4 Transport

- Each Noise transport message is one `DATA` payload: ≤ 65 535 bytes, so
  ≤ 65 519 bytes of plaintext.
- The plaintext is `flags:u8 | chunk`. Bit 0 set = more chunks follow.
  Chunks are concatenated into one application message of at most 16 MiB
  (the same cap as `MAX_FRAME` in `src/main/jsonrpc.ts`); over the cap,
  the receiver closes the stream with reason `3`.
- Version 1 does not rekey: keys are per handshake, connections are short
  compared with the 2⁶⁴ nonce space, and a reconnect makes new keys.
- Any AEAD failure closes the stream with reason `2`.

## 7. Application: Gurt ↔ App (JSON-RPC 2.0)

Each reassembled message (§6.4) is one JSON-RPC 2.0 object, UTF-8. Both
sides may send requests and notifications; ids are per sender. The method
names, params and results below are declared once, as TypeScript, in the
shared package (`packages/remote-protocol/src/remoteApi.ts`, remote-access
§13 Q8), which Gurt takes through `src/shared/remoteApi.ts` and the app as a
dependency; the tables here are the scope, the types are the detail. In the
tables, params shown as — are `{}` and a result shown as — is `null`.

### 7.1 Hello

Gurt's first message on a connect-mode stream is the notification
`remote.hello`:

```json
{
  "v": 1,
  "gurt": "1.42.0",
  "api": { "version": 3, "min": 1 },
  "device": { "id": "<deviceId>", "name": "Pixel" },
  "host": { "name": "workstation" },
  "methods": ["tree.get", "session.get", "…"],
  "events": ["tree-changed", "session-changed", "session-log", "…"]
}
```

- `api.version` is the remote API version Gurt speaks; `api.min` the oldest
  app API version it still serves. The app has the same pair compiled in.
  If the ranges do not overlap, the app does not start the UI and shows
  "Gurt needs updating" or "the app needs updating" with both versions
  (remote-access §7.2).
- `methods` and `events` list what this Gurt serves. The app feature-detects
  a method added after its minimum version and hides the control when it is
  absent.

The app sends no request before `remote.hello`.

### 7.2 The remote API

A request whose `method` is a `RemoteApi` method name and whose `params` is
an **object** of named parameters; the result is a JSON value. There is no
mapping onto `GurtApi`: these are the calls the app's screens need
(`design-mobile-app.md` §3, §7), in the app's own types, free of host paths
and credential values. Results pass `scrub()`.

Phase 1:

| Method | Params | Result |
|---|---|---|
| `tree.get` | — | workspaces → scopes → sessions, each with the desktop's status, agent, role and one line of latest activity |
| `session.get` | `{id, before?, limit?}` | a page of chat entries ending at `before` (default: the end), plus `logSeq`, status, plan, queue, pending permission prompt, context usage |
| `session.entry` | `{id, entryId}` | one entry's expanded tool output, fetched when expanded |
| `session.send` | `{id, clientMsgId, text}` | `{queued: boolean}`; a repeated `clientMsgId` is a no-op |
| `session.cancelQueued` | `{id, queueItemId}` | — |
| `session.stop` | `{id}` | — |
| `permission.answer` | `{sessionId, promptId, optionId, confirm?}` | — ; `-32010` if the prompt is not the pending one |
| `inbox.list` | — | the "needs you" items, newest first |
| `inbox.markRead` | `{ids}` or `{all: true}` | — |
| `host.unpair` | — | — ; the device removes itself (remote-access §5.3) |

Phase 2 adds: `draft.run`, `draft.enqueue`, `queue.cancel`,
`proposal.get`, `proposal.commit` / `.push` / `.openPr` / `.merge`
(each requires `confirm`), `diff.files` (the files of a proposal with
line counts) and `diff.file` (one file's hunks, fetched when opened),
`masked.reveal` (`{sessionId, placeholder}` → the real value; audited),
`proactive.list` / `.run` / `.leave` / `.discard`, `session.setMode`,
`usage.get`, `session.resume`. Phase 3 adds session creation and the host
switcher.

A call to an unknown method gets `-32601`. There is no category of
"present but refused", so a client cannot probe for the desktop surface.
Methods marked `confirm` are refused with `-32011` unless the field is
`true` (remote-access §6.5).

### 7.3 `remote.*` methods

Methods about the channel itself; not part of `RemoteApi`'s screens.

| Method | Direction | Params | Result |
|---|---|---|---|
| `remote.hello` | Gurt → App, notification | §7.1 | — |
| `remote.pairing` | Gurt → App, notification | §6.3 | — |
| `remote.event` | Gurt → App, notification | `{"ch":"<event>","p":<payload>}` | — |
| `remote.resume` | App → Gurt | `{"sessions":{"<id>":<lastSeq>}}` | `{"<id>":"ok"\|"reset"}` |
| `remote.ping` | App → Gurt | `{}` | `{}` |
| `remote.pushRegister` | App → Gurt | `{"platform":"apns"\|"fcm","token":"<token>"}` | `{}` |
| `remote.pushUnregister` | App → Gurt | `{}` | `{}` |

`remote.pushRegister` is sent on every connection (tokens rotate); Gurt
updates the device entry and, if the token changed, sends `PUSH_SET` (§3.5).

### 7.4 Events

`remote.event` carries one event listed in `hello.events`. The set is small
and the app's own:

| Event | Payload |
|---|---|
| `tree-changed` | — (refetch `tree.get`) |
| `session-changed` | `{id}` — status, plan, queue or pending prompt changed |
| `session-log` | `{id, record}` — a session-log record with its `seq` |
| `notification` | an inbox item |
| `notification-read` | `{ids}` |
| `host-state` | `{state}` — e.g. `"restarting"` before Gurt closes streams |

Events and responses are sent in the order Gurt produced them.
`session-changed` bursts may be coalesced to the latest. Gurt never drops
`session-log`; if the send queue overflows, Gurt closes the stream with
reason `0` and the app resumes (§7.5).

### 7.5 Resume and the session log

The app builds a chat from `session.get` pages plus `session-log` records.
`append` records are not idempotent, so every record must be applied exactly
once:

- `SessionSnapshot` gains `logSeq` — the `seq` of the last record folded
  into its `entries`, and `session.get` returns it. **This is the one change
  to Gurt's existing types this protocol needs.**
- The app keeps `lastSeq` per open session and drops any `session-log`
  record with `seq <= lastSeq`.
- After every (re)connect, the app calls `remote.resume` with its
  `lastSeq` per open session. For each, Gurt either replays the records
  after it from the session's JSONL log as `session-log` events (`"ok"`) or,
  if it cannot (log compacted, session deleted), answers `"reset"`, and the
  app refetches `session.get`.
- Gurt subscribes the stream to live events before it reads the replay, so
  the overlap is deduplicated by `seq`, never lost.
- A long chat is paged from the end with `before`; the app never fetches a
  whole log to show the last screen.

### 7.6 Liveness

The app calls `remote.ping` every 25 s while in the foreground. Gurt closes
a stream that has been silent for 90 s with reason `4`; the app treats a
ping without a reply in 10 s as a dead connection and reconnects. In the
background the app closes the stream itself (`CLOSE` reason `0`) and relies
on push (§8).

### 7.7 Errors

| Code | Meaning |
|---|---|
| `-32600` | invalid request |
| `-32601` | method not found |
| `-32602` | invalid params |
| `-32603` | the method threw; `message` is scrubbed like every result |
| `-32001` | too many requests in flight (limit 32 per stream) |
| `-32002` | result larger than 16 MiB |
| `-32010` | stale — the prompt, turn or item the call names is gone or no longer current |
| `-32011` | confirmation required — the call needs `confirm: true` |
| `-32012` | not found — the session or item does not exist |

## 8. Push: relay → APNs / FCM → App

The relay builds the notification from a `PUSH` frame (§3.5). The data the
app receives:

```json
{ "v": 1, "h": "<hostId>", "t": "awaiting", "s": "<sessionId>" }
```

`t` is a `NotificationType`. No title, no text.

- **iOS (APNs):** an alert push whose text is a *localisation key*
  (`loc-key`, one per type) that the app resolves from its own bundle, so
  the relay sends no human-readable text; `thread-id` and `apns-collapse-id`
  are the session id so one session shows one notification; `badge` is not
  set by the relay (the app sets it when it runs). The `h`, `t`, `s` fields
  ride in the custom payload.
- **Android (FCM):** a notification message on a per-type channel, with the
  session id as the collapse key/tag; `h`, `t`, `s` in `data`.
- A withdrawal (`PUSH` with `"w": true`) is a silent push (`content-available`
  / data-only) that tells the app to clear the notification for that
  session. Where the OS does not deliver it in time, the notification stays
  and the stale-answer check (§7.2, `-32010`) is what protects the user.

The app, when opened from a push, shows the session and fetches details over
the channel; the push is never a source of content. Tapping a push never
answers anything.

## 9. What each party stores

| Party | Persistent state |
|---|---|
| Relay | nothing on disk. In memory: registered host sockets and, per host, the last `PUSH_SET` token set |
| Gurt | relay-identity Ed25519 key and Noise static key (in the credential store, `safeStorage`, as `remote-identity` entries); the device list `{deviceId, name, publicKey, pairedAt, lastSeen, push?}`; the relay URL |
| App | per host, in secure storage: `{hostId, hostKey, relayUrl, name, deviceKey}`; the push token is not stored (the OS owns it and the app re-sends it each connection); the `lastSeq` map is in memory only |

Revoking a device deletes its entry and its token. "Revoke all" also
replaces the Noise static key; every device then fails §6.2 and has to pair
again.

## 10. Conformance

Two languages implement §3, so the frame codec is pinned by shared vectors:

- `gurt-relay/testdata/frames.json` — hex frames with their decoded form,
  including invalid ones, the push frames and the expected error. The Go
  relay and Gurt's TypeScript host-socket client both run it; Gurt keeps a
  pinned copy and a check that it matches.
- `gurt-relay/testdata/register.json` — key, challenge and signature
  triples.
- The shared TypeScript package's `testdata/` — Noise vectors for both
  patterns with the §6.1 prologue, the §6.3 SAS, and §5 payload parse
  cases (`channel.json`, `pairing.json`, the Noise specification's own
  vectors in `noise-spec.json`), and the package's own `frames.json` in the
  same format as the relay's, to be reconciled with it
  (`packages/remote-protocol/testdata/README.md`). Gurt and the app share one implementation, so one suite covers
  both; the app's CI also runs it under Hermes.

## 11. Open questions

1. **Several hosts per device.** §9 already stores a list. Does the app
   need a host picker in phase 1? (remote-access §13 Q7)
2. **Padding.** Pad `DATA` payloads to size buckets (§6.4 framing has room
   for it) to blunt the size metadata the relay sees?
3. **Push payloads in the clear — deferred, not dropped.** §8 sends the
   type and session id to APNs/FCM in phase 1. Encrypting them to the device
   needs a notification service extension (iOS) and a message service
   (Android); the `p` field in §3.5 is reserved for it. Tracked in
   remote-access §13 Q9.
4. **`gurt://` and link hijack — decided for phase 1.** The custom scheme is
   good enough: any app can register it, but the payload alone cannot
   finish pairing (§5, §6.3). Universal links (an `https://` URL on a
   domain the project controls, verified by the OS) would bind the QR code
   to the installed app, and need a domain and the association files; they
   are a later upgrade, and the payload format does not change.
