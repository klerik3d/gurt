# Files mode

Use **Files** in the activity bar (Ctrl/Cmd+5, remappable in Settings → Hotkeys).
Expand a scope, repository and folders in the Scopes panel. Click a file to
open it in a tab. The explorer loads folders on demand, shows dotfiles and
untracked files, and excludes Git internals and Gurt's session/configuration
metadata. Arrow keys navigate the tree; Enter opens a file or folds a folder.
Refresh reloads the folder listings. Listings also refresh after agent turns
and when the application regains focus.

Scopes share their row height, change indicators, folding and name/creation
sorting in Agents, Diff and Files. Clicking a scope name toggles it in every
mode. Folding and sorting are saved across restarts; repository folders keep
their own expansion state. The filter below the Scopes header
matches scope names with a case-insensitive regular expression, for example
`^api|frontend$`. It stays active when switching modes. Escape clears it and
returns focus to the tree. An invalid expression shows an error and leaves
the scopes visible.

Diff mode also uses CodeMirror, with the same theme, syntax support and
Ctrl/Cmd+F search as Files. Split compares the original and current versions
side by side; Unified displays deletions above additions. Both views are
read-only, for uncommitted changes and individual commits. Long unchanged
sections can be expanded in place.

Git and Files also share tree rows: the same selection and focus highlights,
12 px text, 13 px icons and 14 px indentation per level. Git's change groups
add a hierarchy level; repositories, folders and files follow the same spacing.

Tabs belong to their scope. Switching scopes, workspaces, modes or dashboard
keeps unsaved text, undo history, selection and scroll position in memory.
Restarting restores the file paths, active tabs and expanded folders, loading
saved text from disk. Unsaved source text is never stored in localStorage.

The editor uses CodeMirror 6. Language support loads on demand by filename:
JavaScript/TypeScript/JSX/TSX, Python, Go, Rust, Java, C/C++, C#, Ruby, PHP,
HTML/CSS, JSON, YAML, Markdown, SQL, shell, Dockerfile and other bundled modes.
Unrecognized files open as plain text. Text files must be UTF-8 and at most
2 MiB; binary files and symbolic links show an explanation instead.

| Action | Shortcut |
| --- | --- |
| Save | Ctrl/Cmd+S |
| Close tab | Ctrl/Cmd+W or the tab's × |
| Find / replace panel | Ctrl/Cmd+F |
| Go to line | Ctrl/Cmd+Alt+G |
| Go to definition (JS/TS) | F12 or Ctrl/Cmd+click |
| Find references | Shift+F12 |

Save writes to the scope's actual clone. It checks the content version first:
if an agent or external editor changed the file, saving reports a conflict
and keeps the local buffer. Reload discards local changes after confirmation.
Clean active buffers refresh on activation, window focus and the end of an
agent turn. Closing a dirty tab or leaving the application asks before
discarding changes. Existing CRLF line endings, UTF-8 BOMs and file
permissions are preserved.

Definition and reference navigation for JS/TS uses the TypeScript language
service, including unsaved buffers and the nearest tsconfig/jsconfig's direct
compiler options and path aliases. Results open the target tab at the symbol.
It indexes source inside the current repository only: dependencies, generated
directories, hidden directories and links are excluded. Config `extends`,
project references and cross-repository navigation are not resolved. No
project plugins or commands are executed. Searches stop at 3,000 visited
entries, 24 MiB of indexed text or 500 results and show when a limit is reached.

Other languages offer **Word matches**, a labelled text search through the
repository; their Definition action is disabled. Semantic navigation for
those languages would require language servers as a separate integration.

## Artifacts

Every scope has an **artifacts** directory beside its repositories: the last
root under the scope in the Scopes panel. Every session container of the
scope mounts it read-write at `/workspaces/artifacts`, and the gurt MCP
server's instructions tell agents about it. It is not a repository, so nothing
in it is committed, reviewed or shipped. Use it for reports, screenshots, logs,
notes and intermediate data that several sessions and the user should see, but
that should not go into a repo. It lives in the scope's directory and is
deleted with the scope. Archiving a scope does not keep it: archives hold only
gurt's own state. `artifacts` is reserved as a repository name.
Containers created before this directory existed are re-created once at their
next start to add the mount. Only in-container state is lost; the clones and
agent history are bind mounts.

## Images and Markdown

PNG, JPEG, GIF, WebP, AVIF, BMP, ICO and SVG files open in an image viewer,
up to 20 MiB. The image fits the pane; click it for its actual size. SVGs are
shown as images, so their scripts never run.

Markdown files open rendered (GitHub-flavoured: tables, task lists,
strikethrough). **Preview / Edit** above the file switches to the editor and
back; Preview shows unsaved edits. Relative links open the target file in
Files, including `#L12` line anchors and links into another repository of the
scope (`../other-repo/…`). Relative images load from the scope. Remote images
are blocked by the app's content security policy and show as their alt text.

## Links in agent messages

A path in an agent's message opens the file in Files, on the line if one is
given. This covers inline code such as `src/a.ts:12`, `src/a.ts:12:3` or
`/workspaces/<repo>/src/a.ts`, and Markdown links such as
`[a.ts](src/a.ts#L12)`. Container paths under `/workspaces/<repo>` and
`/workspaces/artifacts` map to that root. A relative path is tried as rooted at
a repository, then relative to each repository of the session. Inline code
turns into a link only once the file is confirmed to exist in the scope, so
identifiers like `fs.readFile` stay plain. A missing target of a Markdown link
shows a notice instead.

