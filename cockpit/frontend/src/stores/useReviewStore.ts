// The review flow: one pane going through finished sessions. The queue is fixed
// when it starts, so rows don't move under the user as they are read; finished
// work that arrives later joins at the end.
import { useSyncExternalStore } from 'react';

export type ReviewState = {
  queue: string[];
  index: number;
  /** The pane showing the current session. */
  paneId: string | null;
  /** The flow opened that pane, so it closes it again; a pane the user had open stays. */
  ownsPane: boolean;
};

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
