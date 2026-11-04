// The review flow: a screen of its own, next to the desks and the brain, going
// through what waits for the user, what needs an answer first. The desks stay as
// they are underneath. What newly waits while a round is open joins at the end,
// in the order the round started with, so nothing moves under the user: the
// current session stays and the queue keeps its order. A session finished in this
// round stays out until it asks again with a new request. The round ends only
// when nothing is left. What leaves the lists meanwhile (archived elsewhere) drops out.
import { useSyncExternalStore } from 'react';

export type ReviewState = {
  queue: string[];
  index: number;
  /** Every session this round has taken in, by the request it came with (attentionKey). */
  seen: Record<string, string>;
};

/** A session waiting for the user, by the request it waits with. */
export type Waiting = { id: string; key: string };

/** Which request a session waits with: a new status gives a new key, a re-render the same. */
export function attentionKey(session: { attention?: { at: string } | null; resultAt?: string | null }): string {
  return `${session.attention?.at ?? ''}|${session.resultAt ?? ''}`;
}

/** The id the review screen's session view uses where a pane would give its own. */
export const REVIEW_PANE_ID = 'review';

/** The queue without its current session, and where the flow goes on: the next one, else the one before. */
export function queueAfter(queue: string[], index: number): { queue: string[]; index: number } {
  const rest = queue.filter((_, position) => position !== index);
  return { queue: rest, index: rest.length === 0 ? -1 : Math.min(index, rest.length - 1) };
}

/**
 * The queue without the sessions that left the lists. The current one stays
 * until the flow moves on, so the screen doesn't change under the user.
 */
export function pruneQueue(queue: string[], index: number, listed: ReadonlySet<string>): { queue: string[]; index: number } {
  const current = queue[index];
  const rest = queue.filter((id) => id === current || listed.has(id));
  return { queue: rest, index: current === undefined ? -1 : rest.indexOf(current) };
}

/**
 * The round with what newly waits appended, in the order given. Nothing in the
 * queue moves; what the round took in before comes back only with a new request.
 * The same state when nothing joined, so a re-render changes nothing.
 */
export function joinQueue(review: ReviewState, waiting: readonly Waiting[]): ReviewState {
  const queued = new Set(review.queue);
  const queue = [...review.queue];
  const seen = { ...review.seen };
  let changed = false;
  for (const { id, key } of waiting) {
    if (seen[id] === key) continue;
    seen[id] = key;
    changed = true;
    // Still in the queue: it keeps its place, under its new request.
    if (!queued.has(id)) {
      queue.push(id);
      queued.add(id);
    }
  }
  return changed ? { ...review, queue, seen } : review;
}

// A terminal session has one viewer: the review screen borrows it from its pane,
// and says so when it is done with it, so the pane takes it back.
export const RECLAIM_TERMINAL_EVENT = 'cockpit:reclaim-terminal';

export function reclaimTerminal(sessionId: string): void {
  window.dispatchEvent(new CustomEvent(RECLAIM_TERMINAL_EVENT, { detail: { sessionId } }));
}

let state: ReviewState | null = null;
const listeners = new Set<() => void>();

export function getReview(): ReviewState | null {
  return state;
}

export function setReview(next: ReviewState | null): void {
  state = next;
  for (const listener of listeners) listener();
}

// The review screen's bar registers how it takes the keyboard back.
let focusBar: (() => void) | null = null;

export function setReviewBarFocus(focus: (() => void) | null): void {
  focusBar = focus;
}

/** A reply sent from the review screen: the keyboard goes back to its bar, so D and A step again. */
export function returnToReviewBar(paneId: string): void {
  if (state && paneId === REVIEW_PANE_ID) focusBar?.();
}

export function useReview(): ReviewState | null {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => state,
  );
}
