// The colour that tells a space apart. The host stores the name and gives every
// space one; the tones are the --space-* tokens in index.css, per light and dark.
import { loadSpaces, type SpaceInfo } from '@/stores/useSpaceStore';

export const SPACE_COLORS = ['coral', 'amber', 'green', 'cyan', 'blue', 'violet', 'pink', 'slate'] as const;

export type SpaceColor = (typeof SPACE_COLORS)[number];

/** The space's tone as a CSS value; undefined leaves the element's own colour. */
export const spaceTone = (space: Pick<SpaceInfo, 'color'> | null | undefined): string | undefined =>
  space?.color ? `var(--space-${space.color})` : undefined;

/** Change a space's colour (Settings › Spaces); answers with what went wrong, or null. */
export async function setSpaceColor(space: SpaceInfo, color: SpaceColor): Promise<string | null> {
  try {
    const response = await fetch(`/api/spaces/${encodeURIComponent(space.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      return body?.error?.message ?? `Could not change the colour (${response.status}).`;
    }
    await loadSpaces();
    return null;
  } catch {
    return 'The cockpit host did not answer. Try again.';
  }
}
