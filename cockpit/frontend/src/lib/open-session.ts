// Open a session in a desk pane from anywhere in the page (a notification's link).
import * as paneStore from '@/stores/usePaneStore';
import { setTopView } from '@/stores/useTopViewStore';

/** Open a session in its space: on the desks, in its chat. */
export function openSession(spaceId: string | null, sessionId: string, session: { projectId: string | null } | null | undefined): void {
  setTopView('desks');
  paneStore.openSessionInSpace(spaceId, {
    surface: 'session', projectId: session?.projectId ?? null, sessionId,
  });
}
