# Corner radii: one scale

Decision (agreed with the owner): every `border-radius` in the renderer comes
from one scale defined in `:root` of `src/renderer/src/styles.css`.

| Token | Value | Typical use |
|---|---|---|
| `--r-xs` | 2px | hairline bits: bars, tiny marks |
| `--r-sm` | 4px | buttons, inputs, small chips |
| `--r-md` | 6px | cards, menus, popovers |
| `--r-lg` | 8px | panels, larger cards |
| `--r-xl` | 12px | dialogs, large icon tiles |
| `--r-pill` | 999px | pills |

Rules:

- New radii use only `var(--r-*)`. No raw pixel radii outside `:root`, and no
  fractional values (`5.333px` and the like were left over from a ×1.333
  rescale and were rounded onto the scale).
- Circles stay `50%`; `0` and `inherit` are fine as they are.
- Multi-value radii use the tokens per corner, e.g.
  `var(--r-md) var(--r-md) 0 0`.
- The same applies to inline `borderRadius` in `*.tsx`: use the variable or a
  class.

Check (should print nothing):

```sh
grep -nE "radius[^;]*[0-9]px" src/renderer/src/styles.css
git grep -nIE "borderRadius" -- '*.tsx'
```
