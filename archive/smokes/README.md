# Archived scenario smokes

Pre-redesign Electron smoke scripts, moved out of `scripts/` when the test setup
migrated to vitest (`tests/*.test.ts`, `npm test`). Their selectors predate the
warm-graphite redesign and no longer match the UI, but each script encodes an
acceptance flow from a `docs/requirements-*.md` — kept as reference for
rebuilding scenario smokes against the current UI.

The living smoke is `scripts/smoke-boot.mjs` (`npm run smoke`): build, launch,
render, no renderer console errors.
