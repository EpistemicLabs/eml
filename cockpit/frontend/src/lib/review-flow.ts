import { archiveSession, clearSession, markSessionRead } from '@/lib/session-actions';
import { attentionKey, getReview, joinQueue, pruneQueue, queueAfter, setReview, type ReviewState } from '@/stores/useReviewStore';
import { setTopView } from '@/stores/useTopViewStore';
import type { AllSession } from '@/components/sidebar/allSessions';

function show(queue: string[], index: number, seen: Record<string, string> = getReview()?.seen ?? {}): void {
  setReview({ queue, index, seen });
  const id = queue[index];
  if (id) void markSessionRead(id);
}

/** The review screen over the desks, in the order the caller gives: what needs an answer first. */
export function startReview(sessions: AllSession[]): void {
  if (sessions.length === 0) return;
  const seen = Object.fromEntries(sessions.map((session) => [session.id, attentionKey(session)]));
  show(sessions.map((session) => session.id), 0, seen);
  setTopView('review');
}

/** What newly waits, in the same order and from the same list the round started with, joins at the end. */
export function joinReview(sessions: AllSession[]): void {
  const review = getReview();
  if (!review) return;
  const next = joinQueue(review, sessions.map((session) => ({ id: session.id, key: attentionKey(session) })));
  if (next !== review) setReview(next);
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

/** The finished session out of the round: from its place the flow goes on; when nothing is left it ends. */
function takeOut(id: string, sessions: AllSession[]): void {
  const review = getReview();
  if (!review) return;
  const live = liveQueue(review, sessions);
  const position = live.queue.indexOf(id);
  if (position < 0) return;
  // Stepped on meanwhile: the screen stays where the user is.
  if (position !== live.index) {
    const queue = live.queue.filter((queued) => queued !== id);
    setReview({ ...review, queue, index: queue.indexOf(live.queue[live.index]) });
    return;
  }
  const { queue, index } = queueAfter(live.queue, live.index);
  if (index >= 0) show(queue, index);
  else endReview();
}

/**
 * Done (clear) or Archive the current one, then go on. Only once the host has
 * done it: what it refuses stays on screen with the reason.
 */
export async function finishCurrent(action: 'archive' | 'clear', sessions: AllSession[]): Promise<string | null> {
  const review = getReview();
  if (!review) return null;
  const id = review.queue[review.index];
  const error = await (action === 'archive' ? archiveSession(id) : clearSession(id));
  if (!error) takeOut(id, sessions);
  return error;
}
