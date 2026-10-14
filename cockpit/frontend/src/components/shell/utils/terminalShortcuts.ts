import { detectMac } from '@/components/command-palette/paletteSearch';

export type TerminalShortcut = 'find' | 'zoom-in' | 'zoom-out' | 'zoom-reset';

const IS_MAC = detectMac();

/**
 * The cockpit's own keys inside a focused terminal: find (⌘F; Ctrl+Shift+F
 * elsewhere, since Ctrl+F belongs to the shell) and font size (⌘= / ⌘- / ⌘0,
 * Ctrl elsewhere). They replace the browser's page find and page zoom only
 * while a terminal has focus.
 */
export function matchTerminalShortcut(event: KeyboardEvent): TerminalShortcut | null {
  const primary = IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!primary || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === 'f' && event.shiftKey === !IS_MAC) return 'find';
  if (key === '=' || key === '+') return 'zoom-in';
  if (key === '-' && !event.shiftKey) return 'zoom-out';
  // By physical key: on AZERTY the 0 key types "à" and needs Shift for "0".
  if (event.code === 'Digit0' || event.code === 'Numpad0') return 'zoom-reset';
  return null;
}
