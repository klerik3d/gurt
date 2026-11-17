// Settings → Appearance: the colour theme and the text size. Lives in main
// (appearance.json), not in the renderer's localStorage, because main applies
// both before the window paints: it resolves the theme to a scheme (with
// `system`, the OS's), sets `nativeTheme.themeSource` for native menus and
// dialogs, the window's background colour and the page zoom, and hands the
// scheme to the renderer.

export type ThemeMode = 'system' | 'light' | 'dark'
export type TextSize = 'small' | 'medium' | 'large'
/** The theme resolved — what the page is actually drawn in. */
export type ColorScheme = 'dark' | 'light'

export interface Appearance {
  theme: ThemeMode
  textSize: TextSize
}

export const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark']
export const TEXT_SIZES: readonly TextSize[] = ['small', 'medium', 'large']

/** Dark stays the default — it is what the app looked like before the setting
 *  existed; medium is today's size. */
export const APPEARANCE_DEFAULT: Appearance = { theme: 'dark', textSize: 'medium' }

/** Text size is a page zoom rather than a font-size multiplier: the layout is
 *  sized in px around the text (row heights, icon boxes, paddings), and
 *  scaling only the glyphs would clip or crowd them. Zoom scales the whole
 *  interface uniformly, terminal and editor included. */
export const TEXT_SIZE_ZOOM: Record<TextSize, number> = { small: 0.9, medium: 1, large: 1.15 }

/** Window background per resolved scheme — the colour shown before the
 *  renderer's first paint; matches `--app` in styles.css. */
export const WINDOW_BACKGROUND: Record<ColorScheme, string> = { dark: '#100f0d', light: '#ffffff' }

/** The renderer's payload (and the file on disk) is untrusted: each field
 *  that is not one of its known values falls back to `fallback`'s. */
export function sanitizeAppearance(raw: unknown, fallback: Appearance = APPEARANCE_DEFAULT): Appearance {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    theme: THEME_MODES.includes(r['theme'] as ThemeMode) ? (r['theme'] as ThemeMode) : fallback.theme,
    textSize: TEXT_SIZES.includes(r['textSize'] as TextSize) ? (r['textSize'] as TextSize) : fallback.textSize
  }
}
