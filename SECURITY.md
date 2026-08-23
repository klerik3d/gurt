# Security

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub: **Security → Report a
vulnerability** on this repository (a private security advisory). Do not open a
public issue for security problems. You should receive a response within a few
days.

## Supply-chain surface

gurt is a supply-chain-sensitive application: at runtime it provisions dev
containers and installs software into them.

- The app installs **ACP adapter packages from npm** (see
  `src/shared/agents.ts`) into the child containers it provisions. These are
  pinned to exact versions; they are updated only through gurt releases, never
  resolved to `latest` at install time.
- Child containers hold **clones of the user's repositories and agent
  secrets** (API keys / OAuth tokens injected via env vars), so anything
  installed into them runs next to that data.
- Devcontainer **features are pinned by OCI digest** rather than mutable tags
  (`src/main/provision.ts`, `src/main/git/providers.ts`,
  `.devcontainer/devcontainer.json`).
- The repo itself blocks npm lifecycle scripts (`.npmrc` `ignore-scripts`) and
  runs an explicit allow-list via `@lavamoat/allow-scripts`; install-time and
  build tooling is pinned to exact versions, and GitHub Actions are pinned by
  commit SHA.

If you find a way to get unpinned or attacker-controlled code into the app, the
build, or a provisioned container, that is in scope — please report it.
