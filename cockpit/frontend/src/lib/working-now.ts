// The Inbox's Working now column: every session that works at this moment, across all spaces, and
// the next scheduled runs. Pure, so which sessions count and in what order is tested without a browser.
import { agentLabel, agentLetter, allSessionState, commandWord, waitingWord, waitsForCommand, type AllSession } from '@/components/sidebar/allSessions';
import { sessionDisplayName } from '@/components/sidebar/utils';
import { projectNameOf } from '@/lib/open-task';
import { agentName, type Board, type BoardTask, CLOSED_STATUSES, readable, taskName } from '@/lib/task-board';
import { deskOf } from '@/lib/unread-answers';
import type { SpaceInfo } from '@/stores/useSpaceStore';
import type { RunningCommand, TurnInfo } from '@/stores/useTurnStateStore';

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
  /** Its own turn is over and it waits for subagents or workflow runs it started: the words for it ("Waiting for 2 subagents"). */
  waiting: string | null;
  /** Its turn is over while background commands it started run: the words for it and the longest-running one. */
  command: { label: string; description: string; since: string } | null;
}

/** The longest-running of a session's commands; null when none runs. */
const oldest = (commands: RunningCommand[] | undefined): RunningCommand | null =>
  commands?.length ? commands.reduce((a, b) => (b.since < a.since ? b : a)) : null;

/**
 * When the session's task closed (ms), from the board's open or closed tasks; null while the task is open or the board
 * does not hold it. A close the board has no time for comes after every turn.
 */
function taskClosedAt(session: AllSession, task: BoardTask | undefined, board: Pick<Board, 'closed'>): number | null {
  const at = (time: string | null | undefined) => { const ms = Date.parse(time ?? ''); return Number.isFinite(ms) ? ms : Infinity; };
  if (task) return CLOSED_STATUSES.has(task.status) ? at(task.updatedAt) : null;
  const closed = board.closed?.find((t) => (session.taskId ? t.id === session.taskId : t.spaceId === session.spaceId && t.sessionIds.includes(session.id)));
  return closed ? at(closed.closedAt) : null;
}

/**
 * Sessions working now: this cockpit's own (the live turn state), then other members' runs from the board. A session
 * whose turn is over while a command it started runs is a row too, for as long as the command runs. A session whose
 * task is closed counts only with a turn that started after the close: one from before ended with it, whatever its
 * state still says. Oldest first, so rows stay put while agents work.
 */
export function workingNow(sessions: AllSession[], turns: Record<string, TurnInfo>, board: Pick<Board, 'tasks' | 'projects' | 'closed'>, spaces: SpaceInfo[]): WorkingRow[] {
  const byId = new Map(board.tasks.map((t) => [t.id, t]));
  const rows: WorkingRow[] = [];
  for (const s of sessions) {
    if (s.archivedAt) continue;
    const turn = turns[s.id];
    const command = waitsForCommand(s, turn) ? oldest(turn?.commands) : null;
    if (!command && allSessionState(s, turn) !== 'working') continue;
    const task = (s.taskId ? byId.get(s.taskId) : undefined) ?? board.tasks.find((t) => t.spaceId === s.spaceId && t.sessionIds.includes(s.id));
    const closedAt = taskClosedAt(s, task, board);
    if (!command && closedAt !== null && !(Date.parse(turn?.since ?? s.turnSince ?? '') > closedAt)) continue;
    const space = spaces.find((sp) => sp.id === s.spaceId);
    rows.push({
      key: s.id,
      sessionId: s.id,
      task,
      letter: space ? agentLetter(space) : '?',
      agent: space ? agentLabel(space) : 'Agent',
      name: task ? taskName(task) : readable(sessionDisplayName(s)) || 'New session',
      where: task ? [task.spaceName, projectNameOf(board, task)].filter(Boolean).join(' · ') : deskOf(s, board, space),
      kind: s.worker ? 'worker' : 'desk',
      since: command?.since ?? turn?.since ?? s.turnSince ?? null,
      step: task?.statusLine?.now ?? null,
      waiting: waitingWord(turn),
      command: command ? { label: commandWord(turn), description: command.description, since: command.since } : null,
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
        waiting: null,
        command: null,
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

/** How long a turn or a command has been running: "4 min", "1 h 05", "2 d 4 h". */
export function workingFor(since: string | null, now: number): string {
  const at = since ? Date.parse(since) : NaN;
  if (!Number.isFinite(at)) return '';
  const min = Math.max(0, Math.floor((now - at) / 60_000));
  if (min < 60) return `${min} min`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
  return `${Math.floor(min / (24 * 60))} d ${Math.floor((min % (24 * 60)) / 60)} h`;
}

/** A row waiting for a command, in words: "Waiting for a command · Run the tests · 12 min". */
export function commandLine(command: NonNullable<WorkingRow['command']>, now: number): string {
  return `${command.label} · ${command.description} · ${workingFor(command.since, now)}`;
}

/** The count in the header: "3", or "2 working · 1 waiting for a command" when some rows wait for a command. */
export function workingCount(rows: WorkingRow[]): string {
  const waiting = rows.filter((row) => row.command).length;
  if (waiting === 0) return String(rows.length);
  return `${rows.length - waiting} working · ${waiting} waiting for ${waiting === 1 ? 'a command' : 'commands'}`;
}

/** The extra line on a task whose session waits for its commands; null while none runs. */
export function commandsNote(task: Pick<BoardTask, 'commands'>, now: number): string | null {
  const commands = task.commands ?? [];
  const first = oldest(commands);
  if (!first) return null;
  if (commands.length === 1) return `A command is still running (${first.description}, ${workingFor(first.since, now)}); the session continues when it finishes.`;
  return `${commands.length} commands are still running; the session continues when they finish.`;
}
