import type { ITerminalOptions } from '@xterm/xterm';

/** Terminal options apart from the theme, which is built per mode. */
export const TERMINAL_OPTIONS: ITerminalOptions = {
  cursorBlink: true,
  // Matches the app's 13 px body text; keep the two in sync.
  fontSize: 13,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  allowProposedApi: true,
  allowTransparency: false,
  convertEol: true,
  // Same depth as the host's mirror, so a replay covers everything scrollable.
  scrollback: 10000,
  // Smooth scrolling reads as lag; wheel ticks apply instantly.
  smoothScrollDuration: 0,
  scrollSensitivity: 3,
  fastScrollSensitivity: 8,
  tabStopWidth: 4,
  macOptionIsMeta: true,
  macOptionClickForcesSelection: true,
};

/** First fit after creation, first init attempt after open, and init retry interval. */
export const SETTLE_DELAY_MS = 100;
/** Init retries while the container has a box but no usable size. */
export const MAX_INIT_RETRIES = 30;
/** Poll interval while the container is hidden (background desk) before init. */
export const HIDDEN_POLL_MS = 250;
/** Trailing debounce for container resize notifications. */
export const RESIZE_DEBOUNCE_MS = 200;
/** How long "connecting" is held after a failed nonce request. */
export const NONCE_FAILURE_HOLD_MS = 1500;
/** Delay of the trailing glyph-atlas rebuild after focus/visibility/DPR events. */
export const ATLAS_SETTLE_MS = 400;

export const MIN_COLS = 2;
export const MIN_ROWS = 1;

/** First byte of a binary host frame carrying PTY output. */
export const OUTPUT_FRAME_TYPE = 0x01;

export const ESC = '\x1b';
/** Ctrl+U: kill the current line. */
export const KILL_LINE = '\x15';
export const BRACKETED_PASTE_START = `${ESC}[200~`;
export const BRACKETED_PASTE_END = `${ESC}[201~`;

export const SUPERSEDED_REASON = 'superseded';
export const NORMAL_CLOSURE = 1000;

export const FOCUS_STYLE_ID = 'shell-xterm-focus-style';

export const ERROR_NO_SIZE = 'Could not size the terminal. Reload the page to try again.';
export const ERROR_NO_IDENTITY = 'This pane has no session or project. Close it and open a new one.';
