import { useSyncExternalStore } from 'react';

import { isTouchScreen } from './useCompactLayout';

/**
 * Whether an on-screen keyboard is up. Browsers don't say so directly; the
 * visual viewport shrinks by the keyboard's height, so a touch screen's view
 * far shorter than the tallest seen at this width is the keyboard. Browser
 * chrome showing or hiding changes far less than this. innerHeight is no
 * baseline: in an iOS home-screen app it follows the visual viewport during
 * the keyboard's events and only returns afterwards, with no event to say so.
 */
const KEYBOARD_MIN_PX = 150;

const tallestAtWidth = new Map<number, number>();

export function isKeyboardHeight(tallest: number, height: number): boolean {
  return tallest - height > KEYBOARD_MIN_PX;
}

function subscribe(onChange: () => void): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  viewport.addEventListener('resize', onChange);
  return () => viewport.removeEventListener('resize', onChange);
}

function isOpen(): boolean {
  const viewport = window.visualViewport;
  if (!viewport || !isTouchScreen()) return false;
  const width = Math.round(viewport.width);
  const tallest = Math.max(tallestAtWidth.get(width) ?? 0, viewport.height);
  tallestAtWidth.set(width, tallest);
  return isKeyboardHeight(tallest, viewport.height);
}

export function useSoftKeyboardOpen(): boolean {
  return useSyncExternalStore(subscribe, isOpen, () => false);
}
