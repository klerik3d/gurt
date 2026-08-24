# Contributing to gurt

Thanks for your interest in contributing! This is a short, factual guide to
getting the project running and getting a change merged.

## Prerequisites

- **Node.js >= 22** and **npm >= 9** (enforced via `engine-strict` in
  `.npmrc` — install fails fast on an older toolchain). The pinned package
  manager is npm (see `packageManager` in `package.json`).
- **Docker** — required at runtime: gurt provisions devcontainer environments
  and runs agent sessions in them. UI-only work and most unit tests run
  without it.
- Platforms: **macOS and Linux are the primary platforms; Windows is a
  candidate (untested)**.

You can also develop gurt itself inside its devcontainer (`.devcontainer/`),
which ships Node 22, Docker-in-Docker and a headless display for Electron —
see the "Dev container" section of the [README](README.md).

## Setup

```bash
npm run setup    # npm ci + npx allow-scripts
```

npm lifecycle scripts are disabled globally (`ignore-scripts=true` in
`.npmrc`); the few packages that need their install scripts are allow-listed
in `package.json` and run explicitly via `npx allow-scripts` — hence the
`setup` script instead of a bare `npm ci`.

## Running in dev

```bash
npm run dev
```

This starts electron-vite: the Electron app with the renderer served by Vite
(hot reload). Starting environments from the app requires a running Docker
daemon. See the [README](README.md) for `GURT_ROOT`, logging and other
runtime details.

## Building

```bash
npm run build    # electron-vite build → out/
npm run dist     # build + electron-builder package → release/
```

Packaging is currently configured for **macOS only** (unsigned dmg — see
`electron-builder.yml` and the "Packaging" section of the README).

## Type-checking and lint

```bash
npm run typecheck   # tsc over the main/renderer/scripts tsconfigs
npm run lint        # eslint .
```

There is no Prettier or EditorConfig in the repo — formatting-wise, match the
surrounding code; correctness is held by the TypeScript compiler and ESLint.

## Tests

```bash
npm test
```

This runs every `scripts/*.test.mjs` through Node's built-in test runner —
the same command CI uses. To run one file: `node --test scripts/<name>.test.mjs`.

Smoke tests (`scripts/smoke*.mjs`) drive the built app end-to-end with
Playwright. `npm run smoke` runs the docker-free subset (CI runs it as its own
job); the rest need Docker and agent secrets, and are run by hand after
`npm run build`. The README's "Smoke tests" section lists each script.

### Why the suite looks like this

There is no Vitest or Jest, and tests are not split into unit/integration/e2e.
The dividing line is instead **does it need the built app and a display** —
that is the smoke tier — and everything else is one flat pile of `*.test.mjs`,
whether it checks a pure function or drives a real HTTP server.

No test framework, because gurt is supply-chain-sensitive (see `SECURITY.md`:
it installs packages into containers holding your repos and agent secrets).
The repo blocks npm lifecycle scripts, pins Actions by SHA and devcontainer
features by digest, and keeps a deliberately small dependency tree. A test
runner is a large dev dependency whose whole job is executing code in CI, so
it is not a free addition here. Node 22 is already the floor, so `node:test`
covers it for nothing; esbuild is already a build dependency, so bundling the
real TypeScript costs nothing either.

Which matters, because the rule is: **assert against the real modules.** A
test bundles `src/**` with esbuild and imports it. Logic is never restated in
the test — that is how a suite quietly ends up testing a copy of itself. What
gets faked is the process boundary: the docker CLI, a spawned child, the
`electron` module. Isolation comes from one process per file, which the runner
gives you, rather than from a framework resetting module state.

### Writing one

Copy the closest existing file: `usage.test.mjs` for pure logic,
`session-delete-container.test.mjs` for a fake docker CLI, `gurt-mcp.test.mjs`
for a real server, `log.test.mjs` for a module that must run in a child.

Name the file after the requirement it pins, not the module it imports
(`turn-contract`, `session-roles`, `queue-handoff`), and name each `test()`
after the behaviour it proves. Several correspond to a `docs/requirements-*.md`.

Three things will bite you, and all three fail quietly rather than loudly:

- **`test()` registers; the body runs later.** Cleanup at the end of the file
  would run before any test touches its fixtures. Use `after()`.
- **Never register a `test()` above a top-level `await`.** The runner drains
  what is registered, decides the file is done, and fires `after()` while
  module evaluation is still suspended — so later tests are wiped or never
  registered, and the in-memory ones still pass. Finish all module-level
  `await`s before the first `test()`.
- **No fixed sleeps, no wall-clock assertions.** Poll for the condition. Logs
  and other queues reach disk asynchronously, and a `readFileSync` that lands
  early makes "the secret is absent" pass on an empty file.

Tests run sequentially (`--test-concurrency=1`) and in declaration order, so a
file may build state across its tests. Do not add `{ concurrency: true }`.

Before pushing, make the assertion fail on purpose once and check that it
fails for the reason you expect. A test that cannot fail is worse than none.

## Pull requests

Fork the repo (or create a branch) and open a PR against `main`. CI runs on
every push and pull request; a PR should be green on all of it:

- `npm ci --ignore-scripts` + `npx allow-scripts`
- `npm audit signatures`
- `npm run typecheck`
- `npm run lint`
- `npm test`

Running `npm run typecheck`, `npm run lint` and `npm test` locally before
pushing covers most of it.
