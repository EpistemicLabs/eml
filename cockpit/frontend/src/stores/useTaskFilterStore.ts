// The Owner and Space picks of the task board, shared by Now and Plan: a pick on one is set on
// the other, and stays when the viewer goes to the Inbox, a desk or reloads. Same module-store
// pattern as useTaskViewStore; remembered per viewer.
import { useSyncExternalStore } from 'react';

import type { TaskFilter } from '@/lib/task-board';

const STORAGE_KEY = 'cockpit-task-board-filter';
export const DEFAULT_TASK_FILTER: TaskFilter = { everyone: false, spaceId: null };

function load(): TaskFilter {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<TaskFilter> | null;
    return {
      everyone: raw?.everyone === true,
      spaceId: typeof raw?.spaceId === 'string' && raw.spaceId ? raw.spaceId : null,
    };
  } catch {
    return DEFAULT_TASK_FILTER;
  }
}

let state = load();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function setTaskFilter(patch: Partial<TaskFilter>): void {
  state = { ...state, ...patch };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* per-viewer only */ }
  for (const listener of listeners) listener();
}

export function useTaskFilter(): TaskFilter {
  return useSyncExternalStore(subscribe, () => state);
}
