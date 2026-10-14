// Cockpit addition: the header carries a fixed Brain
// tab next to the brand label, before the desk tabs. It switches the main
// area between the desk/pane grid and the brain dashboard. Same module-
// store + useSyncExternalStore pattern as usePaneStore; persisted so a
// reload lands where you were.
import { useSyncExternalStore } from 'react';

export type TopView = 'desks' | 'brain';

const STORAGE_KEY = 'cockpit-top-view';

const isTopView = (value: unknown): value is TopView => value === 'desks' || value === 'brain';

function load(): TopView {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // 'spaces' is the pre-0.17.4 name of the desk view; rewrite it on load.
    if (raw === 'spaces') {
      localStorage.setItem(STORAGE_KEY, 'desks');
      return 'desks';
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
