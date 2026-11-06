/**
 * The colour that tells a brain space apart wherever it is marked. The names
 * are stored; the tones live in the frontend's theme, per light and dark.
 * Every space starts grey; the user gives it a colour in Settings › Brain.
 */
export const SPACE_COLORS = ['coral', 'amber', 'green', 'cyan', 'blue', 'violet', 'pink', 'slate'] as const

export type SpaceColor = (typeof SPACE_COLORS)[number]

export const DEFAULT_SPACE_COLOR: SpaceColor = 'slate'

export const isSpaceColor = (value: unknown): value is SpaceColor =>
  typeof value === 'string' && (SPACE_COLORS as readonly string[]).includes(value)
