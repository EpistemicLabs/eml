import { archiveSession, clearSession, markSessionRead } from '@/lib/session-actions';
import { getReview, pruneQueue, queueAfter, setReview, type ReviewState } from '@/stores/useReviewStore';
import { setTopView } from '@/stores/useTopViewStore';
import type { AllSession } from '@/components/sidebar/allSessions';

function show(queue: string[], index: number): void {
  setReview({ queue, index });
  const id = queue[index];
  if (id) void markSessionRead(id);
}

/** The review screen over the desks, in the order the caller gives: what needs an answer first. */
export function startReview(sessions: AllSession[]): void {
  if (sessions.length === 0) return;
  show(sessions.map((session) => session.id), 0);
  setTopView('review');
}

/** Back to the desks, as they were. */
export function endReview(): void {
  setReview(null);
  setTopView('desks');
}

/** The queue as it stands: what left the lists is out. */
export function liveQueue(review: ReviewState, sessions: AllSession[]): { queue: string[]; index: number } {
  const listed = new Set(sessions.filter((session) => !session.archivedAt).map((session) => session.id));
  return pruneQueue(review.queue, review.index, listed);
}

/** Next or previous; past either end nothing happens. */
export function stepReview(step: 1 | -1, sessions: AllSession[]): void {
  const review = getReview();
  if (!review) return;
  const { queue, index } = liveQueue(review, sessions);
  if (queue[index + step] !== undefined) show(queue, index + step);
}

function moveOn(sessions: AllSession[]): void {
  const review = getReview();
  if (!review) return;
  const live = liveQueue(review, sessions);
  const { queue, index } = queueAfter(live.queue, live.index);
  if (index >= 0) show(queue, index);
  else endReview();
}

/** Take the current one out (archive, or clear for a pinned one) and go on; after the last the flow ends. */
export async function finishCurrent(action: 'archive' | 'clear', sessions: AllSession[]): Promise<string | null> {
  const review = getReview();
  if (!review) return null;
  const id = review.queue[review.index];
  moveOn(sessions);
  return action === 'archive' ? archiveSession(id) : clearSession(id);
}
