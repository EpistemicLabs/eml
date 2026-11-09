import { useCallback, useEffect, useRef } from 'react';

import { isUnseen, type AllSession } from '@/components/sidebar/allSessions';
import { useAllSessions } from '@/components/sidebar/useAllSessions';
import { markSessionRead } from '@/lib/session-actions';
import * as paneStore from '@/stores/usePaneStore';
import { getTopView } from '@/stores/useTopViewStore';
import { api } from '@/utils/api';

// A hand on the mouse or keyboard this recently counts as someone being there.
const ACTIVE_MS = 60_000;
const CHECK_MS = 5_000;
// The host holds back a push about a session it heard of within a minute (host push-notifier.ts).
const WATCHING_MS = 20_000;

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
  const toldWatchingAt = useRef(0);

  const check = useCallback(() => {
    const onScreen = sessionsOnScreen(compact);
    const facts = { foreground: document.visibilityState === 'visible' && document.hasFocus(), lastInputAt: lastInputAt.current, now: Date.now() };
    const ids = sessionsToMarkSeen(known.current, onScreen, facts);
    for (const id of ids) void markSessionRead(id);
    const watched = sessionsWatched(onScreen, facts);
    if (watched.length > 0 && facts.now - toldWatchingAt.current >= WATCHING_MS) {
      toldWatchingAt.current = facts.now;
      void api.pushWatching(watched).catch(() => { /* host unreachable: it may push once too often */ });
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
