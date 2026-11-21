// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { ansiToken, getSearchDecorations, getXtermTheme } from './terminalTheme';

function scoped(vars: Record<string, string>): HTMLElement {
  const el = document.createElement('div');
  for (const [name, value] of Object.entries(vars)) el.style.setProperty(name, value);
  document.body.append(el);
  return el;
}

describe('terminal theme from tokens v2', () => {
  it('names the token of each ANSI slot', () => {
    expect(ansiToken('red')).toBe('--term-ansi-red');
    expect(ansiToken('brightBlack')).toBe('--term-ansi-bright-black');
  });

  it('takes the surface from the v2 neutrals and the palette from the ANSI tokens', () => {
    const el = scoped({
      '--color-background': '#000000',
      '--color-foreground': '#f5f5f7',
      '--color-muted': '#2c2c2e',
      '--term-ansi-red': '#cd3131',
      '--term-ansi-bright-white': '#ffffff',
    });
    const theme = getXtermTheme(el);
    expect(theme.background).toBe('#000000');
    expect(theme.foreground).toBe('#f5f5f7');
    expect(theme.cursor).toBe('#f5f5f7');
    expect(theme.cursorAccent).toBe('#000000');
    expect(theme.selectionBackground).toBe('#2c2c2e');
    expect(theme.red).toBe('#cd3131');
    expect(theme.brightWhite).toBe('#ffffff');
  });

  it('reads the search marks from their tokens', () => {
    const el = scoped({ '--term-match': '#fde68a', '--term-match-active': '#f59e0b' });
    expect(getSearchDecorations(el)).toEqual({
      matchBackground: '#fde68a',
      matchOverviewRuler: '#fde68a',
      activeMatchBackground: '#f59e0b',
      activeMatchColorOverviewRuler: '#f59e0b',
    });
  });
});
