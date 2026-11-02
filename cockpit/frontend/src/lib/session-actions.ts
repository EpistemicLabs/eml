// What the sidebar and the review pane do to a session on the host. Each answers
// with what went wrong, or null; the lists refetch on SESSIONS_CHANGED_EVENT.
import { useSyncExternalStore } from 'react';

import { closePane } from '@/lib/pane-close';
import { paneHoldingSession } from '@/stores/usePaneStore';

export const SESSIONS_CHANGED_EVENT = 'cockpit:sessions-changed';

const FALLBACK = 'The cockpit host did not answer. Try again.';

async function post(sessionId: string, action: string, body?: unknown): Promise<string | null> {
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/${action}`, {
      method: 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    window.dispatchEvent(new CustomEvent(SESSIONS_CHANGED_EVENT));
    if (response.ok) return null;
    const answer = (await response.json().catch(() => null)) as { outcome?: string; error?: { message?: string } } | null;
    if (answer?.outcome === 'busy') return 'That session runs in a terminal. Open it to answer there.';
    if (answer?.outcome) return 'That session cannot take a message from here. Open it to answer there.';
    return answer?.error?.message ?? FALLBACK;
  } catch {
    return FALLBACK;
  }
}

export const markSessionRead = (sessionId: string) => post(sessionId, 'read');
/** Nothing left to do for it; it stays where it was otherwise (a pinned session goes back to its place). */
export const clearSession = (sessionId: string) => post(sessionId, 'clear');
export const stopSession = (sessionId: string) => post(sessionId, 'stop');
export const answerSession = (sessionId: string, text: string) => post(sessionId, 'answer', { text });

/** Out of the lists, with its finished workers; a pane still showing it closes. */
export async function archiveSession(sessionId: string): Promise<string | null> {
  const error = await post(sessionId, 'archive');
  if (error) return error;
  const pane = paneHoldingSession(sessionId);
  if (pane) closePane(pane.id);
  return null;
}

export async function archiveOldWorkers(ids: string[]): Promise<string | null> {
  try {
    const response = await fetch('/api/sessions/archive-old', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    window.dispatchEvent(new CustomEvent(SESSIONS_CHANGED_EVENT));
    return response.ok ? null : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

// The one row whose reply box is open, whichever way it was asked for (hover chip, phone menu).
let answering: string | null = null;
const listeners = new Set<() => void>();

export function setAnswering(sessionId: string | null): void {
  answering = sessionId;
  for (const listener of listeners) listener();
}

export function useAnswering(): string | null {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => answering,
  );
}
