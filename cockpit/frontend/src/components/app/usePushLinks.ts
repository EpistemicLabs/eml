import { useEffect } from 'react';

import { openSession } from '@/components/jobs/jobs';
import type { AllSession } from '@/components/sidebar/allSessions';
import { getSpaces, loadSpaces, paneSpaceKey } from '@/stores/useSpaceStore';

/** Open the session a notification names, in its own space; one the host no longer knows is ignored. */
export async function openLinkedSession(sessionId: string): Promise<void> {
  const response = await fetch('/api/sessions/all');
  if (!response.ok) return;
  const { sessions } = (await response.json()) as { sessions?: AllSession[] };
  const session = sessions?.find((candidate) => candidate.id === sessionId);
  if (!session) return;
  const spaces = getSpaces().length > 0 ? getSpaces() : await loadSpaces();
  const space = spaces.find((candidate) => candidate.id === session.spaceId);
  openSession(space ? paneSpaceKey(space) : null, session.id, { projectId: typeof session.projectId === 'string' ? session.projectId : null, chat: session.runtime === 'sdk' });
}

/**
 * A tap on a notification: the service worker opens the cockpit at /?session=<id>,
 * or, when it is open already, sends it the session (public/sw.js).
 */
export function usePushLinks(): void {
  useEffect(() => {
    const url = new URL(window.location.href);
    const linked = url.searchParams.get('session');
    if (linked) {
      url.searchParams.delete('session');
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
      void openLinkedSession(linked).catch(() => { /* host unreachable: the cockpit opens as it was */ });
    }
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent<{ type?: string; sessionId?: string }>) => {
      if (event.data?.type === 'open-session' && event.data.sessionId) void openLinkedSession(event.data.sessionId).catch(() => {});
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, []);
}
