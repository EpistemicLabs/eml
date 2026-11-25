// Opening an existing task from the desk (⌘K, the nav's Search tasks, the tasks card's Open task): where the task
// is now and what Enter does with it. Pure, so the rules are tested without a browser; the opening itself is in
// components/command-palette/openTask.ts. A task already open on another desk is gone to, never moved there.
import { type Board, type BoardTask, closedAsTask, OPEN_STATUSES, readable, taskName } from '@/lib/task-board';
import { formatInZone } from '@/lib/time-zone';

export interface LocateContext {
  activeDeskId: string;
  desks: Array<{ id: string; name: string; spaceId: string | null; panes: Array<{ id: string; sessionId?: string | null }> }>;
  sessions: Array<{ id: string; lastActivity?: string | null; projectId?: string | null }>;
  /** Each space by its id (the board's), its name and its key in the pane store (null = main). */
  spaces: Array<{ id: string; name: string; key: string | null }>;
  activeSpaceKey: string | null;
}

/** A space other than the open one: the task opens on one of its desks. */
export interface OtherSpace { name: string; key: string | null }

export type TaskLocation =
  | { kind: 'here'; sessionId: string; paneId: string; paneNumber: number }
  | { kind: 'desk'; sessionId: string; paneId: string; deskId: string; deskName: string }
  | { kind: 'closed'; sessionId: string; projectId: string | null; since: string | null; otherSpace?: OtherSpace }
  | { kind: 'none'; otherSpace?: OtherSpace };

export function locateTask(task: Pick<BoardTask, 'spaceId' | 'sessionIds'>, ctx: LocateContext): TaskLocation {
  const ids = new Set(task.sessionIds);
  const active = ctx.desks.find((d) => d.id === ctx.activeDeskId);
  const hereIndex = active ? active.panes.findIndex((p) => p.sessionId && ids.has(p.sessionId)) : -1;
  if (active && hereIndex >= 0) {
    const pane = active.panes[hereIndex];
    return { kind: 'here', sessionId: pane.sessionId!, paneId: pane.id, paneNumber: hereIndex + 1 };
  }
  for (const desk of ctx.desks) {
    const pane = desk.panes.find((p) => p.sessionId && ids.has(p.sessionId));
    if (pane) {
      const space = ctx.spaces.find((s) => s.key === desk.spaceId);
      const deskName = desk.spaceId !== ctx.activeSpaceKey && space ? `${space.name} · ${desk.name}` : desk.name;
      return { kind: 'desk', sessionId: pane.sessionId!, paneId: pane.id, deskId: desk.id, deskName };
    }
  }
  const taskSpace = ctx.spaces.find((s) => s.id === task.spaceId);
  const otherSpace = taskSpace && taskSpace.key !== ctx.activeSpaceKey ? { otherSpace: { name: taskSpace.name, key: taskSpace.key } } : {};
  const newest = ctx.sessions
    .filter((s) => ids.has(s.id))
    .sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''))[0];
  if (newest) return { kind: 'closed', sessionId: newest.id, projectId: newest.projectId ?? null, since: newest.lastActivity ?? null, ...otherSpace };
  return { kind: 'none', ...otherSpace };
}

const day = (iso: string | null) => (iso ? formatInZone(iso, { day: 'numeric', month: 'short' }) : 'earlier');

/** Where it is, and what Enter does, in the words a row shows. */
export function locationWords(where: TaskLocation): { text: string; act: string } {
  if (where.kind === 'here') return { text: `Open here · pane ${where.paneNumber}`, act: 'Go to pane' };
  if (where.kind === 'desk') return { text: `Open on ${where.deskName}`, act: `Go to ${where.deskName}` };
  const space = where.otherSpace;
  const text = where.kind === 'closed' ? `Session from ${day(where.since)}, not open` : 'No session yet';
  if (space) return { text: `In the ${space.name} space · ${text.charAt(0).toLowerCase()}${text.slice(1)}`, act: where.kind === 'closed' ? `Open in ${space.name}` : `Start in ${space.name}` };
  return { text, act: where.kind === 'closed' ? 'Open in a new pane' : 'Start a session here' };
}

/** `closed`: the group of closed tasks, which open in the task board's panel (to reopen) instead of a session. */
export interface TaskGroup { name: string; tasks: BoardTask[]; closed?: boolean }

/** A task's project as the board names it, or its id made readable. */
export function projectNameOf(board: Pick<Board, 'projects'>, task: BoardTask): string {
  return board.projects.find((p) => p.spaceId === task.spaceId && p.id === task.project)?.name ?? (task.project ? readable(task.project) : '');
}

const needsYou = (t: BoardTask) => t.turn === 'needs_you' || t.turn === 'review';

/**
 * The tasks a search finds: every word in the title, the anchor, the project's name or id, or the space. Open
 * tasks first, then the closed ones the board keeps (newest closed first), so a closed task can be found to reopen.
 * Nothing typed: what needs you first, then the other open tasks; closed ones only show for a search.
 */
export function searchTasks(board: Pick<Board, 'tasks' | 'projects' | 'closed'>, query: string, opts: { project?: string } = {}): TaskGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const order = (a: BoardTask, b: BoardTask) => Number(needsYou(b)) - Number(needsYou(a)) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
  const matches = (t: BoardTask) => {
    if (opts.project && t.project !== opts.project) return false;
    if (words.length === 0) return true;
    const hay = [taskName(t), t.title, projectNameOf(board, t), t.project ?? '', t.spaceName].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  const found = board.tasks.filter((t) => OPEN_STATUSES.has(t.status) && matches(t)).sort(order);
  if (words.length > 0) {
    const openIds = new Set(found.map((t) => t.id));
    const closed = (board.closed ?? []).map(closedAsTask).filter((t) => !openIds.has(t.id) && matches(t))
      .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));
    return [
      ...(found.length ? [{ name: 'Tasks', tasks: found }] : []),
      ...(closed.length ? [{ name: 'Closed', tasks: closed, closed: true }] : []),
    ];
  }
  return [
    { name: 'Needs you', tasks: found.filter(needsYou) },
    { name: 'Other open tasks', tasks: found.filter((t) => !needsYou(t)) },
  ].filter((g) => g.tasks.length > 0);
}
