/**
 * The colour that tells a brain space apart wherever it is marked. The names
 * are stored; the tones live in the frontend's theme, per light and dark.
 * Coral is the brand's and goes to the main space.
 */
export const SPACE_COLORS = ['coral', 'amber', 'green', 'cyan', 'blue', 'violet', 'pink', 'slate'] as const

export type SpaceColor = (typeof SPACE_COLORS)[number]

export const isSpaceColor = (value: unknown): value is SpaceColor =>
  typeof value === 'string' && (SPACE_COLORS as readonly string[]).includes(value)

/** The first colour no space uses yet; with all taken the least used, so spaces stay as far apart as they can. */
export function nextSpaceColor(used: Array<SpaceColor | null>): SpaceColor {
  const count = (color: SpaceColor) => used.filter((other) => other === color).length
  return SPACE_COLORS.reduce((best, color) => (count(color) < count(best) ? color : best))
}
