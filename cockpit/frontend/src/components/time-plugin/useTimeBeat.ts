// The Time plugin's user clock (host time-tracking.ts): while this tab had
// input in the last IDLE_MS, it tells the host every BEAT_MS what is in front —
// the open space, the active pane's session or project. The host credits the
// time between two beats to the earlier one, so a pane switch moves the clock
// at the next beat. A hidden tab (the user looks something up elsewhere) goes
// on counting for AWAY_MS, then pauses until it shows again.
import { useEffect } from 'react';

import { useViewEnabled } from '@/lib/pane-views';
import { getActivePane, getActiveSpaceId } from '@/stores/usePaneStore';

const BEAT_MS = 30_000;
/** No input for this long: the clock pauses (agreed with the user: 5 minutes). */
const IDLE_MS = 5 * 60_000;
/** In another tab or app for this long: the clock pauses (agreed with the user: 2 minutes). */
const AWAY_MS = 2 * 60_000;
const INPUT_EVENTS = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart'] as const;

export function useTimeBeat(): void {
  const on = useViewEnabled()('time');
  useEffect(() => {
    if (!on) return;
    let lastInput = Date.now();
    let hiddenAt: number | null = document.visibilityState === 'hidden' ? Date.now() : null;
    const beat = (fresh = false) => {
      const now = Date.now();
      if (now - lastInput > IDLE_MS || (hiddenAt !== null && now - hiddenAt > AWAY_MS)) return;
      const pane = getActivePane();
      // The shell and the time view are of no project.
      const own = pane && pane.paneView !== 'shell' && pane.paneView !== 'time';
      void fetch('/api/plugins/time/beat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spaceId: getActiveSpaceId(),
          projectId: own ? pane.projectId ?? null : null,
          sessionId: own ? pane.sessionId ?? null : null,
          fresh,
        }),
      }).catch(() => {});
    };
    const onInput = () => {
      const idle = Date.now() - lastInput > IDLE_MS;
      lastInput = Date.now();
      // Back after a pause: start the clock now, not at the next tick.
      if (idle) beat(true);
    };
    const onVisible = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      // Back: after more than AWAY_MS away the clock starts anew, the time away beyond it does not count.
      const away = hiddenAt !== null && Date.now() - hiddenAt > AWAY_MS;
      hiddenAt = null;
      lastInput = Date.now();
      beat(away);
    };
    for (const name of INPUT_EVENTS) window.addEventListener(name, onInput, { passive: true, capture: true });
    document.addEventListener('visibilitychange', onVisible);
    beat();
    // A hidden tab's timers may slow to once a minute: still inside the host's 90 s gap.
    const timer = window.setInterval(() => beat(), BEAT_MS);
    return () => {
      window.clearInterval(timer);
      for (const name of INPUT_EVENTS) window.removeEventListener(name, onInput, { capture: true });
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [on]);
}
