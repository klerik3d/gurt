# Disabled opacity: one token

## Disabled opacity

Decision (agreed with the owner): every disabled control is dimmed by one
value, the token `--op-disabled` (`0.5`) in `:root` of
`src/renderer/src/styles.css`, next to the motion tokens. The five earlier
values (0.4, 0.45, 0.5, 0.6) were folded onto it; nothing is tuned per call
site.

Rules:

- `button:disabled` sets `opacity: var(--op-disabled)`. Every `<button>`
  inherits it, so `.send-btn`, `.diff-menu-action`, `.file-tree-row` and
  `.file-action` repeat nothing and keep only non-opacity declarations
  (`cursor`, `background`).
- A control that is not a `<button>` (`.input:disabled`) sets
  `opacity: var(--op-disabled)` itself. No raw number.
- An override that equals the base value is deleted, not repeated.
- Not covered: pending states (`.wc-row.wc-pending`, 0.45) and decorative
  opacities (watermarks, hover fades, pulses).

Check (prints only rules that use `var(--op-disabled)`):

```sh
grep -nE 'disabled[^{]*\{[^}]*opacity' src/renderer/src/styles.css
```

grep is line-based: it sees only one-line rules, so today it prints nothing.
For the multi-line rules (`button:disabled`, `.input:disabled`) use

```sh
grep -nA2 -E 'disabled *\{' src/renderer/src/styles.css | grep opacity
```

which must print only `opacity: var(--op-disabled);` lines.
