import { useEffect } from 'react';

/**
 * Publishes the height of the part of the page the user can see as the CSS
 * variable --app-height on the root element. On iOS the on-screen keyboard
 * covers the page without shrinking 100vh or 100dvh, so a layout sized by
 * them ends under the keyboard; the visual viewport is what shrinks.
 * Without visualViewport (older browsers) the variable stays unset and the
 * layout falls back to its CSS height.
 */
export const APP_HEIGHT_VAR = '--app-height';

export function useVisibleViewportHeight(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    const update = () => {
      root.style.setProperty(APP_HEIGHT_VAR, `${Math.round(viewport.height)}px`);
      // iOS scrolls the page to keep a focused input in view; the app is
      // sized to the visible part already, so put it back at the top.
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      root.style.removeProperty(APP_HEIGHT_VAR);
    };
  }, []);
}
