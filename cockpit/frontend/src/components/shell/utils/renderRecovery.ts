import type { Terminal } from '@xterm/xterm';

import { ATLAS_SETTLE_MS, FRAME_GAP_MS } from '../constants';
import { repaintAll } from './terminalFit';

/**
 * Rebuilds the WebGL glyph atlas when the page regains attention. After
 * sleep/wake or a GPU reset the atlas can be corrupted without a context-loss
 * event; the first rebuild right after an app switch may itself be incomplete,
 * so trailing passes follow once things settle. Under the DOM renderer this
 * is a visual no-op. The atlas is shared by every pane with the same font and
 * theme, so one damaged atlas garbles them all.
 *
 * Attention means focus, a visible tab again, or the page drawing again after
 * a pause (watchFrameGaps): an idle display sleep keeps the window focused and
 * the tab visible, so only the pause shows it.
 *
 * Returns `trigger` (for other callers such as the DPR watch) and a disposer.
 */
export function installAtlasRecovery(terminal: Terminal): { trigger: () => void; dispose: () => void } {
  let frame: number | null = null;
  let settleTimers: number[] = [];

  const scheduleRebuild = () => {
    if (frame !== null) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      terminal.clearTextureAtlas();
      repaintAll(terminal);
    });
  };

  const clearSettleTimers = () => {
    for (const timer of settleTimers) window.clearTimeout(timer);
    settleTimers = [];
  };

  const trigger = () => {
    scheduleRebuild();
    clearSettleTimers();
    settleTimers = ATLAS_SETTLE_MS.map((delay) => window.setTimeout(scheduleRebuild, delay));
  };

  const onVisibility = () => {
    if (document.visibilityState === 'visible') trigger();
  };

  window.addEventListener('focus', trigger);
  document.addEventListener('visibilitychange', onVisibility);
  const stopGapWatch = watchFrameGaps(trigger);

  return {
    trigger,
    dispose: () => {
      window.removeEventListener('focus', trigger);
      document.removeEventListener('visibilitychange', onVisibility);
      stopGapWatch();
      if (frame !== null) window.cancelAnimationFrame(frame);
      clearSettleTimers();
      frame = null;
    },
  };
}

// One animation-frame loop for the whole page, however many panes listen.
const gapListeners = new Set<() => void>();
let gapFrame: number | null = null;
let lastFrameAt: number | null = null;

function onFrame(now: number) {
  if (lastFrameAt !== null && now - lastFrameAt > FRAME_GAP_MS) {
    console.info(`[Shell] page not drawn for ${Math.round((now - lastFrameAt) / 1000)}s, rebuilding the glyph atlas`);
    for (const listener of gapListeners) listener();
  }
  lastFrameAt = now;
  gapFrame = window.requestAnimationFrame(onFrame);
}

/**
 * Calls `onGap` when the page draws again after a pause of more than
 * FRAME_GAP_MS. The browser stops animation frames while nothing of the page
 * can be seen — the display off, the tab hidden — and macOS may release GPU
 * memory meanwhile. Returns a disposer.
 */
export function watchFrameGaps(onGap: () => void): () => void {
  gapListeners.add(onGap);
  if (gapFrame === null) {
    lastFrameAt = null;
    gapFrame = window.requestAnimationFrame(onFrame);
  }
  return () => {
    gapListeners.delete(onGap);
    if (gapListeners.size === 0 && gapFrame !== null) {
      window.cancelAnimationFrame(gapFrame);
      gapFrame = null;
    }
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
