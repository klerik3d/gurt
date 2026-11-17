import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { Appearance, TextSize, ThemeMode } from '../../../../shared/appearance'
import { ChoiceGroup, type Choice } from '../ChoiceGroup'
import { logErr } from '../../log'

const THEME_CHOICES: readonly Choice<ThemeMode>[] = [
  { value: 'system', text: 'Auto', title: 'follow the operating system’s light/dark setting' },
  { value: 'light', text: 'Light' },
  { value: 'dark', text: 'Dark' }
]

const TEXT_SIZE_CHOICES: readonly Choice<TextSize>[] = [
  { value: 'small', text: 'Small' },
  { value: 'medium', text: 'Medium' },
  { value: 'large', text: 'Large' }
]

/** Colour theme and text size — main applies a save to the window at once
 *  (main/appearance.ts), so nothing here restyles the page by hand. */
export function AppearanceSection(): JSX.Element {
  const [appearance, setAppearance] = useState<Appearance | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    window.gurt.getAppearance().then(setAppearance).catch(logErr('getAppearance'))
  }, [])
  const save = (patch: Partial<Appearance>) => {
    if (!appearance) return
    const prior = appearance
    const next = { ...appearance, ...patch }
    setAppearance(next)
    setError('')
    window.gurt.setAppearance(next).catch((e: unknown) => {
      setAppearance(prior)
      setError(e instanceof Error ? e.message : String(e))
    })
  }
  return (
    <>
      <div className="set-head">
        <div className="set-title-wrap">
          <span className="set-title">Appearance</span>
          <span className="set-count mono">how this window looks</span>
        </div>
      </div>
      <div className="set-list appearance-settings">
        <div className="set-row">
          <span className="set-row-label">
            Theme
            <div className="fld-hint">Auto follows the operating system and switches with it.</div>
          </span>
          {appearance && (
            <ChoiceGroup
              label="Theme"
              choices={THEME_CHOICES}
              value={appearance.theme}
              onPick={(theme) => save({ theme })}
              dataKey="theme"
            />
          )}
        </div>
        <div className="set-row">
          <span className="set-row-label">
            Text size
            <div className="fld-hint">
              Scales the whole interface — terminal and editor included — so text keeps fitting its rows.
            </div>
          </span>
          {appearance && (
            <ChoiceGroup
              label="Text size"
              choices={TEXT_SIZE_CHOICES}
              value={appearance.textSize}
              onPick={(textSize) => save({ textSize })}
              dataKey="text-size"
            />
          )}
        </div>
        {error && <div className="error">{error}</div>}
      </div>
    </>
  )
}
