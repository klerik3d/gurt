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

## Letter-spacing

Decision (agreed with the owner): uppercase mono labels take their
`letter-spacing` from three tokens in `:root` of
`src/renderer/src/styles.css`, not from ad-hoc `em` values.

| Token | Value | Typical use |
|---|---|---|
| `--ls-tight` | 0.08em | labels in tight spots: pinned bars, message and tool-kind tags, nav folds |
| `--ls-label` | 0.12em | the default section label (`.seclabel`), badges, sub-folds |
| `--ls-wide` | 0.14em | menu and palette group heads, section heads in panels |

Rules:

- New uppercase labels use only `var(--ls-*)`. No raw `em` letter-spacing
  outside `:root`.
- `normal` and the spacing of non-uppercase text (`.ts-mcp-srv`, 0.04em) stay
  as they are.
- An override that equals the base value is deleted, not repeated.
- Why three: the file had 0.06, 0.08, 0.1, 0.12 and 0.14em for the same kind
  of label, with no reason for the differences. They were folded onto the
  nearest step (0.06→tight, 0.1→label). Do not re-tune the values per
  call site; if a label looks off, pick another token.

Check (should print only `.ts-mcp-srv`, the non-uppercase exception; the
token definitions are `--ls-*` custom properties and do not match):

```sh
grep -nE "letter-spacing: *[0-9.]+em" src/renderer/src/styles.css
```
