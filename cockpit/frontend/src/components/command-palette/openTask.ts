// Open an existing task from the desk (⌘K, Search tasks, Open task…): focus its pane, go to the desk it is
// open on, open its session in a new pane, or start a session on it, on this desk or a new one named after the
// task. Opening is navigation only: nothing is written to the brain, and Undo puts the desk back. The toast
// that offers Undo lives here too, so it stays after the palette has closed.
import { useSyncExternalStore } from 'react';

import { projectIdOfBrain } from '@/lib/project-lead';
import { readable, startTaskSession, type BoardTask } from '@/lib/task-board';
import type { TaskLocation } from '@/lib/open-task';
import type { ToastMessage } from '@/shared/view/ui/Toast';
import {
  activateDesk, activatePane, activateSpace, addWorkerPane, ensureDeskBySlug, getActiveDeskId, getActivePaneId,
  getActiveSpaceId, openInPane, paneHoldingSession, removeDesk, removePane, getDesks,
} from '@/stores/usePaneStore';

/** The palette opens on its Open task page (a project to keep to, or none). */
export const TASK_SEARCH_EVENT = 'cockpit:task-search';
export function openTaskSearch(project: string | null = null): void {
  window.dispatchEvent(new CustomEvent(TASK_SEARCH_EVENT, { detail: { project } }));
}

/** How long Undo stays offered. */
const UNDO_MS = 8000;

let toast: ToastMessage | null = null;
const listeners = new Set<() => void>();
const say = (message: ToastMessage | null) => { toast = message; for (const l of listeners) l(); };
export function useOpenTaskToast(): [ToastMessage | null, (id: string) => void] {
  const message = useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => toast);
  return [message, (id) => { if (toast?.id === id) say(null); }];
}

/** Ending a session this opening started (Undo): stopped and archived, like the sidebar's Archive. */
const archiveSession = (sessionId: string) => fetch(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, { method: 'POST' }).catch(() => undefined);

export async function openTask(task: BoardTask, where: TaskLocation, opts: { newDesk: boolean }): Promise<void> {
  const title = readable(task.title);
  const before = { paneId: getActivePaneId(), deskId: getActiveDeskId(), spaceKey: getActiveSpaceId() };
  const back = () => {
    activateSpace(before.spaceKey);
    if (getDesks().some((d) => d.id === before.deskId)) activateDesk(before.deskId);
    if (before.paneId) activatePane(before.paneId);
  };
  const offer = (text: string, undo: () => void) => say({ id: crypto.randomUUID(), text, ms: UNDO_MS, action: { label: 'Undo', run: undo } });

  // Already in a pane: here it is focused; on another desk that desk opens (the session is never moved there).
  if (where.kind === 'here') { activatePane(where.paneId); return; }
  if (where.kind === 'desk') {
    activatePane(where.paneId);
    offer(`Switched to ${where.deskName}, where ${title} is open.`, back);
    return;
  }

  // Everything else adds a pane: on this desk, the task's space's desk, or a new desk named after the task.
  if (where.otherSpace) activateSpace(where.otherSpace.key);
  const existingDesks = new Set(getDesks().map((d) => d.id));
  const deskId = opts.newDesk ? ensureDeskBySlug(`task-${task.title}`, { name: title }) : getActiveDeskId();
  const madeDesk = opts.newDesk && !existingDesks.has(deskId);
  if (opts.newDesk) activateDesk(deskId);
  const dropDesk = () => { if (madeDesk) removeDesk(deskId); };

  if (where.kind === 'closed') {
    const paneId = openInPane({ surface: 'terminal', projectId: where.projectId, sessionId: where.sessionId });
    offer(opts.newDesk ? `Opened ${title} in a new desk.` : `Opened ${title} in a new pane.`, () => { removePane(paneId); dropDesk(); back(); });
    return;
  }

  // No session yet: the host starts one with the task bound (in chat when that is the user's view); an older
  // host can't, so then a terminal pane starts it.
  const prompt = `Work on task ${task.id} ("${title}") together with the user. Start by saying where it stands and what you would do next.`;
  const projectId = task.project ? projectIdOfBrain(task.project) : null;
  const sessionId = await startTaskSession(task, { ...(projectId ? { projectId } : {}), prompt, title, deskId });
  if (!sessionId && projectId) {
    const paneId = addWorkerPane({ fromSessionId: null, projectId, prompt, title, deskId, taskId: task.id });
    offer(`Started a session on ${title}.`, () => { removePane(paneId); dropDesk(); back(); });
    return;
  }
  if (!sessionId) { say({ id: crypto.randomUUID(), text: `${title} has no project to start a session in.`, ms: UNDO_MS }); return; }
  const started = sessionId;
  offer(opts.newDesk ? `Started a session on ${title} in a new desk.` : `Started a session on ${title}.`, () => {
    const pane = paneHoldingSession(started);
    if (pane) removePane(pane.id);
    void archiveSession(started);
    dropDesk();
    back();
  });
}
