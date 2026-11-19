# Font sizes: one type scale

Decision (agreed with the owner): every `font-size` in the renderer comes from
one scale defined in `:root` of `src/renderer/src/styles.css`. Tokens are named
by their pixel size, so the value is obvious at the call site.

| Token | Value | Typical use |
|---|---|---|
| `--fs-9` | 9px | micro labels, badges |
| `--fs-10` | 10px | captions, tiny meta |
| `--fs-11` | 11px | dense secondary text (most common) |
| `--fs-12` | 12px | body in dense lists, controls |
| `--fs-13` | 13px | default body text |
| `--fs-14` | 14px | emphasised body, small headings |
| `--fs-15` | 15px | headings |
| `--fs-16` | 16px | headings |
| `--fs-17` | 17px | large headings |
| `--fs-18` | 18px | largest headings |

Rules:

- New sizes use only `var(--fs-*)`. No raw pixel `font-size` outside `:root`,
  and no fractional values (`10.5px` and the like were left over from a ×1.333
  rescale and were rounded half-up onto the scale: 8.5→9, 9.5→10, 10.5→11,
  11.5→12, 12.5→13, 13.5→14, 14.5→15).
- `em`, `rem`, `%` and keywords (`inherit`, `smaller`) are fine as they are.
- The same applies to inline `fontSize` in `*.tsx`: use the variable or a
  class. The one exception is the xterm.js `Terminal` option `fontSize`
  (a number of pixels, not CSS) in `TerminalSidebar.tsx`.

Check (the first should print only the `:root` token definitions, the second
only the xterm option):

```sh
grep -nE "font-size: *[0-9.]+px" src/renderer/src/styles.css
git grep -nIE "fontSize" -- '*.tsx'
```
