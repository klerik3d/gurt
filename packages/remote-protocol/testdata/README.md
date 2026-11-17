# Test vectors

Language-neutral vectors for the wire contracts in
`docs/requirements-remote-protocol.md`. Everything here is plain JSON so the
Go relay, Gurt and the app can all run the same cases. Byte strings are
lowercase hex, without a prefix. Unknown members of any object are to be
ignored by readers, so a file can grow without breaking an older runner.

`channel.json` and `pairing.json` are written by `scripts/gen-testdata.mjs` and
committed; the tests only read them. To change a vector, change the script and
regenerate: the diff of the JSON is what gets reviewed. Fixed keys and nonces
make every run produce the same bytes.

`relay/` is not generated here; it is the relay's, see the next section.

## `relay/` — the relay's vectors, host-socket frames (§3) and REGISTER (§2, §3.2)

The host-socket frame codec has two implementations, the relay's (Go) and
`src/frames.ts`, and one set of vectors, the relay's. `relay/` is a **pinned
copy** of `gurt-relay/testdata/`:

| File | |
|---|---|
| `relay/frames.json` | every frame type, valid and invalid (format 1) |
| `relay/register.json` | the REGISTER signature and the `hostId` derivation |
| `relay/README.md` | the format, unchanged from the relay |
| `relay/SHA256SUMS` | `sha256sum` of the three files, written by the update script |

The format is the relay's `testdata/README.md`; read it there (the copy is
`relay/README.md`). `test/relay-vectors.test.mjs` runs `frames.ts` and
`register.ts` over every case: a valid case decodes to its `frame` and, with
`roundtrip: true`, encodes back to the same bytes; an invalid case is refused
with the matching error. The relay's identifiers map one to one to this codec's
`FrameError` codes:

| Relay | `short` | `unknown-type` | `stream` | `length` | `too-large` | `reason` | `code` | `json` |
|---|---|---|---|---|---|---|---|---|
| `src/frames.ts` | `truncated` | `unknown-type` | `bad-stream` | `bad-length` | `too-large` | `bad-reason` | `bad-code` | `bad-push` |

The relay's `too-many-tokens` is the one difference: `decodeFrame` returns the
33-token `PUSH_SET` (the sender or a fake relay applies `MAX_PUSH_TOKENS`), and
the test checks the count on the decoded tokens.

A case the codec fails is a finding, not something to fix in the test: decide
from the protocol which side is wrong, fix that codec, and if the protocol
does not say, add an entry to `gurt-relay/docs/NOTES-for-gurt.md`. New cases go
in the relay's generator (`go run ./internal/vectors/gen`), so that the Go
codec runs them too — do not add Gurt-only frame vectors.

### Keeping the copy current

The copy must never be edited by hand. When `gurt-relay/testdata/` changes:

```sh
node packages/remote-protocol/scripts/sync-relay-vectors.mjs --update ../gurt-relay
node packages/remote-protocol/scripts/sync-relay-vectors.mjs --check  ../gurt-relay
node --test packages/remote-protocol/test/relay-vectors.test.mjs
```

and commit `testdata/relay/` with whatever `frames.ts` needed. The test suite
checks the copy twice: against `relay/SHA256SUMS` always (so a hand-edited copy
fails), and against a gurt-relay checkout when one sits next to this repository
or `GURT_RELAY_DIR` points at one (so a copy that fell behind fails; the check
is skipped, and reported as skipped, without a checkout). CI should have the
relay checked out and run `--check`.

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
