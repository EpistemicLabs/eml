import type { Terminal } from '@xterm/xterm';

import { ATLAS_SETTLE_MS } from '../constants';
import { repaintAll } from './terminalFit';

/**
 * Rebuilds the WebGL glyph atlas when the page regains attention. After
 * sleep/wake or a GPU reset the atlas can be corrupted without a context-loss
 * event; the first rebuild right after an app switch may itself be incomplete,
 * so a trailing pass follows once things settle. Under the DOM renderer this
 * is a visual no-op.
 *
 * Returns `trigger` (for other callers such as the DPR watch) and a disposer.
 */
export function installAtlasRecovery(terminal: Terminal): { trigger: () => void; dispose: () => void } {
  let frame: number | null = null;
  let settleTimer: number | null = null;

  const scheduleRebuild = () => {
    if (frame !== null) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      terminal.clearTextureAtlas();
      repaintAll(terminal);
    });
  };

  const trigger = () => {
    scheduleRebuild();
    if (settleTimer !== null) window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => {
      settleTimer = null;
      scheduleRebuild();
    }, ATLAS_SETTLE_MS);
  };

  const onVisibility = () => {
    if (document.visibilityState === 'visible') trigger();
  };

  window.addEventListener('focus', trigger);
  document.addEventListener('visibilitychange', onVisibility);

  return {
    trigger,
    dispose: () => {
      window.removeEventListener('focus', trigger);
      document.removeEventListener('visibilitychange', onVisibility);
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      frame = null;
      settleTimer = null;
    },
  };
}

/**
 * Calls `onChange` whenever the device pixel ratio changes (display switch,
 * browser zoom). The media query only matches one ratio, so it is re-armed
 * for the new value each time. Returns a disposer.
 */
export function watchDevicePixelRatio(onChange: () => void): () => void {
  let query: MediaQueryList | null = null;

  const arm = () => {
    query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    query.addEventListener('change', handle);
  };

  function handle(event: MediaQueryListEvent) {
    if (event.matches) return;
    query?.removeEventListener('change', handle);
    arm();
    onChange();
  }

  arm();
  return () => {
    query?.removeEventListener('change', handle);
    query = null;
  };
}

/** Removes xterm's focus outline once per document. */
export function ensureFocusStyle(id: string): void {
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent =
    '.xterm .xterm-screen, .xterm .xterm-screen:focus, .xterm .xterm-screen:focus-visible, .xterm .xterm-screen:focus-within { outline: none !important; }';
  document.head.appendChild(style);
}
