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

/** The session in front of someone now (the active pane): the host sends no push about it. */
export function sessionsWatched(inFront: ReadonlySet<string>, facts: { foreground: boolean; lastInputAt: number; now: number }): string[] {
  if (!facts.foreground || facts.now - facts.lastInputAt >= ACTIVE_MS) return [];
  return [...inFront];
}

/** Someone works in this cockpit: their notifications come here, not to the phone. */
export function cockpitInUse(facts: { lastInputAt: number; now: number }): boolean {
  return facts.lastInputAt > 0 && facts.now - facts.lastInputAt < IN_USE_MS;
}

/** Whether to tell the host now: while in use, every 30 seconds — its 90-second window counts on that. */
export function shouldReport(facts: { lastInputAt: number; now: number }, reportedAt: number): boolean {
  return cockpitInUse(facts) && facts.now - reportedAt >= REPORT_MS;
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
  const reportedAt = useRef(0);

  const check = useCallback(() => {
    const inFront = sessionsInFront();
    const facts = { foreground: document.visibilityState === 'visible' && document.hasFocus(), lastInputAt: lastInputAt.current, now: Date.now() };
    const ids = sessionsToMarkSeen(known.current, inFront, facts);
    for (const id of ids) void markSessionRead(id);
    if (shouldReport(facts, reportedAt.current)) {
      reportedAt.current = facts.now;
      const watched = sessionsWatched(inFront, facts);
      void pushEndpoint()
        .then((endpoint) => api.pushWatching(watched, endpoint))
        .catch(() => { /* host unreachable: it may push once too often */ });
    }
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
