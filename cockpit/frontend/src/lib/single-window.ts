import { useSyncExternalStore } from "react";

/**
 * One active cockpit window per origin. Every window runs the same desks and
 * would auto-connect the same panes, while the host gives each terminal to the
 * last client that attaches — two windows end up taking terminals from each
 * other. So the active window holds an exclusive Web Lock; a second window
 * shows "open in another window" until the user takes over (steal), which
 * makes the first window show the same.
 *
 * Module-level on purpose: the lock is requested once per page load, not per
 * React mount (StrictMode mounts twice). The browser releases it when the tab
 * closes or crashes, so no lock outlives its window.
 */

export type WindowState = "checking" | "active" | "elsewhere";

const LOCK_NAME = "eml-cockpit-active-window";

let state: WindowState = "checking";
const listeners = new Set<() => void>();

function setState(next: WindowState): void {
  if (state === next) return;
  state = next;
  for (const listener of listeners) listener();
}

function hold(options: LockOptions): void {
  navigator.locks
    .request(LOCK_NAME, options, (lock) => {
      if (!lock) {
        setState("elsewhere");
        return;
      }
      setState("active");
      // Held until the page goes away or another window steals it.
      return new Promise<never>(() => {});
    })
    .catch((err: unknown) => {
      // A steal rejects the previous holder's request with AbortError.
      if ((err as Error).name === "AbortError") setState("elsewhere");
    });
}

if (typeof navigator !== "undefined" && navigator.locks) {
  hold({ ifAvailable: true });
} else {
  // No Web Locks (very old browser): behave as before, one window or many.
  state = "active";
}

/** Make this window the active one; the other window shows "elsewhere". */
export function takeOverWindow(): void {
  hold({ steal: true });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWindowState(): WindowState {
  return useSyncExternalStore(subscribe, () => state);
}
