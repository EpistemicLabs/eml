import { useSyncExternalStore } from 'react';

/**
 * The compact layout: a phone-sized screen. One pane fills the screen, the
 * sidebar is a drawer, and terminals take input from an on-screen key row and
 * a composer instead of the hardware keyboard the desktop layout assumes.
 *
 * Decided by width alone, so a narrow desktop window gets the same layout a
 * phone does and the two can be tested side by side.
 */
export const COMPACT_LAYOUT_QUERY = '(max-width: 767px)';

function subscribe(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const media = window.matchMedia(COMPACT_LAYOUT_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function isCompact(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(COMPACT_LAYOUT_QUERY).matches;
}

export function useCompactLayout(): boolean {
  return useSyncExternalStore(subscribe, isCompact, () => false);
}
