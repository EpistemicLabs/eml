// The Inbox page's Unread fold: sessions that answered and that nobody has opened since.
// Nothing to do, so it has no colour of its own and never counts in the badge; opening a row reads it.
import { agentLetter, type AllSession } from '@/components/sidebar/allSessions';
import { sessionDisplayName } from '@/components/sidebar/utils';
import { type Board, readable, taskName, when } from '@/lib/task-board';
import { answerLine, answerTime, deskOf } from '@/lib/unread-answers';
import { cn } from '@/lib/utils';
import { Chip, FOCUS } from '@/shared/view/ui';
import type { SpaceInfo } from '@/stores/useSpaceStore';

import { Fold } from './parts';

export function UnreadFold({ sessions, board, spaces, now, open, compact, onToggle, onOpen, onMarkAllRead }: {
  sessions: AllSession[];
  board: Pick<Board, 'projects' | 'tasks'>;
  spaces: SpaceInfo[];
  now: number;
  open: boolean;
  compact: boolean;
  onToggle: () => void;
  onOpen: (session: AllSession) => void;
  onMarkAllRead: () => void;
}) {
  if (sessions.length === 0) return null;
  const tasks = new Map(board.tasks.map((t) => [t.id, t]));
  return (
    <>
      <Fold label={`Unread · ${sessions.length}`} hint="answers you haven't opened, nothing to do" name="unread answers" open={open} onToggle={onToggle} />
      {open && sessions.map((session) => {
        const space = spaces.find((s) => s.id === session.spaceId);
        const task = session.taskId ? tasks.get(session.taskId) : undefined;
        const desk = deskOf(session, board, space);
        return (
          <div key={session.id} className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 border-t border-border px-3 py-3 hover:bg-muted">
            <span role="img" aria-label="Unread" className="mt-1.5 size-2 rounded-full bg-foreground" />
            <button type="button" onClick={() => onOpen(session)} className={cn('flex min-w-0 flex-col gap-1 text-left', FOCUS)}>
              <span className="flex items-baseline gap-2.5">
                <span className="min-w-0 flex-1 text-heading font-semibold">{readable(sessionDisplayName(session))}</span>
                <time className="shrink-0 tabular-nums text-caption text-muted-foreground">{when(answerTime(session), now)}</time>
              </span>
              <span className={cn('text-body text-muted-foreground', compact ? 'line-clamp-2' : 'line-clamp-3')}>{answerLine(session)}</span>
              <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-ui text-muted-foreground">
                {space && <span title={space.agentName ?? space.name} className="inline-grid size-5 place-items-center rounded-full bg-foreground text-caption font-bold text-background">{agentLetter(space)}</span>}
                {desk && <Chip>{desk}</Chip>}
                <span className="min-w-0 truncate">{task ? `task ${taskName(task)}` : 'no task'}</span>
              </span>
            </button>
          </div>
        );
      })}
      {open && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 border-t border-border px-3 py-2 text-ui text-muted-foreground">
          <span>Clears when you open a session.</span>
          <button type="button" onClick={onMarkAllRead} className={cn('min-h-(--target-min) text-foreground underline underline-offset-2', FOCUS)}>Mark all read</button>
        </div>
      )}
    </>
  );
}
