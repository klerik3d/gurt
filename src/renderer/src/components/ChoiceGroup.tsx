import type { ReactNode } from 'react'

export interface Choice<V extends string | number | boolean> {
  value: V
  text: ReactNode
  title?: string
}

/** A row of mutually exclusive chips (a radio group): the Review block's
 *  on/off, rounds and "when clean" on a draft, and the same choices as repo
 *  defaults in Settings → Repos. `value` undefined = none is lit. */
export function ChoiceGroup<V extends string | number | boolean>({
  label,
  choices,
  value,
  onPick,
  dataKey
}: {
  /** The group's accessible name. */
  label: string
  choices: readonly Choice<V>[]
  value: V | undefined
  onPick: (value: V) => void
  /** Each chip carries its value as `data-<dataKey>` — the smoke's handle. */
  dataKey?: string
}) {
  return (
    <div className="chip-row" role="radiogroup" aria-label={label}>
      {choices.map((c) => (
        <button
          key={String(c.value)}
          type="button"
          role="radio"
          aria-checked={c.value === value}
          title={c.title}
          {...(dataKey ? { [`data-${dataKey}`]: String(c.value) } : {})}
          className={`chip-btn ${c.value === value ? 'on' : ''}`}
          onClick={() => onPick(c.value)}
        >
          {c.text}
        </button>
      ))}
    </div>
  )
}
