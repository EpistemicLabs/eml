import { ESC } from '../constants';

/**
 * The keys a phone keyboard lacks but an agent CLI needs: Esc to interrupt,
 * Shift+Tab to change the permission mode, arrows to move through a menu,
 * Ctrl+C. Each is the byte sequence a terminal sends for it, so the host and
 * the CLI see exactly what a hardware keyboard would have produced.
 */
export type TerminalKey = 'escape' | 'tab' | 'shift-tab' | 'up' | 'down' | 'left' | 'right' | 'enter' | 'interrupt';

const ARROW_CODES = { up: 'A', down: 'B', right: 'C', left: 'D' } as const;

export interface KeyContext {
  /**
   * The terminal's cursor key mode (DECCKM): a full-screen program that sets
   * it expects arrows as SS3 (`ESC O A`) instead of CSI (`ESC [ A`).
   */
  applicationCursor: boolean;
}

export function keySequence(key: TerminalKey, context: KeyContext): string {
  switch (key) {
    case 'escape': return ESC;
    case 'tab': return '\t';
    case 'shift-tab': return `${ESC}[Z`;
    case 'enter': return '\r';
    case 'interrupt': return '\x03';
    case 'up':
    case 'down':
    case 'left':
    case 'right':
      return `${ESC}${context.applicationCursor ? 'O' : '['}${ARROW_CODES[key]}`;
  }
}

/**
 * The text a composer message types before its Enter. Trailing line breaks
 * are dropped (Enter is sent on its own); an empty message types nothing, so
 * sending it is just Enter, which confirms a prompt that waits for it.
 */
export function submissionText(raw: string): string {
  return raw.replace(/\s+$/, '');
}
