import { useSyncExternalStore } from 'react';

/**
 * Whether an on-screen keyboard is up. Browsers don't say so directly; on a
 * phone the visual viewport shrinks by the keyboard's height while the
 * layout viewport (innerHeight) stays, so a large gap between them is the
 * keyboard. Browser chrome showing or hiding changes far less than this.
 */
const KEYBOARD_MIN_PX = 150;

function subscribe(onChange: () => void): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  viewport.addEventListener('resize', onChange);
  return () => viewport.removeEventListener('resize', onChange);
}

function isOpen(): boolean {
  const viewport = window.visualViewport;
  return !!viewport && window.innerHeight - viewport.height > KEYBOARD_MIN_PX;
}

export function useSoftKeyboardOpen(): boolean {
  return useSyncExternalStore(subscribe, isOpen, () => false);
}
