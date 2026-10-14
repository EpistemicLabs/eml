import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

import { MIN_COLS, MIN_ROWS } from '../constants';

export interface GridSize {
  cols: number;
  rows: number;
}

/** Whether the element the terminal lives in currently has a layout box. */
export function isContainerRendered(terminal: Terminal): boolean {
  const parent = terminal.element?.parentElement;
  return !!parent && parent.getClientRects().length > 0;
}

/**
 * The size a fit would produce, or null when it would be bogus: a hidden
 * container makes the fit addon read `100%` as 100 px (about 10x6), and a
 * 0x0 container during mount yields NaN.
 */
export function proposeValidSize(terminal: Terminal, fit: FitAddon): GridSize | null {
  if (!isContainerRendered(terminal)) return null;
  const dims = fit.proposeDimensions();
  if (!dims) return null;
  const { cols, rows } = dims;
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
  if (cols < MIN_COLS || rows < MIN_ROWS) return null;
  return { cols, rows };
}

export function repaintAll(terminal: Terminal): void {
  terminal.refresh(0, terminal.rows - 1);
}

/**
 * Fits the terminal to its container. The selection is cleared first because
 * selection and link-hover overlays are drawn in pixels and would end up over
 * the wrong cells after a reflow.
 */
export function fitTerminal(terminal: Terminal, fit: FitAddon, repaint = true): GridSize {
  terminal.clearSelection();
  fit.fit();
  if (repaint) repaintAll(terminal);
  return { cols: terminal.cols, rows: terminal.rows };
}

/** Drops scrollback and wipes the visible screen, cursor home. */
export function clearScreen(terminal: Terminal): void {
  terminal.clear();
  terminal.write('\x1b[2J\x1b[H');
}
