import { BRACKETED_PASTE_END, BRACKETED_PASTE_START, ESC } from '../constants';

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

/**
 * How an uploaded image goes into a prompt: its path on the host, pasted so
 * the CLI takes it as an attachment, and a space that leaves room for a caption.
 */
export function imageReference(path: string): string {
  return `${BRACKETED_PASTE_START}${path}${BRACKETED_PASTE_END} `;
}

/**
 * Mouse reports (SGR, `ESC [ < button ; x ; y M`) whose position came out as
 * NaN: xterm's touch scrolling produces them when a program has mouse
 * tracking on (Claude Code's fullscreen renderer), and the program then
 * shows the broken sequence as typed text. A wheel report only needs its
 * button, so the position is set to the first cell and the scroll works.
 */
const NAN_MOUSE_REPORT = /\x1b\[<(\d+);NaN;NaN([Mm])/g;

export function repairMouseReports(data: string): string {
  return data.includes('NaN') ? data.replace(NAN_MOUSE_REPORT, '\x1b[<$1;1;1$2') : data;
}
