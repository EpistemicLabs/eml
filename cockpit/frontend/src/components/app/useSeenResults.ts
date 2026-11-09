import { useCallback, useEffect, useRef } from 'react';

import { isUnseen, type AllSession } from '@/components/sidebar/allSessions';
import { useAllSessions } from '@/components/sidebar/useAllSessions';
import { markSessionRead } from '@/lib/session-actions';
import * as paneStore from '@/stores/usePaneStore';
import { getTopView } from '@/stores/useTopViewStore';
import { pushEndpoint } from '@/lib/push';
import { api } from '@/utils/api';

// A hand on the mouse or keyboard this recently counts as someone being there.
const ACTIVE_MS = 60_000;
const CHECK_MS = 5_000;
// While the cockpit is in use here, the host pushes only to this device (host push-notifier.ts):
// it is told every 30 seconds, and stops being told ten minutes after the last click or key.
const IN_USE_MS = 10 * 60_000;
const REPORT_MS = 30_000;

/**
 * What the user sees right now is seen: its pane on screen, the tab in front and the
 * user active. When in doubt it stays unseen. Told to the host, so it counts on every device.
 */
export function sessionsToMarkSeen(
  sessions: AllSession[],
  onScreen: ReadonlySet<string>,
  facts: { foreground: boolean; lastInputAt: number; now: number },
): string[] {
  if (!facts.foreground || facts.now - facts.lastInputAt >= ACTIVE_MS) return [];
  return sessions.filter((session) => onScreen.has(session.id) && isUnseen(session)).map((session) => session.id);
}

/** The sessions in front of someone now: the host sends no push about them. */
export function sessionsWatched(onScreen: ReadonlySet<string>, facts: { foreground: boolean; lastInputAt: number; now: number }): string[] {
  if (!facts.foreground || facts.now - facts.lastInputAt >= ACTIVE_MS) return [];
  return [...onScreen];
}

/** Someone works in this cockpit: their notifications come here, not to the phone. */
export function cockpitInUse(facts: { lastInputAt: number; now: number }): boolean {
  return facts.lastInputAt > 0 && facts.now - facts.lastInputAt < IN_USE_MS;
}

function sessionsOnScreen(compact: boolean): Set<string> {
  if (getTopView() !== 'desks') return new Set();
  const panes = paneStore.getDeskPanesOnScreen(compact);
  return new Set(panes.flatMap((pane) => ((pane.paneView === 'chat' || pane.paneView === 'terminal') && pane.sessionId ? [pane.sessionId] : [])));
}

export function useSeenResults(compact: boolean): void {
  const { sessions } = useAllSessions(true);
  const known = useRef<AllSession[]>([]);
  known.current = sessions ?? [];
  const lastInputAt = useRef(0);
  const reportedAt = useRef(0);

  const check = useCallback(() => {
    const onScreen = sessionsOnScreen(compact);
    const facts = { foreground: document.visibilityState === 'visible' && document.hasFocus(), lastInputAt: lastInputAt.current, now: Date.now() };
    const ids = sessionsToMarkSeen(known.current, onScreen, facts);
    for (const id of ids) void markSessionRead(id);
    if (cockpitInUse(facts) && facts.now - reportedAt.current >= REPORT_MS) {
      reportedAt.current = facts.now;
      const watched = sessionsWatched(onScreen, facts);
      void pushEndpoint()
        .then((endpoint) => api.pushWatching(watched, endpoint))
        .catch(() => { /* host unreachable: it may push once too often */ });
    }
  }, [compact]);

  // A result that lands while the user is looking leaves again at once.
  useEffect(check, [check, sessions]);

  useEffect(() => {
    const onInput = () => { lastInputAt.current = Date.now(); };
    const events = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const name of events) window.addEventListener(name, onInput, { passive: true });
    const timer = window.setInterval(check, CHECK_MS);
    return () => {
      for (const name of events) window.removeEventListener(name, onInput);
      window.clearInterval(timer);
    };
  }, [check]);
}
