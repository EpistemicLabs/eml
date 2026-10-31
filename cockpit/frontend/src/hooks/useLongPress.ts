import { useEffect, useRef, type MouseEvent, type TouchEvent } from 'react';

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;

/** Touch handlers that call onLongPress for a held finger, and swallow the click its release would make. */
export function useLongPress(onLongPress: () => void) {
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);

  return {
    onTouchStart: (event: TouchEvent) => {
      clear();
      fired.current = false;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch) return;
      start.current = { x: touch.clientX, y: touch.clientY };
      timer.current = window.setTimeout(() => {
        timer.current = null;
        fired.current = true;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onTouchMove: (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch || !start.current) return;
      const moved = Math.max(Math.abs(touch.clientX - start.current.x), Math.abs(touch.clientY - start.current.y));
      if (moved > MOVE_TOLERANCE_PX) clear();
    },
    onTouchEnd: clear,
    onTouchCancel: clear,
    onClickCapture: (event: MouseEvent) => {
      if (!fired.current) return;
      fired.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onContextMenu: (event: MouseEvent) => event.preventDefault(),
  };
}
