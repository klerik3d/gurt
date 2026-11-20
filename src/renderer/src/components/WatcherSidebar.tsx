import { useEffect, useState, type CSSProperties } from 'react'
import type { Tree } from '../../../shared/types'
import { watcherStatusOf, type WatcherPhrase, type WatcherView } from '../../../shared/watchers'
import type { Tone } from '../status'
import { Icon, Dot } from './icons'
import { LabelTag } from './tags'
import { RenameInput, scopeNamesOf } from './Sidebar'
import { scopeNameInput } from '../../../shared/scopeName'
import { alertDialog } from '../dialog'
import { run } from '../async'

/** The status dot's tone, in the app's own tones. */
export const WATCHER_TONE: Record<WatcherPhrase['tone'], Tone> = {
  red: 'red',
  yellow: 'yellow',
  blue: 'accent',
  grey: 'faint',
  green: 'green',
  hollow: 'faint'
}

/** What a watcher's dot and phrase say (docs/requirements-watchers.md §3). */
export function watcherDot(w: WatcherView, now: number): { phrase: WatcherPhrase; tone: Tone; pulse: boolean; hollow: boolean } {
  const phrase = w.session
    ? watcherStatusOf(w.session, w.config, now)
    : ({ status: 'draft', tone: 'hollow', text: 'not started' } as const)
  return { phrase, tone: WATCHER_TONE[phrase.tone], pulse: phrase.status === 'working', hollow: phrase.tone === 'hollow' }
}

/** Left sidebar of the Watchers mode: the workspace's watchers, newest first,
 *  one row each — status dot and phrase, name, label. No nested rows: there
 *  are no runs (§12). */
export function WatcherSidebar({
  tree,
  ws,
  width,
  selected,
  onSelect,
  onNew,
  onRenamed
}: {
  tree: Tree | null
  ws: string | null
  width: number
  selected: string | null
  onSelect: (name: string) => void
  onNew: () => void
  onRenamed: (newName: string) => void
}) {
  const wsData = tree?.workspaces.find((w) => w.name === ws)
  const watchers = wsData?.watchers ?? []
  // The phrases carry times ("sleeping until …", "paused — due …"): tick so a
  // wake that fell due reads as such without waiting for a tree push.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [])
  const [renaming, setRenaming] = useState<{ name: string; draft: string } | null>(null)
  const rename = scopeNameInput(renaming?.draft ?? '', scopeNamesOf(wsData), renaming?.name)
  const commitRename = async (): Promise<void> => {
    const cur = renaming
    if (!cur || !ws) return
    setRenaming(null)
    if (!rename.name || rename.name === cur.name || rename.error) return
    try {
      await window.gurt.renameTask(ws, cur.name, rename.name)
      onRenamed(rename.name)
    } catch (e) {
      await alertDialog(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sb-head">
        <div className="sb-ws">
          <span className="sb-ws-name">Watchers</span>
        </div>
        <span className="spacer" />
        <button className="icon-sq" title="New watcher" aria-label="New watcher" onClick={onNew}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      <div className="sb-tree" role="tree" aria-label="Watchers">
        {watchers.map((w) => {
          const dot = watcherDot(w, now)
          const active = w.session?.watcher && !w.session.watcher.end
          return (
            <div key={w.name} className="sb-group">
              <div
                className={`sb-task pa-row ${w.name === selected ? 'selected' : ''}`}
                role="treeitem"
                aria-selected={w.name === selected}
                title={dot.phrase.text}
                tabIndex={0}
                onClick={() => onSelect(w.name)}
                onDoubleClick={() => !active && setRenaming({ name: w.name, draft: w.name })}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return
                  if ((e.key === 'Enter' || e.key === 'F2') && !active) {
                    e.preventDefault()
                    setRenaming({ name: w.name, draft: w.name })
                  }
                }}
              >
                <Dot tone={dot.tone} pulse={dot.pulse} hollow={dot.hollow} />
                {renaming?.name === w.name ? (
                  <RenameInput
                    value={renaming.draft}
                    error={rename.error}
                    onChange={(draft) => setRenaming({ name: w.name, draft })}
                    onCommit={run(commitRename)}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <span className="sb-task-name">{w.name}</span>
                )}
                <span className="spacer" />
                <span className="sb-session-client">{dot.phrase.text}</span>
                {w.config.label && <LabelTag label={w.config.label} />}
              </div>
            </div>
          )
        })}
        {tree && !watchers.length && (
          <div className="sb-empty pa-empty" style={{ '--level': 1 } as CSSProperties}>
            No watchers yet. A watcher is one long-lived session that monitors an outside process —
            a release, a CI run — and calls you when it needs you. “+” to add one.
          </div>
        )}
      </div>
    </aside>
  )
}
