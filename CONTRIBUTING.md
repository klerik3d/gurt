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

This runs every `scripts/*.test.mjs` (docker-free unit tests, each a
self-contained node script) via `scripts/run-tests.mjs` — the same command CI
uses. To run a single test: `node scripts/<name>.test.mjs`.

Smoke tests (`scripts/smoke*.mjs`) are separate: they drive the built app
end-to-end with Playwright (run `npm run build` first; some need Docker) and
are not part of `npm test` or CI. The README's "Smoke tests" section lists
each script and what it covers.

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
