import { useCallback, useEffect, useRef } from 'react';

import { isUnseen, type AllSession } from '@/components/sidebar/allSessions';
import { useAllSessions } from '@/components/sidebar/useAllSessions';
import { markSessionRead } from '@/lib/session-actions';
import * as paneStore from '@/stores/usePaneStore';
import { getTopView } from '@/stores/useTopViewStore';

// A hand on the mouse or keyboard this recently counts as someone being there.
const ACTIVE_MS = 60_000;
const CHECK_MS = 5_000;

/**
 * What the user is looking at right now is seen: its pane the active one, the tab in front
 * and the user active. A pane beside it is not looked at yet. When in doubt it stays unseen.
 * Told to the host, so it counts on every device.
 */
export function sessionsToMarkSeen(
  sessions: AllSession[],
  inFront: ReadonlySet<string>,
  facts: { foreground: boolean; lastInputAt: number; now: number },
): string[] {
  if (!facts.foreground || facts.now - facts.lastInputAt >= ACTIVE_MS) return [];
  return sessions.filter((session) => inFront.has(session.id) && isUnseen(session)).map((session) => session.id);
}

export function sessionsInFront(): Set<string> {
  if (getTopView() !== 'desks') return new Set();
  const pane = paneStore.getActivePane();
  return new Set(pane && (pane.paneView === 'chat' || pane.paneView === 'terminal') && pane.sessionId ? [pane.sessionId] : []);
}

export function useSeenResults(): void {
  const { sessions } = useAllSessions(true);
  const known = useRef<AllSession[]>([]);
  known.current = sessions ?? [];
  const lastInputAt = useRef(0);

  const check = useCallback(() => {
    const ids = sessionsToMarkSeen(known.current, sessionsInFront(), {
      foreground: document.visibilityState === 'visible' && document.hasFocus(),
      lastInputAt: lastInputAt.current,
      now: Date.now(),
    });
    for (const id of ids) void markSessionRead(id);
  }, []);

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
