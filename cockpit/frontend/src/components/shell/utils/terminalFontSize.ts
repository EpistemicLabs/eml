import { TERMINAL_OPTIONS } from '../constants';

// The terminals' font size (⌘= / ⌘- / ⌘0 in a focused terminal): one value for
// the whole cockpit, kept in this browser and applied to every open terminal.
// Storage can be unavailable (private window, blocked site data); the size then
// lives only until the next reload.

export const DEFAULT_FONT_SIZE = TERMINAL_OPTIONS.fontSize ?? 13;
export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 24;

const STORAGE_KEY = 'cockpit-terminal-font-size';

const clamp = (size: number) => Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)));

function readStored(): number {
  try {
    const stored = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0 ? clamp(stored) : DEFAULT_FONT_SIZE;
  } catch {
    return DEFAULT_FONT_SIZE;
  }
}

let current = readStored();
const listeners = new Set<() => void>();

export function getTerminalFontSize(): number {
  return current;
}

export function subscribeTerminalFontSize(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** One step larger (1), smaller (-1), or back to the default (0). */
export function stepTerminalFontSize(step: 1 | -1 | 0): void {
  const next = step === 0 ? DEFAULT_FONT_SIZE : clamp(current + step);
  if (next === current) return;
  current = next;
  try {
    if (next === DEFAULT_FONT_SIZE) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    // Not persisted; the size still applies to this page.
  }
  for (const listener of listeners) listener();
}
