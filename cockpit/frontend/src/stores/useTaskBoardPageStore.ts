// What the task board shows besides its view: the folds on the Inbox and the task or session that
// is open. The board unmounts when a desk is shown, so this lives outside it: coming back finds it
// as it was left (Lasse 2026-11-23). Memory only; a reload starts fresh. Same module-store pattern
// as useTaskViewStore.
import { useSyncExternalStore } from 'react';

import type { TaskView } from './useTaskViewStore';

/** A task (with the session to show, if one was picked), or a session that has no task. */
export type OpenItem = { taskId: string; sessionId?: string } | { taskId?: undefined; sessionId: string };

export type FoldName = 'fyi' | 'snoozed' | 'unread';

export interface TaskBoardPage {
  /** The open item and the view it was opened in: it shows again only there. */
  open: { item: OpenItem; view: TaskView } | null;
  /** null for Unread: nobody picked, so it follows the Inbox (open only when it is empty). */
  folds: { fyi: boolean; snoozed: boolean; unread: boolean | null };
}

const INITIAL: TaskBoardPage = { open: null, folds: { fyi: false, snoozed: false, unread: null } };

let state: TaskBoardPage = INITIAL;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

function update(next: TaskBoardPage): void {
  state = next;
  for (const listener of listeners) listener();
}

export function setOpenItem(item: OpenItem | null, view: TaskView): void {
  update({ ...state, open: item ? { item, view } : null });
}

export function setFold(name: FoldName, open: boolean): void {
  update({ ...state, folds: { ...state.folds, [name]: open } });
}

/** The open item if it belongs to this view. */
export const openItemIn = (page: TaskBoardPage, view: TaskView): OpenItem | null =>
  page.open && page.open.view === view ? page.open.item : null;

export function getTaskBoardPage(): TaskBoardPage {
  return state;
}

/** Back to a fresh visit; for tests. */
export function resetTaskBoardPage(): void {
  update(INITIAL);
}

export function useTaskBoardPage(): TaskBoardPage {
  return useSyncExternalStore(subscribe, () => state);
}
