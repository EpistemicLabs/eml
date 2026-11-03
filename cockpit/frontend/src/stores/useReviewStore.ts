// The review flow: one pane going through what waits for the user, what needs an
// answer first. The queue is fixed when it starts, so rows don't move under the
// user as they are read; what arrives later waits for the next round. What leaves
// the lists meanwhile (archived elsewhere) drops out.
import { useSyncExternalStore } from 'react';

export type ReviewState = {
  queue: string[];
  index: number;
  /** The pane showing the current session; the flow swaps the session in it. */
  paneId: string | null;
  /** The flow opened that pane, so it closes it again; a pane the user had open stays. */
  ownsPane: boolean;
};

/** The queue without its current session, and where the flow goes on: the next one, else the one before. */
export function queueAfter(queue: string[], index: number): { queue: string[]; index: number } {
  const rest = queue.filter((_, position) => position !== index);
  return { queue: rest, index: rest.length === 0 ? -1 : Math.min(index, rest.length - 1) };
}

/**
 * The queue without the sessions that left the lists. The current one stays
 * until the flow moves on, so the pane doesn't change under the user.
 */
export function pruneQueue(queue: string[], index: number, listed: ReadonlySet<string>): { queue: string[]; index: number } {
  const current = queue[index];
  const rest = queue.filter((id) => id === current || listed.has(id));
  return { queue: rest, index: current === undefined ? -1 : rest.indexOf(current) };
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

/** The review bar holds the keyboard: its pane's terminal and inputs don't take the focus on their own. */
export function reviewHoldsFocus(paneId: string): boolean {
  return state?.paneId === paneId;
}

export function useReview(): ReviewState | null {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => state,
  );
}
