# Stacking: one named layer scale

Decision: every `z-index` in the renderer that takes part in app-wide stacking
comes from the layer tokens in `:root` of `src/renderer/src/styles.css`. The
numeric values are the ones the app already used, so this changed names, not
behaviour.

| Token | Value | Layer | Used by |
|---|---|---|---|
| `--z-raised` | 4 | in-flow raise / floating control | `.pinned-req`, `.jump-latest`, `.sidebar-resizer` |
| `--z-float` | 20 | fixed hover panel | `.ts-panel` (tool strip panel) |
| `--z-composer-menu` | 30 | composer popup | `.cmp-menu` |
| `--z-menu` | 40 | dropdown menu | `.menu` |
| `--z-ctx-menu` | 50 | pointer-anchored context menu | `.ctx-menu` |
| `--z-popover` | 60 | info popover, notification panel | `.info-pop`, `.notif-panel` |
| `--z-toast` | 80 | notification popup stack | `.popup-stack` |
| `--z-modal` | 100 | modal backdrop and its dialog | `.modal-backdrop` |
| `--z-progress` | 1500 | archive progress card, above everything incl. modals | `.archive-progress` |

The order matters and is kept exactly: a toast sits under a modal, the archive
progress card sits over it. Layers that can meet on screen keep their own
token (a composer popup vs. a dropdown, a dropdown vs. a context menu), so no
pair that can overlap changes its winner. Two tokens are shared deliberately:

- `.info-pop` and `.notif-panel` shared `60` and still tie, so they share
  `--z-popover` (later in the DOM wins, as before).
- `.sidebar-resizer` was `5` and `.pinned-req`/`.jump-latest` were `4`. They
  are folded into `--z-raised` (4): the resizer lives in the gap between the
  sidebar and `.main`, and the other two are inside `.main`, which clips its
  contents (`overflow: hidden`), so they can never overlap.

Local stacking stays raw: `z-index: 1` on `.menu-filter` (sticky filter above
the scrolling options of its own menu) and on `.copy-btn` (button above its
host's content) only orders a child against its siblings inside one
component. `0` and `-1` are allowed for the same purpose.

Rules:

- New app-wide layers use `var(--z-*)`. No raw `z-index` outside `:root`,
  except a purely local `0`, `1` or `-1`.
- Pick the lowest layer that does the job; add a token (with a row above)
  rather than a one-off number like `9999`.
- The same applies to inline `zIndex` in `*.tsx`: use the variable or a class.

Check (should print nothing):

```sh
grep -n "z-index" src/renderer/src/styles.css | grep -vE "var\(--z-|--z-[a-z-]+: [0-9]+;|z-index: (-?1|0);|design-z-index"
git grep -nE "zIndex|z-index" -- '*.tsx'
```
