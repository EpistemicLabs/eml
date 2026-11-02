import { closePane } from '@/lib/pane-close';
import { archiveSession, clearSession, markSessionRead } from '@/lib/session-actions';
import { openSessionInSpace, paneHoldingSession } from '@/stores/usePaneStore';
import { getReview, setReview } from '@/stores/useReviewStore';
import { paneSpaceKey, type SpaceInfo } from '@/stores/useSpaceStore';
import type { AllSession } from '@/components/sidebar/allSessions';

/** Show the session in the review pane: it opens, then the one before it closes if the flow opened that. */
function show(session: AllSession, spaces: SpaceInfo[], queue: string[], index: number): void {
  const previous = getReview();
  const space = spaces.find((candidate) => candidate.id === session.spaceId) ?? spaces[0];
  const ownsPane = !paneHoldingSession(session.id);
  const paneId = openSessionInSpace(paneSpaceKey(space), {
    surface: 'terminal',
    projectId: session.__projectId ?? null,
    sessionId: session.id,
    chat: session.runtime === 'sdk',
  });
  if (previous?.ownsPane && previous.paneId && previous.paneId !== paneId) closePane(previous.paneId);
  setReview({ queue, index, paneId, ownsPane });
  void markSessionRead(session.id);
}

export function startReview(sessions: AllSession[], spaces: SpaceInfo[]): void {
  if (sessions.length === 0) return;
  show(sessions[0], spaces, sessions.map((session) => session.id), 0);
}

export function endReview(): void {
  const review = getReview();
  setReview(null);
  if (review?.ownsPane && review.paneId) closePane(review.paneId);
}

/** Next or previous; past either end nothing happens. */
export function stepReview(step: 1 | -1, sessions: AllSession[], spaces: SpaceInfo[]): void {
  const review = getReview();
  if (!review) return;
  const index = review.index + step;
  const session = sessions.find((candidate) => candidate.id === review.queue[index]);
  if (session) show(session, spaces, review.queue, index);
}

/** Take the current one out (archive, or clear for a pinned one) and go on; after the last the flow ends. */
export async function finishCurrent(
  action: 'archive' | 'clear',
  sessions: AllSession[],
  spaces: SpaceInfo[],
): Promise<string | null> {
  const review = getReview();
  if (!review) return null;
  const id = review.queue[review.index];
  const queue = review.queue.filter((candidate) => candidate !== id);
  const session = sessions.find((candidate) => candidate.id === queue[review.index])
    ?? sessions.find((candidate) => candidate.id === queue[review.index - 1]);
  const index = session ? queue.indexOf(session.id) : -1;
  // The pane moves on first: archiving closes a pane still showing the session.
  if (session) show(session, spaces, queue, index);
  else endReview();
  return action === 'archive' ? archiveSession(id) : clearSession(id);
}
