import { sessionMark, MARK_WORD, type AllSession } from '@/components/sidebar/allSessions';
import { compactAge, sessionDisplayName } from '@/components/sidebar/utils';
import { useSessionTask } from '@/lib/session-task';
import { readable } from '@/lib/task-board';
import { cn } from '@/lib/utils';
import type { SpaceInfo } from '@/stores/useSpaceStore';
import type { TurnInfo } from '@/stores/useTurnStateStore';

/**
 * Your turn: everything the review round holds, next to the session that is
 * open, so an ask never gets lost behind the one on screen. Each row says what
 * the session waits for and the task it belongs to; a click opens that session
 * on the right. The list only reads: answers go in the session's own chat.
 */
export function YourTurnList({ items, currentId, spaces, turns, onPick }: {
  items: AllSession[];
  currentId: string | undefined;
  spaces: SpaceInfo[];
  turns: Record<string, TurnInfo | undefined>;
  onPick: (id: string) => void;
}) {
  return (
    <nav aria-label="Your turn" className="hidden w-72 flex-shrink-0 overflow-y-auto border-r border-border md:block">
      <ul className="divide-y divide-border">
        {items.map((session) => (
          <YourTurnRow
            key={session.id}
            session={session}
            space={spaces.find((space) => space.id === session.spaceId)}
            current={session.id === currentId}
            turn={turns[session.id]}
            onPick={onPick}
          />
        ))}
      </ul>
    </nav>
  );
}

function YourTurnRow({ session, space, current, turn, onPick }: {
  session: AllSession;
  space: SpaceInfo | undefined;
  current: boolean;
  turn: TurnInfo | undefined;
  onPick: (id: string) => void;
}) {
  const task = useSessionTask(session.taskId, space);
  const mark = sessionMark(session, turn);
  const why = task?.waitingOn?.why || session.attention?.reason || (mark ? MARK_WORD[mark] : null);
  const since = task?.waitingOn?.since || session.attention?.at || null;
  return (
    <li>
      <button
        type="button"
        onClick={() => onPick(session.id)}
        aria-current={current ? 'true' : undefined}
        className={cn('block w-full px-3 py-2 text-left transition-colors hover:bg-accent', current && 'bg-accent')}
      >
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{task ? readable(task.title) : sessionDisplayName(session)}</span>
          {since && <span className="flex-shrink-0 text-[11px] text-muted-foreground">{compactAge(since, new Date())}</span>}
        </span>
        {why && (
          <span className={cn('block truncate text-xs', mark === 'failed' ? 'text-destructive' : 'text-primary')} title={why}>{why}</span>
        )}
        {task && <span className="block truncate text-[11px] text-muted-foreground">{sessionDisplayName(session)}</span>}
      </button>
    </li>
  );
}
