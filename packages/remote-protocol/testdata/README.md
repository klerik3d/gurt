# Test vectors

Language-neutral vectors for the wire contracts in
`docs/requirements-remote-protocol.md`. Everything here is plain JSON so the
Go relay, Gurt and the app can all run the same cases. Byte strings are
lowercase hex, without a prefix. Unknown members of any object are to be
ignored by readers, so a file can grow without breaking an older runner.

`frames.json`, `channel.json` and `pairing.json` are written by
`scripts/gen-testdata.mjs` and committed; the tests only read them. To change
a vector, change the script and regenerate: the diff of the JSON is what
gets reviewed. Fixed keys and nonces make every run produce the same bytes.

## `frames.json` — host-socket frames (§3)

```json
{
  "format": "gurt-frames/1",
  "description": "…",
  "vectors": [
    { "name": "…", "hex": "…", "frame": { … }, "canonical": true, "note": "…" },
    { "name": "…", "hex": "…", "error": "bad-length" }
  ]
}
```

Each vector has `name`, `hex` (one whole WebSocket message) and exactly one
of:

- **`frame`** — the hex decodes, to this. `canonical: true` additionally
  means encoding `frame` gives exactly `hex` back; `false` marks inputs a
  decoder must accept but an encoder never writes (extra whitespace, unknown
  members, keys out of order).
- **`error`** — the hex must be refused, with this code.

`note` is optional and informational.

### Decoded form

Always `type` (the §3.1 name, e.g. `"PUSH_SET"`) and `stream` (a number),
plus per type:

| `type` | Members |
|---|---|
| `HELLO` | `version` (number), `challenge` (hex, 32 bytes) |
| `REGISTER` | `version`, `pubkey` (hex, 32), `sig` (hex, 64) |
| `READY`, `OPEN` | — |
| `DATA` | `data` (hex, may be empty) |
| `CLOSE` | `reason` (number) |
| `PUSH_ERR` | `code` (number) |
| `PUSH_SET`, `PUSH`, `PUSH_GONE` | `json`: the payload as the decoder understood it — only the members §3.5 defines, optional ones present only when set |

A canonical JSON payload is `JSON.stringify` of the members in the order §3.5
lists them (`tokens` → `d`, `p`, `t`; `t`, `s`, `w`, `p`; `d`), with no
whitespace.

### Error codes

Checked in this order; a vector has one fault, so the order only matters to
an implementation that wants to match messages as well as codes.

| Code | When |
|---|---|
| `truncated` | fewer than 5 bytes |
| `unknown-type` | a type byte not in §3.1 |
| `bad-stream` | `HELLO`, `REGISTER`, `READY` or a push frame on a stream other than 0; `OPEN`, `DATA` or `CLOSE` on stream 0 |
| `bad-length` | a fixed-size payload of another size (`HELLO` 34, `REGISTER` 98, `CLOSE` 2, `PUSH_ERR` 2), or any payload on `READY` / `OPEN` |
| `too-large` | `DATA` over 65 536 bytes |
| `bad-reason` | a `CLOSE` reason outside 0–6 |
| `bad-code` | a `PUSH_ERR` code outside 1–4 |
| `bad-push` | a push payload that is not UTF-8 JSON of an object of the §3.5 shape: missing or mistyped members, empty `d` / `t` / `s`, a `p` platform other than `apns` / `fcm`, a `t` that is not a notification type, a `w` that is not a boolean, a `p` (in `PUSH`) that is not base64url |

`bad-push` is the relay's `PUSH_ERR 1` (malformed); every other code is a
protocol error, WebSocket close `4400`. Well-formed but refused (33 tokens,
`PUSH_ERR 2`) is not a codec error and decodes normally.

## `channel.json` — the Noise channel (§6)

```json
{
  "format": "gurt-channel/1",
  "keys": { "hostId": "…", "hostStaticSecret": "…", "deviceStaticSecret": "…",
            "appEphemeralSecret": "…", "hostEphemeralSecret": "…", "pairingSecret": "…", … },
  "clientHello": { "v": 1, "app": "1.0.0", "platform": "ios", "label": "Test phone" },
  "vectors": [ {
    "mode": "connect" | "pair",
    "pattern": "Noise_IK_25519_ChaChaPoly_BLAKE2s",
    "prologue": "…", "first": "…", "second": "…",
    "handshakeHash": "…", "sas": "123456",
    "transport": [ { "from": "app" | "gurt", "message": "…", "data": ["…"] } ]
  } ],
  "sas": [ { "h": "…", "sas": "…" } ]
}
```

- `first` is the stream's first `DATA` payload, `mode:u8 | noise message 1`,
  whose payload is `clientHello` as canonical JSON (§6.2 key order); `second`
  is message 2, payload `{"v":1}`.
- Both sides use the fixed ephemeral keys given in `keys`; with any other
  ephemeral the bytes differ, but `first` still has to be readable by the host.
- `transport` is in sending order; each `data` entry is one `DATA` payload
  (one Noise transport message, `flags:u8 | chunk` inside). A `message` that is
  an object `{ "repeat": "x", "length": n }` stands for that character
  repeated `n` times.
- `sas` lists pairing codes for given handshake hashes (§6.3).

## `pairing.json` — the QR payload (§5)

```json
{
  "format": "gurt-pairing/1",
  "cases": [
    { "name": "…", "url": "gurt://pair#…", "value": { "kind": "pair", "v": 1, "r": "…", "h": "…", "k": "<hex>", "s": "<hex>", "n": "…" }, "canonical": true },
    { "name": "…", "url": "…", "error": "bad-field" }
  ]
}
```

`value.kind` is `pair` or `relay` (the re-pointing URL, no `s`). `canonical`
means building the URL from `value` gives exactly `url`. Error codes:
`bad-url`, `bad-encoding`, `bad-version`, `bad-field`, `unexpected-secret`
(see `src/pairing.ts`).

## `noise-spec.json` — the Noise specification's vectors

The `Noise_IK_25519_ChaChaPoly_BLAKE2s` and
`Noise_IKpsk1_25519_ChaChaPoly_BLAKE2s` vectors from cacophony and snow,
copied unchanged in the format of the Noise wiki
(<https://github.com/noiseprotocol/noise_wiki/wiki/Test-vectors>). They pin
the Noise core; `channel.json` pins what the channel adds on top.
