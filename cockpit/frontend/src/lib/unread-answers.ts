// The Inbox page's Unread fold: sessions that answered and that nobody has opened since.
// Nothing to do, so it never counts in the Inbox badge; it clears when the session is opened.
import { sessionMark, type AllSession } from '@/components/sidebar/allSessions';
import type { SpaceInfo } from '@/stores/useSpaceStore';
import type { TurnInfo } from '@/stores/useTurnStateStore';

import { type Board, readable } from './task-board';

/** The read state a session had before Mark all read, for Undo. */
export interface ReadBefore { id: string; readAt: string | null; resultAt: string | null }

const answeredAt = (session: AllSession) => session.attention?.at ?? session.resultAt ?? session.lastActivity ?? session.createdAt ?? '';

/**
 * The sessions for the Unread fold, newest answer first: the ones the sidebar marks as an unread
 * result. Left out are archived and snoozed ones, workers (their answer goes to the session that
 * started them), and any session the Inbox already lists, by its own item or its task's.
 */
export function unreadAnswers(
  sessions: readonly AllSession[],
  board: Pick<Board, 'inbox' | 'snoozed'>,
  turns: Record<string, TurnInfo>,
  now: number,
): AllSession[] {
  // An older host or a board still loading may lack the lists.
  const listed = [...(board.inbox ?? []), ...(board.snoozed ?? [])];
  const inboxSessions = new Set(listed.map((item) => item.sessionId).filter(Boolean));
  const inboxTasks = new Set(listed.map((item) => item.taskId).filter(Boolean));
  return sessions
    .filter((session) =>
      !session.archivedAt
      && !session.worker
      && !(session.snoozedUntil && Date.parse(session.snoozedUntil) > now)
      && !inboxSessions.has(session.id)
      && !(session.taskId && inboxTasks.has(session.taskId))
      && sessionMark(session, turns[session.id]) === 'result')
    .sort((a, b) => answeredAt(b).localeCompare(answeredAt(a)) || a.id.localeCompare(b.id));
}

/** What a row says about the answer: its own first line, else the sentence the agent reported its status with. */
export function answerLine(session: AllSession): string {
  const reply = session.lastReply?.trim();
  if (reply) return reply;
  const reason = session.attention?.reason?.trim();
  return reason ? reason.split('\n')[0]! : 'Answered';
}

/** When the answer came, for the row's time. */
export const answerTime = answeredAt;

/** The read state to put back when Mark all read is undone. */
export const readBefore = (sessions: readonly AllSession[]): ReadBefore[] =>
  sessions.map((session) => ({ id: session.id, readAt: session.readAt ?? null, resultAt: session.resultAt ?? null }));

/** Whether the fold shows its rows: what the user picked on this visit, else open only when nothing needs them. */
export const unreadFoldOpen = (picked: boolean | null, inboxCount: number): boolean => picked ?? inboxCount === 0;

/** Where the session sits: its space and its project. */
export function deskOf(session: AllSession, board: Pick<Board, 'projects'>, space: Pick<SpaceInfo, 'name'> | undefined): string {
  const projectId = (session.projectId ?? session.__projectId ?? '').replace(/^bp-/, '');
  const project = projectId ? board.projects.find((p) => p.spaceId === session.spaceId && p.id === projectId)?.name ?? readable(projectId) : '';
  return [space?.name, project].filter(Boolean).join(' · ');
}
