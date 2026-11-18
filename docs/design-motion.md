# Transition durations: two tokens

Decision (agreed with the owner): every `transition` in the renderer takes its
duration from two tokens defined in `:root` of
`src/renderer/src/styles.css`, next to the radii. Easing stays `ease`.

| Token | Value | Typical use |
|---|---|---|
| `--dur-fast` | 120ms | hover, colour, border, opacity fades |
| `--dur-base` | 200ms | movement and size: transform, width, slide-ins |

Rules:

- New transitions use only `var(--dur-*)`. No raw `ms` in a `transition`
  outside `:root`.
- Keyframe animations (`pulse`, `ts-pulse`, `diff-refresh`, `pinned-swap`)
  keep their own durations; only `transition` is covered.
- `transition: none` rules (`prefers-reduced-motion` and the like) stay as
  they are.

Check (should print nothing; transitions can span several lines, hence the
second pattern, which also matches nothing else in the file today):

```sh
grep -nE "transition[^;]*[0-9]ms" src/renderer/src/styles.css
grep -nE "^\s+[a-z-]+ [0-9]+ms" src/renderer/src/styles.css
```
