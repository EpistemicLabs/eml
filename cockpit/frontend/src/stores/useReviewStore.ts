// The review flow: one pane going through what waits for the user, what needs an
// answer first. The queue is fixed when it starts, so rows don't move under the
// user as they are read; what arrives later waits for the next round.
import { useSyncExternalStore } from 'react';

export type ReviewState = {
  queue: string[];
  index: number;
  /** The pane showing the current session. */
  paneId: string | null;
  /** The flow opened that pane, so it closes it again; a pane the user had open stays. */
  ownsPane: boolean;
};

/** The queue without its current session, and where the flow goes on: the next one, else the one before. */
export function queueAfter(queue: string[], index: number): { queue: string[]; index: number } {
  const rest = queue.filter((_, position) => position !== index);
  return { queue: rest, index: rest.length === 0 ? -1 : Math.min(index, rest.length - 1) };
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

export function useReview(): ReviewState | null {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => state,
  );
}
