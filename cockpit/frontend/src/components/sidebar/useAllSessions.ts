// The sessions of every brain space for the sidebar. State changes arrive live
// over /api/events and trigger a refetch; new sessions and renames have no event,
// so a slower poll covers them while the page is visible.
import { useCallback, useEffect, useState } from 'react';

import { SESSIONS_CHANGED_EVENT } from '@/lib/session-actions';
import { useTurnStore } from '@/stores/useTurnStateStore';
import type { AllSession, QueuedWorker } from './allSessions';

const POLL_INTERVAL_MS = 15_000;
const TURN_REFETCH_DELAY_MS = 1_000;

// The last answer: a list opening later (the review bar) starts from it instead of from nothing.
let lastSessions: AllSession[] | null = null;
let lastQueued: QueuedWorker[] = [];

export function useAllSessions(enabled: boolean) {
  const [sessions, setSessions] = useState<AllSession[] | null>(lastSessions);
  const [queued, setQueued] = useState<QueuedWorker[]>(lastQueued);
  const { turns } = useTurnStore();

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/sessions/all');
      if (!response.ok) return;
      const body = (await response.json()) as { sessions?: AllSession[]; queued?: QueuedWorker[] };
      lastSessions = body.sessions ?? [];
      lastQueued = body.queued ?? [];
      setSessions(lastSessions);
      setQueued(lastQueued);
    } catch { /* host unreachable: the list stays */ }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_INTERVAL_MS);
    const onChanged = () => void refresh();
    window.addEventListener(SESSIONS_CHANGED_EVENT, onChanged);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener(SESSIONS_CHANGED_EVENT, onChanged);
    };
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => void refresh(), TURN_REFETCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, refresh, turns]);

  return { sessions, queued, refresh };
}
