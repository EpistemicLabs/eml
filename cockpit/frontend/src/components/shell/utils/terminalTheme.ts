import type { ITheme } from '@xterm/xterm';
import type { ISearchOptions } from '@xterm/addon-search';

const ANSI_SLOTS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const;

type AnsiSlot = (typeof ANSI_SLOTS)[number];

/** brightBlack → --term-ansi-bright-black: the token that holds the slot's colour. */
export function ansiToken(slot: AnsiSlot): string {
  return `--term-ansi-${slot.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/**
 * xterm takes concrete colours, so the theme is read live from the tokens v2 in effect on the
 * terminal's element (`scope`): the surface follows the v2 neutrals, the ANSI
 * palette comes from the --term-ansi-* tokens (light: every slot at 4.5:1 on white; dark: the
 * colours of VS Code's default dark terminal, see NOTICE). Called again after a theme switch.
 */
export function getXtermTheme(scope: Element): ITheme {
  const style = getComputedStyle(scope);
  const read = (name: string) => style.getPropertyValue(name).trim();
  const background = read('--color-background');
  const foreground = read('--color-foreground');
  const ansi = Object.fromEntries(ANSI_SLOTS.map((slot) => [slot, read(ansiToken(slot))])) as Record<AnsiSlot, string>;
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: read('--color-muted'),
    selectionForeground: foreground,
    ...ansi,
  };
}

/**
 * Highlight colours for scrollback search: amber matches, a stronger amber for the current one
 * (--term-match, --term-match-active). xterm takes them as #RRGGBB only (no alpha).
 */
export function getSearchDecorations(scope: Element): ISearchOptions['decorations'] {
  const style = getComputedStyle(scope);
  const match = style.getPropertyValue('--term-match').trim();
  const active = style.getPropertyValue('--term-match-active').trim();
  return {
    matchBackground: match,
    matchOverviewRuler: match,
    activeMatchBackground: active,
    activeMatchColorOverviewRuler: active,
  };
}
