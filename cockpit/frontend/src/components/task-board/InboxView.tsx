// Inbox: only what is the viewer's turn — questions, results to review, steps that are theirs to take
// ("Your move") and agents that stopped. An item clears itself when its session is answered, the result
// reviewed, the step marked done or the task closed. Under an item, the task's wake-up: the owner's move
// and the agent's check-back stand side by side.
import { Clock } from 'lucide-react';

import type { AllSession } from '@/components/sidebar/allSessions';
import { projectNameOf } from '@/lib/open-task';
import { askDueLabel, type Board, type BoardTask, checkBackText, fyi, hasOpenSteps, type InboxItem, looksGoodLabel, originName, repeats, readable, taskName, when } from '@/lib/task-board';
import { dayNumber, formatInZone, userTimeZone } from '@/lib/time-zone';
import { cn } from '@/lib/utils';
import { Chip, FOCUS, LABEL, MINI } from '@/shared/view/ui';
import type { SpaceInfo } from '@/stores/useSpaceStore';
import { setFold, useTaskBoardPage } from '@/stores/useTaskBoardPageStore';

import { Fold, FromOrigin, Who } from './parts';
import { UnreadFold } from './UnreadFold';

/** The Unread fold's sessions and what the page does with them. */
export interface UnreadProps {
  sessions: AllSession[];
  spaces: SpaceInfo[];
  open: boolean;
  onToggle: () => void;
  onOpen: (session: AllSession) => void;
  onMarkAllRead: () => void;
}

export type InboxAction =
  /** Park the item's wait (on every device): until tomorrow or Monday 09:00, open-ended, or bring it back now. */
  | { kind: 'snooze'; item: InboxItem; until: 'tomorrow' | 'monday' | 'open' | 'now' }
  | { kind: 'review'; item: InboxItem }
  /** The viewer did the step a do item asks for: acts at once, the task's agent is woken. */
  | { kind: 'done'; item: InboxItem }
  /** The viewer saw a review or a question: the ask goes, the task stays open, nobody is woken. Acts at once. */
  | { kind: 'got_it'; item: InboxItem };

/** The day heading an item goes under: Today, Yesterday, else the date, on the user's calendar. */
export const dayOf = (iso: string, now: number) => {
  const zone = userTimeZone();
  const days = dayNumber(now, zone) - dayNumber(Date.parse(iso), zone);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : formatInZone(iso, { weekday: 'long', day: 'numeric', month: 'short' }, zone);
};

const KIND: Record<InboxItem['kind'], { label: string; hue: 'you' | 'review' | 'stopped' }> = {
  question: { label: 'question', hue: 'you' },
  do: { label: 'Your move', hue: 'you' },
  review: { label: 'review', hue: 'review' },
  stopped: { label: 'stopped', hue: 'stopped' },
  stalled: { label: 'step stalled', hue: 'stopped' },
};
/** A kind this build does not know (a newer host) reads as a question: it is the viewer's turn either way. */
const kindOf = (item: InboxItem) => KIND[item.kind] ?? KIND.question;

export function InboxView({ board, now, compact, currentTaskId, unread, onOpen, onAction }: {
  board: Board;
  now: number;
  /** The list sits next to an open task (split): actions wrap under the text, as they do whenever the list is narrow. */
  compact: boolean;
  currentTaskId: string | null;
  unread: UnreadProps;
  onOpen: (item: InboxItem) => void;
  onAction: (action: InboxAction) => void;
}) {
  // Kept outside the page: leaving for a desk and coming back finds the folds as they were.
  const { fyi: showFyi, snoozed: showSnoozed } = useTaskBoardPage().folds;
  const byId = new Map(board.tasks.map((t) => [t.id, t]));
  const results = fyi(board.tasks);
  let day: string | null = null;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* A container: a row's actions sit beside its text only where the list itself is wide enough. */}
      <div className="@container flex flex-col overflow-hidden rounded-xl border border-border bg-card">
        {board.inbox.length === 0 && (
          <div className="m-3 rounded-xl border border-dashed border-border p-3 text-ui text-muted-foreground">
            <b className="block text-heading font-semibold text-foreground">Nothing needs you</b>
            {unread.sessions.length > 0
              ? `${unread.sessions.length} session${unread.sessions.length === 1 ? '' : 's'} answered since you last looked.`
              : 'New questions and results land here.'}
          </div>
        )}
        {board.inbox.map((item) => {
          const head = dayOf(item.since, now);
          const showHead = head !== day;
          day = head;
          const task = item.taskId ? byId.get(item.taskId) : undefined;
          return (
            <div key={item.key}>
              {showHead && <div className={cn(LABEL, 'bg-muted px-3 py-2')}>{head}</div>}
              <Item item={item} task={task} project={task ? projectNameOf(board, task) : ''} from={task ? originName(task, board) : null} viewer={board.viewer} now={now} compact={compact} current={!!item.taskId && item.taskId === currentTaskId} onOpen={onOpen} onAction={onAction} />
            </div>
          );
        })}
        <Fold label={`FYI · ${results.length} result${results.length === 1 ? '' : 's'}, nothing to do`} open={showFyi} onToggle={() => setFold('fyi', !showFyi)} />
        {showFyi && results.map((t) => (
          <div key={t.id} className="flex items-baseline gap-2.5 border-t border-border px-3 py-2 text-ui text-muted-foreground">
            <time className="w-16 shrink-0 tabular-nums text-caption">{when(t.updatedAt, now)}</time>
            <span><b className="font-medium text-foreground">{taskName(t)}</b> · done by {t.delegate}</span>
          </div>
        ))}
        {board.snoozed.length > 0 && <Fold label={`Parked · ${board.snoozed.length}`} open={showSnoozed} onToggle={() => setFold('snoozed', !showSnoozed)} />}
        {showSnoozed && board.snoozed.map((item) => (
          <div key={item.key} className="flex flex-wrap items-baseline gap-2.5 border-t border-border px-3 py-2 text-ui text-muted-foreground">
            <span className="w-24 shrink-0 tabular-nums text-caption">{item.until === 'open' ? 'no date' : `back ${when(item.until, now)}`}</span>
            <b className="min-w-0 flex-1 font-medium text-foreground">{readable(item.title)}</b>
            <button type="button" className={MINI} onClick={() => onAction({ kind: 'snooze', item, until: 'now' })}>Bring back now</button>
          </div>
        ))}
        <UnreadFold sessions={unread.sessions} board={board} spaces={unread.spaces} now={now} open={unread.open} compact={compact} onToggle={unread.onToggle} onOpen={unread.onOpen} onMarkAllRead={unread.onMarkAllRead} />
      </div>
    </div>
  );
}

