// Which task view is shown: Inbox, Now or Plan. The top bar switches it and the task board
// reads it, so both live outside the board. Same module-store pattern as useTopViewStore;
// remembered per viewer.
import { useSyncExternalStore } from 'react';

export type TaskView = 'inbox' | 'now' | 'plan';

const STORAGE_KEY = 'cockpit-task-board-view';
const isTaskView = (value: unknown): value is TaskView => value === 'inbox' || value === 'now' || value === 'plan';

function load(): TaskView {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isTaskView(raw) ? raw : 'now';
  } catch {
    return 'now';
  }
}

/** `picks` counts every pick, the same view again too: the board closes an open task on each. */
let state = { view: load(), picks: 0 };
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function getTaskView(): TaskView {
  return state.view;
}

export function setTaskView(view: TaskView): void {
  state = { view, picks: state.picks + 1 };
  try { localStorage.setItem(STORAGE_KEY, view); } catch { /* per-viewer only */ }
  for (const listener of listeners) listener();
}

export function useTaskView(): { view: TaskView; picks: number } {
  return useSyncExternalStore(subscribe, () => state);
}
