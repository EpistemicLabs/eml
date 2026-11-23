// A session without a task, opened from the Inbox's Unread fold: it opens where Inbox items open
// (beside the list, full screen on a phone), never on its desk (Lasse 2026-11-23). There is no task
// to show, so it is the session's name, where it sits and its chat.
import MainContentTabSwitcher from '@/components/main-content/view/subcomponents/MainContentTabSwitcher';
import type { AllSession } from '@/components/sidebar/allSessions';
import { sessionDisplayName } from '@/components/sidebar/utils';
import { SessionChat } from '@/components/ui/session-chat';
import { type Board, readable } from '@/lib/task-board';
import { deskOf } from '@/lib/unread-answers';
import { cn } from '@/lib/utils';
import { Chip, FOCUS } from '@/shared/view/ui';
import { paneSpaceKey, type SpaceInfo } from '@/stores/useSpaceStore';

import { CHAT_ID, TASK_BOARD_PANE_ID, TASK_TITLE_ID, useSeenWhileShown } from './TaskPanel';

export function SessionPanel({ session, board, spaces, onClose }: {
  /** Undefined when the session left the list (archived, deleted) while it was open. */
  session: AllSession | undefined;
  board: Pick<Board, 'projects'>;
  spaces: SpaceInfo[];
  onClose: () => void;
}) {
  useSeenWhileShown(session?.id ?? null);
  const space = session ? spaces.find((s) => s.id === session.spaceId) : undefined;
  const desk = session ? deskOf(session, board, space) : '';
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex shrink-0 flex-col gap-1.5 border-b border-border px-4 py-3">
        <h2 id={TASK_TITLE_ID} tabIndex={-1} data-autofocus className={cn('m-0 line-clamp-2 text-display font-semibold tracking-title text-balance', FOCUS)}>
          {session ? readable(sessionDisplayName(session)) : 'Session'}
        </h2>
        {session && (
          <span className="flex flex-wrap items-center gap-2 text-ui text-muted-foreground">
            {desk && <Chip>{desk}</Chip>}
            {/* A session whose task is closed is off the board too; it opens here, but it has a task. */}
            {!session.taskId && <span>no task</span>}
          </span>
        )}
      </header>
      <section aria-label="Session" id={CHAT_ID} className="flex min-h-(--size-split-panel-min) min-w-0 flex-1 flex-col">
        {session ? (
          <SessionChat key={session.id} paneId={TASK_BOARD_PANE_ID} projectId={session.__projectId ?? null} sessionId={session.id} session={session} spaceId={space ? paneSpaceKey(space) : null} borrowed toolbar={{ onClosePane: onClose }} />
        ) : (
          <>
            <div className="flex shrink-0 justify-end px-2 py-1.5">
              <MainContentTabSwitcher groups={[]} paneView="chat" onSetPaneView={() => {}} onClosePane={onClose} />
            </div>
            <p className="m-auto px-5 py-10 text-center text-body text-muted-foreground">This session is no longer in the list.</p>
          </>
        )}
      </section>
    </div>
  );
}