function Item({ item, task, project, from, viewer, now, compact, current, onOpen, onAction }: {
  item: InboxItem; task: BoardTask | undefined; project: string; from: string | null; viewer: string; now: number; compact: boolean; current: boolean;
  onOpen: (item: InboxItem) => void; onAction: (action: InboxAction) => void;
}) {
  const kind = kindOf(item);
  const due = item.due ? askDueLabel(item.due, now) : null;
  return (
    // Actions wrap under the text when the list sits next to an open task or is narrow (a phone, a small window).
    <div className={cn('grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1 border-t border-border px-3 py-3 hover:bg-muted', !compact && '@3xl:grid-cols-[auto_minmax(0,1fr)_auto]', current && 'border-l-2 border-l-mark bg-mark/10')}>
      <span aria-hidden className="mt-1.5 size-2 rounded-full bg-mark" />
      <button type="button" onClick={() => onOpen(item)} className={cn('flex min-w-0 flex-col gap-1 text-left', FOCUS)}>
        <span className="text-heading font-semibold">{readable(item.title)}</span>
        <span className={cn('text-body text-muted-foreground', compact && 'line-clamp-2')}>{item.text}</span>
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-ui text-muted-foreground">
          <Chip hue={kind.hue}>{kind.label}</Chip>
          {project && <Chip>{project}</Chip>}
          {from && <FromOrigin name={from} />}
          {due && <Chip hue={due.overdue ? 'stopped' : 'mark'}>{due.text}</Chip>}
          {task ? <Who task={task} viewer={viewer} /> : <span>no task</span>}
          <time className="tabular-nums text-caption">{when(item.since, now)}</time>
        </span>
        {item.checkBack && (
          <span className="flex items-center gap-1.5 text-caption text-muted-foreground">
            <Clock aria-hidden className="size-3.5 shrink-0" />
            <span className="tabular-nums">{checkBackText(item.checkBack, viewer, now)}</span>
          </span>
        )}
      </button>
      <span className={cn('col-start-2 flex flex-wrap justify-start gap-1.5', !compact && '@3xl:col-start-auto @3xl:self-center @3xl:justify-end')}>
        {item.kind === 'do' && item.waitId && <button type="button" className={MINI} title="You did it: the agent is told and goes on." onClick={() => onAction({ kind: 'done', item })}>Done</button>}
        {item.kind === 'do' && <button type="button" className={MINI} onClick={() => onOpen(item)}>Open chat</button>}
        {item.kind === 'review' && !hasOpenSteps(task) && <button type="button" className={MINI} title={reviewTitle(item, task)} onClick={() => onAction({ kind: 'review', item })}>{looksGoodLabel(item, viewer)}</button>}
        {(item.kind === 'review' || item.kind === 'question') && item.waitId && <button type="button" className={MINI} title="You saw it: the ask goes, the task stays open." onClick={() => onAction({ kind: 'got_it', item })}>Got it</button>}
        {/* A stalled step is derived from the step itself: it clears once the step moves, so there is nothing to park. */}
        {item.kind === 'stalled' ? <button type="button" className={MINI} onClick={() => onOpen(item)}>Open step</button> : <>
          <button type="button" className={MINI} onClick={() => onAction({ kind: 'snooze', item, until: 'tomorrow' })}>Park until tomorrow</button>
          <button type="button" className={MINI} onClick={() => onAction({ kind: 'snooze', item, until: 'monday' })}>Park until Monday</button>
          <button type="button" className={MINI} onClick={() => onAction({ kind: 'snooze', item, until: 'open' })}>Park, no date</button>
        </>}
      </span>
    </div>
  );
}

/** What Looks good does, as its tooltip: approve one run of a routine, else close the task. */
function reviewTitle(item: InboxItem, task: BoardTask | undefined): string | undefined {
  // An older host does not say whether the task repeats: its schedule on the board does.
  const routine = item.repeating || (!item.checkBack && task !== undefined && repeats(task));
  return routine ? 'Approves this run. The task stays open until its schedule ends.' : undefined;
}
