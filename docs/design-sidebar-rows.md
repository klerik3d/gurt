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
