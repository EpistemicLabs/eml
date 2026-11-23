// Where the tasks card sits: next to the sidebar (the default), right of the desk, or hidden.
// Settings picks the place; ⌘T (installed app) and G then T hide it and bring it back where it was.
// Same module-store pattern as useTaskViewStore; remembered per viewer.
import { useSyncExternalStore } from 'react';

export type TasksCardPlace = 'left' | 'right';
export interface TasksCardState { place: TasksCardPlace; shown: boolean }

const STORAGE_KEY = 'cockpit-tasks-card';
const DEFAULT: TasksCardState = { place: 'left', shown: true };

function load(): TasksCardState {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<TasksCardState> | null;
    return {
      place: raw?.place === 'right' ? 'right' : 'left',
      shown: typeof raw?.shown === 'boolean' ? raw.shown : DEFAULT.shown,
    };
  } catch {
    return DEFAULT;
  }
}

let state = load();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

function set(next: TasksCardState): void {
  state = next;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* per-viewer only */ }
  for (const listener of listeners) listener();
}

export const setTasksCardPlace = (place: TasksCardPlace): void => set({ place, shown: true });
export const setTasksCardShown = (shown: boolean): void => set({ ...state, shown });
export const toggleTasksCard = (): void => set({ ...state, shown: !state.shown });

export function useTasksCard(): TasksCardState {
  return useSyncExternalStore(subscribe, () => state);
}
