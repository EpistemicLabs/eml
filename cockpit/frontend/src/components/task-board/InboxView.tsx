// Inbox: only what is the viewer's turn — questions and results to review.
// An item clears itself when its session is answered, the result reviewed or the task closed.
import { useState } from 'react';

import { projectNameOf } from '@/lib/open-task';
import { type Board, type BoardTask, fyi, type InboxItem, originName, readable, taskName, when } from '@/lib/task-board';
import { DAY_MS } from '@/lib/time';
import { cn } from '@/lib/utils';
import { Chip, FOCUS, LABEL, MINI } from '@/shared/view/ui';

import { FromOrigin, Who } from './parts';

export type InboxAction =
  | { kind: 'snooze'; item: InboxItem; until: 'tomorrow' | 'monday' }
  | { kind: 'review'; item: InboxItem };

const dayOf = (iso: string, now: number) => {
  const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / DAY_MS);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : new Date(iso).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
};

const KIND: Record<InboxItem['kind'], { label: string; hue: 'you' | 'review' }> = {
  question: { label: 'question', hue: 'you' },
  review: { label: 'review', hue: 'review' },
};

export function InboxView({ board, now, compact, currentTaskId, onOpen, onAction }: {
  board: Board;
  now: number;
  /** The list sits next to an open task (split): actions wrap under the text, as they do whenever the list is narrow. */
  compact: boolean;
  currentTaskId: string | null;
  onOpen: (item: InboxItem) => void;
  onAction: (action: InboxAction) => void;
}) {
  const [showFyi, setShowFyi] = useState(false);
  const [showSnoozed, setShowSnoozed] = useState(false);
  const byId = new Map(board.tasks.map((t) => [t.id, t]));
  const results = fyi(board.tasks);
  let day: string | null = null;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* A container: a row's actions sit beside its text only where the list itself is wide enough. */}
      <div className="@container flex flex-col overflow-hidden rounded-xl border border-border bg-card">
        {board.inbox.length === 0 && <div className="m-3 rounded-xl border border-dashed border-border p-3 text-ui text-muted-foreground">Inbox zero. New questions and results land here.</div>}
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
        <Fold label={`FYI · ${results.length} result${results.length === 1 ? '' : 's'}, nothing to do`} open={showFyi} onToggle={() => setShowFyi(!showFyi)} />
        {showFyi && results.map((t) => (
          <div key={t.id} className="flex items-baseline gap-2.5 border-t border-border px-3 py-2 text-ui text-muted-foreground">
            <time className="w-16 shrink-0 tabular-nums text-caption">{when(t.updatedAt, now)}</time>
            <span><b className="font-medium text-foreground">{taskName(t)}</b> · done by {t.delegate}</span>
          </div>
        ))}
        {board.snoozed.length > 0 && <Fold label={`Snoozed · ${board.snoozed.length}`} open={showSnoozed} onToggle={() => setShowSnoozed(!showSnoozed)} />}
        {showSnoozed && board.snoozed.map((item) => (
          <div key={item.key} className="flex items-baseline gap-2.5 border-t border-border px-3 py-2 text-ui text-muted-foreground">
            <time className="w-16 shrink-0 tabular-nums text-caption">{when(item.until, now)}</time>
            <span><b className="font-medium text-foreground">{readable(item.title)}</b> · back then</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Fold({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <div className={cn(LABEL, 'flex items-center justify-between border-t border-border bg-muted px-3 py-2')}>
      <span>{label}</span>
      <button type="button" onClick={onToggle} aria-expanded={open} className={cn('min-h-(--target-min) text-ui normal-case tracking-normal text-mark-ink underline underline-offset-2', FOCUS)}>
        {open ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}

function Item({ item, task, project, from, viewer, now, compact, current, onOpen, onAction }: {
  item: InboxItem; task: BoardTask | undefined; project: string; from: string | null; viewer: string; now: number; compact: boolean; current: boolean;
  onOpen: (item: InboxItem) => void; onAction: (action: InboxAction) => void;
}) {
  const kind = KIND[item.kind];
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
          {task ? <Who task={task} viewer={viewer} /> : <span>no task</span>}
          <time className="tabular-nums text-caption">{when(item.since, now)}</time>
        </span>
      </button>
      <span className={cn('col-start-2 flex flex-wrap justify-start gap-1.5', !compact && '@3xl:col-start-auto @3xl:self-center @3xl:justify-end')}>
        {item.kind === 'review' && <button type="button" className={MINI} onClick={() => onAction({ kind: 'review', item })}>Looks good</button>}
        <button type="button" className={MINI} onClick={() => onAction({ kind: 'snooze', item, until: 'tomorrow' })}>Snooze to tomorrow</button>
        <button type="button" className={MINI} onClick={() => onAction({ kind: 'snooze', item, until: 'monday' })}>Snooze to Monday</button>
      </span>
    </div>
  );
}
