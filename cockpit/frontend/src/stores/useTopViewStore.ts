// What the main area shows: the desk/pane grid, a space's brain dashboard, the task views. Same module-
// store + useSyncExternalStore pattern as usePaneStore; persisted so a
// reload lands where you were.
import { useSyncExternalStore } from 'react';

export type TopView = 'desks' | 'brain' | 'tasks';

const STORAGE_KEY = 'cockpit-top-view';

const isTopView = (value: unknown): value is TopView => value === 'desks' || value === 'brain' || value === 'tasks';

function load(): TopView {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // 'spaces' is the pre-0.17.4 name of the desk view; rewrite it on load.
    if (raw === 'spaces') {
      localStorage.setItem(STORAGE_KEY, 'desks');
      return 'desks';
    }
    // A stored view of 'jobs' opens the task views: a schedule sits on its task.
    if (raw === 'jobs') {
      localStorage.setItem(STORAGE_KEY, 'tasks');
      return 'tasks';
    }
    return isTopView(raw) ? raw : 'desks';
  } catch {
    return 'desks';
  }
}

let view: TopView = load();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function getTopView(): TopView {
  return view;
}

export function setTopView(next: TopView): void {
  if (view === next) return;
  view = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* non-fatal */ }
  for (const listener of listeners) listener();
}

export function useTopView(): TopView {
  return useSyncExternalStore(subscribe, getTopView);
}
