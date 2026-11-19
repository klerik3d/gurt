# Shadows and scrims: one elevation scale

Decision: every drop shadow and modal scrim in the renderer comes from the
tokens defined in `:root` of `src/renderer/src/styles.css`, next to the
`--dur-*` tokens. Each shadow token keeps the `--shadow-strength` calc inside,
so the user's shadow-strength setting still applies.

| Token | Value | Typical use |
|---|---|---|
| `--shadow-sm` | `0 2px 10px`, 0.25 | small floats: toasts, tooltip-like bits |
| `--shadow-md` | `0 12px 32px -12px`, 0.6 | menus, popovers |
| `--shadow-lg` | `0 32px 80px -24px`, 0.75 | dialogs |
| `--shadow-xl` | `0 40px 90px -24px`, 0.8 | large modals |
| `--scrim` | `rgb(0 0 0 / 0.5)` | the backdrop behind a modal (one value) |

Rules:

- New shadows use only `var(--shadow-*)`; new backdrops use `var(--scrim)`.
  No raw `box-shadow` offsets/colours or `rgba(0, 0, 0, …)` backgrounds
  outside `:root`.
- Pick the token by element kind, not by looks.
- `var(--glow)` (focus ring), `none` and `inset` shadows are not part of the
  scale and stay as they are.

Check (should print nothing outside `:root`):

```sh
grep -nE 'box-shadow:[^;]*[0-9]px [^;]*rgb' src/renderer/src/styles.css
```
