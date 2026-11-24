// The Inbox's Working now column: every session that works at this moment, across all spaces, and
// the next scheduled runs. Pure, so which sessions count and in what order is tested without a browser.
import { agentLabel, agentLetter, allSessionState, type AllSession } from '@/components/sidebar/allSessions';
import { sessionDisplayName } from '@/components/sidebar/utils';
import { projectNameOf } from '@/lib/open-task';
import { agentName, type Board, type BoardTask, readable, taskName } from '@/lib/task-board';
import { deskOf } from '@/lib/unread-answers';
import type { SpaceInfo } from '@/stores/useSpaceStore';
import type { TurnInfo } from '@/stores/useTurnStateStore';

export interface WorkingRow {
  key: string;
  /** This cockpit's session; null for a run on another member's cockpit, which opens through its task. */
  sessionId: string | null;
  task: BoardTask | undefined;
  /** The agent's letter and name. */
  letter: string;
  agent: string;
  name: string;
  /** Space · project. */
  where: string;
  /** A desk session, a worker another session started, or a run on another member's cockpit. */
  kind: 'desk' | 'worker' | 'member';
  member?: string;
  /** When the current turn started working; null when the board does not say. */
  since: string | null;
  /** The task's status line, when it has one. */
  step: string | null;
}

/** Sessions working now: this cockpit's own (the live turn state), then other members' runs from the board. Oldest first, so rows stay put while agents work. */
export function workingNow(sessions: AllSession[], turns: Record<string, TurnInfo>, board: Pick<Board, 'tasks' | 'projects'>, spaces: SpaceInfo[]): WorkingRow[] {
  const byId = new Map(board.tasks.map((t) => [t.id, t]));
  const rows: WorkingRow[] = [];
  for (const s of sessions) {
    if (s.archivedAt || allSessionState(s, turns[s.id]) !== 'working') continue;
    const space = spaces.find((sp) => sp.id === s.spaceId);
    const task = (s.taskId ? byId.get(s.taskId) : undefined) ?? board.tasks.find((t) => t.spaceId === s.spaceId && t.sessionIds.includes(s.id));
    rows.push({
      key: s.id,
      sessionId: s.id,
      task,
      letter: space ? agentLetter(space) : '?',
      agent: space ? agentLabel(space) : 'Agent',
      name: task ? taskName(task) : readable(sessionDisplayName(s)) || 'New session',
      where: task ? [task.spaceName, projectNameOf(board, task)].filter(Boolean).join(' · ') : deskOf(s, board, space),
      kind: s.worker ? 'worker' : 'desk',
      since: turns[s.id]?.since ?? s.turnSince ?? null,
      step: task?.statusLine?.now ?? null,
    });
  }
  for (const task of board.tasks) {
    for (const run of task.runs ?? []) {
      if (run.here || run.state !== 'running') continue;
      const name = agentName(run.agent ?? task.delegate);
      rows.push({
        key: `${run.member}:${run.id}`,
        sessionId: null,
        task,
        letter: name.charAt(0).toUpperCase(),
        agent: name,
        name: taskName(task),
        where: [task.spaceName, projectNameOf(board, task)].filter(Boolean).join(' · '),
        kind: 'member',
        member: run.member,
        since: null,
        step: task.statusLine?.now ?? null,
      });
    }
  }
  return rows.sort((a, b) => (a.since ?? '￿').localeCompare(b.since ?? '￿'));
}

/** Tasks an agent picks up at a set time, soonest first. */
export function nextRuns(board: Pick<Board, 'tasks'>): BoardTask[] {
  return board.tasks
    .filter((t) => t.nextRunAt && !t.working)
    .sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt)));
}

/** How long a turn has been working: "4 min", "1 h 05". */
export function workingFor(since: string | null, now: number): string {
  const at = since ? Date.parse(since) : NaN;
  if (!Number.isFinite(at)) return '';
  const min = Math.max(0, Math.floor((now - at) / 60_000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}
