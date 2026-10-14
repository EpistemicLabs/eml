import type { ITheme } from '@xterm/xterm';

type AnsiSlot =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'brightBlack'
  | 'brightRed'
  | 'brightGreen'
  | 'brightYellow'
  | 'brightBlue'
  | 'brightMagenta'
  | 'brightCyan'
  | 'brightWhite';

type AnsiPalette = Readonly<Record<AnsiSlot, string>>;

/**
 * Dark palette: the ANSI colours of VS Code's default (Dark+) integrated
 * terminal (Visual Studio Code, (c) Microsoft Corporation, MIT licence; see
 * NOTICE). Bright slots are vivid, meant for near-black backgrounds.
 */
export const ANSI_DARK: AnsiPalette = {
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

/**
 * Light palette: every slot reaches at least 4.5:1 on white. "Yellow" is a
 * gold so it stays visible, the "white" slots are greys so dim text remains
 * readable, and bright variants go deeper instead of lighter.
 */
export const ANSI_LIGHT: AnsiPalette = {
  black: '#1d1d1f',
  red: '#c41a16',
  green: '#326d24',
  yellow: '#a3712e',
  blue: '#0058c7',
  magenta: '#ad3da4',
  cyan: '#1a7b9c',
  white: '#6e6e73',
  brightBlack: '#8e8e93',
  brightRed: '#a01007',
  brightGreen: '#22501a',
  brightYellow: '#7e570f',
  brightBlue: '#003f8c',
  brightMagenta: '#8a2e83',
  brightCyan: '#0d5a7d',
  brightWhite: '#3c3c43',
};

export interface SurfaceColors {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  muted: string;
}

/** Reads the app's surface colours live from the root element's CSS variables. */
export function getSurfaceColors(): SurfaceColors {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => style.getPropertyValue(name).trim();
  const background = read('--color-background');
  const foreground = read('--color-foreground');
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: read('--color-muted'),
    selectionForeground: foreground,
    muted: read('--color-muted-foreground'),
  };
}

/** Builds the xterm theme: app surface colours plus the ANSI palette for the mode. */
export function getXtermTheme(isDarkMode: boolean): ITheme {
  const surface = getSurfaceColors();
  return {
    background: surface.background,
    foreground: surface.foreground,
    cursor: surface.cursor,
    cursorAccent: surface.cursorAccent,
    selectionBackground: surface.selectionBackground,
    selectionForeground: surface.selectionForeground,
    ...(isDarkMode ? ANSI_DARK : ANSI_LIGHT),
  };
}
