// The Time plugin's user clock (host time-tracking.ts): while this tab is
// visible and had input in the last IDLE_MS, it tells the host every BEAT_MS
// what is in front — the active pane's session, or its project. The host
// credits the time between two beats to the earlier one, so a pane switch
// moves the clock at the next beat.
import { useEffect } from 'react';

import { useViewEnabled } from '@/lib/pane-views';
import { getActivePane } from '@/stores/usePaneStore';

const BEAT_MS = 30_000;
/** No input for this long: the clock pauses (agreed with the user: 5 minutes). */
const IDLE_MS = 5 * 60_000;
const INPUT_EVENTS = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart'] as const;

export function useTimeBeat(): void {
  const on = useViewEnabled()('time');
  useEffect(() => {
    if (!on) return;
    let lastInput = Date.now();
    const beat = () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastInput > IDLE_MS) return;
      const pane = getActivePane();
      // The shell and the time view are of no project.
      const own = pane && pane.paneView !== 'shell' && pane.paneView !== 'time';
      void fetch('/api/plugins/time/beat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: own ? pane.projectId ?? null : null, sessionId: own ? pane.sessionId ?? null : null }),
      }).catch(() => {});
    };
    const onInput = () => {
      const idle = Date.now() - lastInput > IDLE_MS;
      lastInput = Date.now();
      // Back after a pause: start the clock now, not at the next tick.
      if (idle) beat();
    };
    const onVisible = () => { if (document.visibilityState === 'visible') onInput(); };
    for (const name of INPUT_EVENTS) window.addEventListener(name, onInput, { passive: true, capture: true });
    document.addEventListener('visibilitychange', onVisible);
    beat();
    const timer = window.setInterval(beat, BEAT_MS);
    return () => {
      window.clearInterval(timer);
      for (const name of INPUT_EVENTS) window.removeEventListener(name, onInput, { capture: true });
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [on]);
}
