import { useEffect } from 'react';

import { readSwipe, swipeZone, type SwipeDirection } from './swipeGesture';

const INTERACTIVE = 'button, a, input, textarea, select, label, [role="button"]';

/** Whether the touch sits on something the page itself scrolls sideways: a code block, a wide table. */
function inHorizontalScroller(target: Element): boolean {
  for (let node: Element | null = target; node; node = node.parentElement) {
    if (node.scrollWidth <= node.clientWidth) continue;
    const { overflowX } = window.getComputedStyle(node);
    if (overflowX === 'auto' || overflowX === 'scroll') return true;
  }
  return false;
}

/**
 * The compact drawer's swipes: from the left screen edge to the right opens it,
 * to the left on the drawer or beside it closes it. Listens on the document,
 * because the swipe starts wherever the finger lands; a touch on a modal, a
 * control, or (just inside the edge) a terminal or sideways scroller is left alone.
 */
export function useDrawerSwipe(enabled: boolean, open: boolean, onOpen: () => void, onClose: () => void): void {
  useEffect(() => {
    if (!enabled) return;
    let swipe: { x: number; y: number; direction: SwipeDirection } | null = null;

    const onStart = (event: TouchEvent) => {
      swipe = null;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch || !(event.target instanceof Element)) return;
      const { target } = event;
      if (open) {
        if (target.closest('[data-sidebar-drawer]')) swipe = { x: touch.clientX, y: touch.clientY, direction: 'left' };
        return;
      }
      const zone = swipeZone(touch.clientX);
      if (!zone) return;
      const overlay = target.closest('.fixed');
      if (overlay && !overlay.hasAttribute('data-app-root')) return;
      if (target.closest(INTERACTIVE)) return;
      if (zone === 'inner' && (target.closest('.xterm') || inHorizontalScroller(target))) return;
      swipe = { x: touch.clientX, y: touch.clientY, direction: 'right' };
      // Claims the touch from iOS's back gesture; it also means this touch can't scroll.
      if (zone === 'edge') event.preventDefault();
    };

    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!swipe || !touch) return;
      const reading = readSwipe(touch.clientX - swipe.x, touch.clientY - swipe.y, swipe.direction);
      if (reading === 'pending') return;
      if (reading === 'commit') (swipe.direction === 'right' ? onOpen : onClose)();
      swipe = null;
    };

    const onEnd = () => { swipe = null; };

    document.addEventListener('touchstart', onStart, { passive: false });
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('touchend', onEnd);
    document.addEventListener('touchcancel', onEnd);
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
  }, [enabled, open, onOpen, onClose]);
}
