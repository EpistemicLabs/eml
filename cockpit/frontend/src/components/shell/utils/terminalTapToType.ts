import type { Terminal } from '@xterm/xterm';

/**
 * iOS raises the soft keyboard only for a focus() made inside the touch's
 * own event handler. xterm takes the touches for its scrolling and focuses
 * its helper textarea later, so a tap on the terminal never raised the
 * keyboard. Here a tap — a touch that ends close to where it started, not a
 * scroll — focuses the textarea right in its touchend. Returns a disposer.
 */
const TAP_SLOP_PX = 10;

export function installTapToType(terminal: Terminal, container: HTMLElement): () => void {
  let start: { x: number; y: number } | null = null;

  const onTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    start = event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY } : null;
  };
  const onTouchEnd = (event: TouchEvent) => {
    const touch = event.changedTouches[0];
    if (!start || !touch) return;
    const moved = Math.hypot(touch.clientX - start.x, touch.clientY - start.y);
    start = null;
    if (moved <= TAP_SLOP_PX) terminal.textarea?.focus({ preventScroll: true });
  };

  // Capture phase: runs before xterm's own handlers can stop the event.
  container.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  container.addEventListener('touchend', onTouchEnd, { capture: true });
  return () => {
    container.removeEventListener('touchstart', onTouchStart, { capture: true });
    container.removeEventListener('touchend', onTouchEnd, { capture: true });
  };
}
