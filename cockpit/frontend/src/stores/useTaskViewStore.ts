// Which task view is shown: Inbox, Now or Plan. The top bar switches it and the task board
// reads it, so both live outside the board. Same module-store pattern as useTopViewStore;
// remembered per viewer.
import { useSyncExternalStore } from 'react';

import type { BoardTask } from '@/lib/task-board';

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

// A task to open in the board's panel from elsewhere (⌘K on a closed task, the tasks card's Show done): the board
// takes it once it has loaded. `task`: the task itself, for a closed one older than the board's own lists.
let panelRequest: string | null = null;
let panelTask: BoardTask | null = null;
const panelListeners = new Set<() => void>();

/** Show the Tasks screen with this task open in its panel. */
export function requestTaskPanel(taskId: string, task?: BoardTask): void {
  panelRequest = taskId;
  panelTask = task?.id === taskId ? task : null;
  for (const listener of panelListeners) listener();
}

/** The board took the request (or it can't be shown). */
export function clearTaskPanelRequest(): void {
  if (panelRequest === null) return;
  panelRequest = null;
  panelTask = null;
  for (const listener of panelListeners) listener();
}

/** The task that came with the request, if any: the board opens it when its own lists don't hold the id. */
export function taskPanelRequestTask(): BoardTask | null {
  return panelTask;
}

export function useTaskPanelRequest(): string | null {
  return useSyncExternalStore((listener) => { panelListeners.add(listener); return () => { panelListeners.delete(listener); }; }, () => panelRequest);
}
