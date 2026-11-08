# @gurt/remote-protocol

The wire contracts of Gurt's remote access, in TypeScript, shared by Gurt
(Electron main) and the mobile app (React Native / Hermes). The contract
itself is `docs/requirements-remote-protocol.md` in the Gurt repository; this
package is its one TypeScript implementation.

| Module | Protocol section |
|---|---|
| `frames.ts` | §3 — the host-socket frame codec, push frames included |
| `register.ts` | §2, §3.2 — host id, the registration signature |
| `noise.ts` | §6.1 — Noise IK and IKpsk1, `25519_ChaChaPoly_BLAKE2s` |
| `channel.ts` | §6 — modes, prologue, handshake payloads, pairing code, chunked transport |
| `pairing.ts` | §5 — `gurt://pair#…` and `gurt://relay#…` |
| `rpc.ts` | §7, §7.7 — the JSON-RPC envelope and error codes |
| `remoteApi.ts` | §7.1–§7.4 — `RemoteApi` (phase 1), events, `remote.*`, hello |

## Runtime rules

- **No Node-only or browser-only APIs.** No `Buffer`, `TextEncoder`,
  `crypto`, `URL`; `tsconfig.json` checks against `lib: ES2022` with no
  `types`, and the tests bundle for esbuild's `neutral` platform.
- **Randomness** comes only from `@noble`'s `randomBytes`, i.e.
  `crypto.getRandomValues`. Under Hermes the app must install an OS-backed
  polyfill before this package loads (e.g. `react-native-get-random-values`).
  Without one, key generation throws; nothing falls back to `Math.random`.
- Crypto primitives: `@noble/curves` (X25519, Ed25519), `@noble/ciphers`
  (ChaCha20-Poly1305), `@noble/hashes` (BLAKE2s, SHA-256, HMAC).

## Tests

```sh
node --test packages/remote-protocol/test/*.test.mjs   # also part of `npm test` at the root
```

Vectors live in `testdata/` (format: `testdata/README.md`); regenerate the
generated ones with `node packages/remote-protocol/scripts/gen-testdata.mjs`.

## Publishing

Not published yet (remote-access §13 Q8: the first publish waits for the
first working pairing). `exports` points at the TypeScript sources, which
Metro, Vite and esbuild consume directly; a compiled `dist/` comes with the
first publish.
