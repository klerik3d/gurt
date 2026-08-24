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

### Coverage

```bash
npm run coverage
```

Same 220 tests, plus line/branch/function numbers per `src/**` module, a
ranking of the least-covered ones, and a list of the modules the report says
nothing about. It is a separate command because measuring costs around 75% more
wall clock, and `npm test` is run far more often than it is read.

Nothing is gated on the number, on purpose. A threshold over a suite with the
blind spots below fails on true statements and passes on false ones, and the
cheapest way to satisfy it is always to import a module rather than test it.

**How it works.** Coverage is normally useless here: a test bundles `src/**`
into a temp file with esbuild and imports *that*, so V8 attributes every line to
`/tmp/gurt-*.mjs`. `npm run coverage` sets `GURT_COVERAGE=1`, which makes
`scripts/lib/bundle.mjs` emit an inline source map, and runs node with
`--enable-source-maps` so the reporter walks each line back to its `.ts` file.

Two wrinkles are worth knowing about before you hit them.

esbuild folds a dependency's own source map into ours, and
`@modelcontextprotocol/sdk` ships maps naming `.ts` files it does not publish.
Node's coverage reporter resolves every source *before* it applies any filter
and abandons the whole report at the first one it cannot read — so one phantom
path costs you all 32 files, and `--test-coverage-exclude` cannot save you
because it runs too late. `bundle.mjs` fills those entries' `sourcesContent`
with an empty string after the build; the comment there says why they are not
simply deleted.

And each test file is measured in a `node --test` of its own rather than all 32
at once, because the same module is compiled into a dozen different bundles
across the suite and Node's merge across them loses coverage. Measured alone,
`src/shared/usage.ts` is 103 of 112 lines; measured in a run that also loads the
bundles where it is only a passenger, it reads 82. The zero ranges of the
passenger copies mask the real ones. `scripts/lib/coverage-merge.mjs` unions the
separate runs instead.

**How to read it.** The command prints its own caveats and they are not
boilerplate — the number means much less than it looks like without them:

- **Absent is not zero.** A module no test bundles never reaches V8, so it is
  missing from the table rather than scoring 0% in it. The total is an average
  over what was measured. The report lists exactly which modules are missing;
  most of `src/renderer/` is, since only a handful of its pure-logic modules
  have unit tests and the rest lives on the smoke tier.
- **Child processes are counted.** Node hands `NODE_V8_COVERAGE` to every
  descendant, so `log.test.mjs`, which runs each of its ~20 scenarios in a
  process of its own, contributes normally — `src/main/log.ts` scores near 90%
  off that file alone. Structure a test that way when the module needs it; it
  costs you nothing here.
- **Smoke is not counted.** `npm run smoke` drives the packaged build, which
  has no source map back into `src/`. Anything only smoke exercises reads as
  uncovered.
- **Lines are exact; branches are a floor.** The summary Node emits identifies a
  branch only by its line, so the union across runs cannot tell two branches on
  one line apart. A `--` in the branch or function column is not 0% either — it
  means Node attributed none to that file, so there is no denominator.
- **Covered is not tested.** A module imported as a dependency of the module
  under test is executed at import time and counted, with nothing asserting
  anything about it. `src/shared/types.ts` scores well for exactly this reason.

So: use it to find modules nobody has gone near, and to check that a test you
just wrote reaches what you think it reaches. Do not quote the total.

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

Bundle through `bundle()` from `scripts/lib/bundle.mjs` rather than calling
esbuild directly — it holds the five options every test shares, and it is where
`npm run coverage` adds source maps. Pass it whatever else your test needs
(`external`, `plugins`, `outfile`) exactly as you would pass esbuild.

Name the file after the requirement it pins, not the module it imports
(`turn-contract`, `session-roles`, `queue-handoff`), and name each `test()`
after the behaviour it proves. Several correspond to a `docs/requirements-*.md`.

Four things will bite you, and all four fail quietly rather than loudly:

- **`test()` registers; the body runs later.** Cleanup at the end of the file
  would run before any test touches its fixtures. Use `after()`.
- **Never register a `test()` above a top-level `await`.** The runner drains
  what is registered, decides the file is done, and fires `after()` while
  module evaluation is still suspended — so later tests are wiped or never
  registered, and the in-memory ones still pass. Finish all module-level
  `await`s before the first `test()`.
- **No fixed sleeps, no wall-clock assertions.** Poll for the condition. Logs
  and other queues reach disk asynchronously, and a `readFileSync` that lands
  early makes "the secret is absent" pass on an empty file. Poll for the exact
  thing you are about to assert on, too: waiting for a directory's child to
  disappear does not mean the directory is gone.
- **Files run in parallel, so own everything you touch.** A hardcoded port, a
  fixed path under `/tmp`, a shared docker image tag: each one passes on its
  own and keeps passing until the file that wants the same thing happens to
  land in the same batch. Derive every name — `mkdtemp()` for a directory,
  port `0` for a listener, `${process.pid}` for a scratch file, a per-test tag
  for an image. The collision surfaces as a failure in whichever file lost the
  race, which is rarely the one that was at fault.

Test *files* run in parallel, one process each, up to the runner's default
concurrency. Inside a file nothing changed: `node:test` still runs that file's
tests one at a time, in declaration order, so a file may build state across its
tests. Do not add `{ concurrency: true }` — that is the *inner* switch, for
tests within a file, and it stays off.

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
