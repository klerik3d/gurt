# Left sidebar: one row geometry

Decision (agreed with the owner): every row of the left sidebar — scope,
session, run, file, git — is the same row. No exceptions.

| Parameter | Value |
|---|---|
| row height / pitch | 24px, no gap or margin between rows |
| font | IBM Plex Sans 12px / 400 / line-height 16px, in every state (selected too) |
| padding | 4px vertical, 10px right, 10px left + 9px × level |
| levels | scope 0, session/folder 1, reviewer/file 2 … |
| chevron slot | 12px, always reserved |
| icon | 14px |
| gap between chevron, icon, text | 6px |
| right-hand meta | 10.5px mono, `--faint` |
| background | passive transparent; hover, cursor (focus), selected `--hover` |
| text colour | passive `--dim`; hover, cursor, selected `--text` |
| border | none, in any state |
| notes / empty states | 12px, `--faint`, same padding as a row |

Implemented by the `--row-*` variables and the shared rule in `styles.css`
(`.sb-task, .sb-session, .file-tree-row`). Open points, decided as in the
table: selected and cursor share one colour; scope rows lose their bold
weight, so hierarchy rests on indent and chevron.

Notes use one class, .sb-empty, indent via --level; no inline pixel paddings

## Holding still

The scope panels (Agents, Git, Files) never move a row the user did not ask
to move:

- The tree always reserves its scrollbar gutter (`scrollbar-gutter: stable`),
  so the scrollbar appearing does not narrow the rows.
- The header is one 32px line with the same actions in every mode: title,
  the accordion toggle, sort, fold all, new scope. Mode-specific actions
  (Git's list/tree and refresh, Files' refresh) sit on the filter line;
  notes that come and go (Git's refresh error, marked-files filter) sit under
  the tree.
- Switching mode keeps the active scope's row on the same pixel
  (`scopeAnchor.ts`): the new panel scrolls to put it back and holds it
  through the renders that follow. Scrolling is all it uses, like the
  browser's own scroll anchoring: where the new content leaves too little
  room above or below the row, the scroll stops at its end and the row moves
  by just the shortfall — the tree is never padded, so it never shows a gap.
  Only a row fully in view is held; one scrolled out of view is scrolled
  into view on the switch instead. A newly selected scope is held the same
  way while the accordion folds the previous one: a scope folding out of
  view above moves nothing on screen, one folding in view lets the clicked
  scope rise, as in any accordion.
- Accordion mode (on by default, toggle right of the title): selecting a
  scope folds every other one and opens it; opening another scope by hand
  makes it the active one, and "Expand all" is off. At launch the others
  fold and the active scope keeps its restored fold. With nothing selected
  every scope folds, except the last active one (say, after its open session
  was deleted), which keeps its fold.
